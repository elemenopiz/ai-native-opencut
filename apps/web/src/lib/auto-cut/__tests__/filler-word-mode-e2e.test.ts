/**
 * END-TO-END proof that WORD MODE filler detection is actually reachable on a
 * realistic talking-head clip — the thing `filler-detect.ts` was written for
 * and could not do until word timings were persisted.
 *
 * WHAT THIS COVERS: the real `fromTranscriptionResult` (storage adapter) and
 * the real `detectFillers` (detector), driven by a fixture shaped like an
 * actual MAI-Transcribe-2 response as `/api/transcribe` returns it —
 * millisecond-granular offsets, contiguous words within a phrase, natural
 * inter-word gaps.
 *
 * WHAT THIS DOES NOT COVER: the network leg to the provider. There is no
 * Azure key in this environment, so the provider's own alignment quality is
 * asserted nowhere here — only that genuine word timings, once stored, make
 * `undetectableFillerCount` collapse and put cuts on real word boundaries.
 */

import { describe, expect, it } from "bun:test";
import {
	fromTranscriptionResult,
	supportsFillerRemoval,
} from "@/lib/search/asset-transcript";
import type { TranscriptionSegment } from "@/types/ai";
import { detectFillers } from "../filler-detect";

/** Azure reports integer milliseconds; the route divides by 1000. Go through
 *  the same arithmetic so the fixture carries real float dust, not round
 *  decimals that would flatter the boundary assertions. */
const ms = (v: number) => v / 1000;

/**
 * Build one phrase the way the provider does: words laid end to end from
 * `startMs` with a small gap between them, and the phrase span covering them.
 * `[text, durationMs, gapAfterMs]`.
 */
function phrase(
	id: number,
	startMs: number,
	spec: Array<[string, number, number?]>,
): TranscriptionSegment {
	const words = [];
	let cursor = startMs;
	for (const [text, durMs, gapMs = 40] of spec) {
		words.push({
			word: text,
			start: ms(cursor),
			end: ms(cursor + durMs),
			confidence: 0.94,
		});
		cursor += durMs + gapMs;
	}
	const lastGap = spec[spec.length - 1][2] ?? 40;
	return {
		id,
		text: spec.map(([t]) => t).join(" "),
		start: ms(startMs),
		end: ms(cursor - lastGap),
		words,
	};
}

/**
 * ~24s of verbatim talking head. Fillers appear where they really do: leading
 * a sentence, wedged mid-clause, and doubled up ("you know, um"). Only ONE of
 * these — phrase 4 — is a filler-only phrase, i.e. the single case the old
 * SEGMENT MODE could already cut. Every other filler here was previously
 * counted as undetectable and left on the timeline.
 */
const TALKING_HEAD: TranscriptionSegment[] = [
	phrase(0, 320, [
		["So", 280],
		["um", 240],
		["the", 160],
		["thing", 380],
		["about", 300],
		["editing", 520],
		["is", 220],
	]),
	phrase(1, 3200, [
		["it", 180],
		["takes", 340],
		["uh", 260],
		["way", 280],
		["longer", 460],
		["than", 260],
		["you", 200],
		["think", 400],
	]),
	phrase(2, 6400, [
		["and", 240],
		["you", 190],
		["know", 300],
		["most", 320],
		["of", 150],
		["that", 260],
		["time", 380],
		["is", 200],
		["just", 300],
		["watching", 480],
	]),
	phrase(3, 10200, [
		["um", 250],
		["waiting", 480],
		["for", 220],
		["the", 160],
		["render", 520],
	]),
	// A filler-only phrase — the one thing SEGMENT MODE already handled.
	phrase(4, 13100, [["Um", 300]]),
	phrase(5, 14000, [
		["so", 260],
		["what", 280],
		["I", 150],
		["do", 240],
		["is", 200],
		["uh", 230],
		["cut", 300],
		["first", 420],
		["and", 230],
		["you", 180],
		["know", 290],
		["fix", 320],
		["it", 170],
		["later", 450],
	]),
	phrase(6, 20200, [
		["that's", 380],
		["basically", 620],
		["the", 160],
		["whole", 360],
		["trick", 480],
	]),
];

const RESULT = {
	segments: TALKING_HEAD,
	language: "en-US",
	duration: 24.5,
	engine: "mai-transcribe-2",
	style: "verbatim" as const,
};

/** Every filler occurrence hand-counted from the fixture above. */
const EXPECTED_FILLERS = [
	"um", // p0 mid-sentence
	"uh", // p1 mid-sentence
	"you know", // p2 leading
	"um", // p3 leading
	"Um", // p4 filler-only phrase
	"uh", // p5 mid-sentence
	"you know", // p5 mid-sentence
];

describe("WORD MODE end-to-end on a realistic talking-head transcript", () => {
	const stored = fromTranscriptionResult("clip-1", RESULT, 0);

	it("the stored record is usable for filler removal (words + verbatim)", () => {
		expect(supportsFillerRemoval(stored)).toBe(true);
	});

	it("undetectableFillerCount drops to ZERO — the whole point of the counter", () => {
		const { ranges, undetectableFillerCount } = detectFillers(stored.segments);

		expect(undetectableFillerCount).toBe(0);
		expect(ranges.map((r) => r.label)).toEqual(EXPECTED_FILLERS);
		expect(ranges.every((r) => r.confidence === "high")).toBe(true);
	});

	it("BEFORE the fix, the same transcript stranded 6 of 7 fillers", () => {
		// Reproduces the old storage contract by stripping `words`, which is
		// exactly what the previous `fromTranscriptionResult` did.
		const wordless = stored.segments.map(({ start, end, text }) => ({
			start,
			end,
			text,
		}));
		const { ranges, undetectableFillerCount } = detectFillers(wordless);

		// Only the filler-ONLY phrase was cuttable.
		expect(ranges.map((r) => r.label)).toEqual(["Um"]);
		expect(undetectableFillerCount).toBe(6);
		expect(ranges.length + undetectableFillerCount).toBe(
			EXPECTED_FILLERS.length,
		);
	});
});

describe("pre-pad / post-pad clamping at REAL word boundaries", () => {
	const stored = fromTranscriptionResult("clip-1", RESULT, 0);
	const { ranges } = detectFillers(stored.segments);

	/** Flatten the fixture's words with their owning segment span. */
	const allWords = stored.segments.flatMap((s) =>
		(s.words ?? []).map((w) => ({ ...w, segStart: s.start, segEnd: s.end })),
	);

	it("never overlaps a non-filler word's audio", () => {
		const fillerTokens = new Set(["um", "uh", "you", "know"]);
		const keptWords = allWords.filter(
			(w) => !fillerTokens.has(w.word.toLowerCase()),
		);

		for (const range of ranges) {
			for (const w of keptWords) {
				const overlap =
					Math.min(range.end, w.end) - Math.max(range.start, w.start);
				expect(overlap).toBeLessThanOrEqual(0);
			}
		}
	});

	it("always covers the whole filler word it claims to cut", () => {
		for (const range of ranges) {
			const covered = allWords.filter(
				(w) => w.start >= range.start && w.end <= range.end,
			);
			expect(covered.length).toBeGreaterThan(0);
			expect(covered.map((w) => w.word).join(" ")).toBe(range.label);
		}
	});

	it("takes the full 80ms pad only where the gap allows, and clamps otherwise", () => {
		// The fixture's inter-word gaps are 40ms — HALF the 80ms default pad —
		// so every interior cut must clamp to the neighbour edge rather than
		// run the requested pad. This is the case that would silently eat
		// speech if clamping regressed.
		const pad = 0.08;
		for (const range of ranges) {
			const before = allWords.filter((w) => w.end <= range.start + 1e-9);
			const after = allWords.filter((w) => w.start >= range.end - 1e-9);
			const prevEnd = before.length
				? Math.max(...before.map((w) => w.end))
				: null;
			const nextStart = after.length
				? Math.min(...after.map((w) => w.start))
				: null;

			if (prevEnd !== null) expect(range.start).toBeGreaterThanOrEqual(prevEnd);
			if (nextStart !== null) expect(range.end).toBeLessThanOrEqual(nextStart);

			const covered = allWords.filter(
				(w) => w.start >= range.start && w.end <= range.end,
			);
			const wordStart = Math.min(...covered.map((w) => w.start));
			const wordEnd = Math.max(...covered.map((w) => w.end));
			// Padding only ever ADDS to the word span, never subtracts.
			expect(range.start).toBeLessThanOrEqual(wordStart + 1e-9);
			expect(range.end).toBeGreaterThanOrEqual(wordEnd - 1e-9);
			expect(wordStart - range.start).toBeLessThanOrEqual(pad + 1e-9);
			expect(range.end - wordEnd).toBeLessThanOrEqual(pad + 1e-9);
		}
	});

	it("survives non-monotonic provider timings without shrinking the cut", () => {
		// A word whose end overruns the next word's start. Taking that value as
		// the pad floor literally would clamp INSIDE the "um" and leave part of
		// it audible.
		const { ranges: r } = detectFillers([
			{
				start: 0,
				end: 2,
				text: "so um yes",
				words: [
					{ word: "so", start: 0, end: 0.62 }, // overruns "um"
					{ word: "um", start: 0.6, end: 0.85 },
					{ word: "yes", start: 0.83, end: 1.4 }, // starts before "um" ends
				],
			},
		]);
		expect(r).toHaveLength(1);
		expect(r[0].start).toBeLessThanOrEqual(0.6);
		expect(r[0].end).toBeGreaterThanOrEqual(0.85);
	});
});

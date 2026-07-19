import { describe, expect, it } from "bun:test";
import {
	DEFAULT_FILLER_WORDS,
	type DetectableSegment,
	detectFalseStarts,
	detectFillers,
	OPTIONAL_FILLER_WORDS,
	resolveFillerOptions,
} from "../filler-detect";

describe("resolveFillerOptions", () => {
	it("explicit undefined values do not clobber defaults (BUG31 idiom)", () => {
		const resolved = resolveFillerOptions({
			prePad: undefined,
			wordList: undefined,
			falseStartWindowSec: 5,
		});
		expect(resolved.prePad).toBe(0.08);
		expect(resolved.postPad).toBe(0.08);
		expect(resolved.wordList).toEqual([...DEFAULT_FILLER_WORDS]);
		expect(resolved.falseStartWindowSec).toBe(5);
	});

	it('"like" is off by default and not in DEFAULT_FILLER_WORDS', () => {
		expect(DEFAULT_FILLER_WORDS).not.toContain("like");
		expect(OPTIONAL_FILLER_WORDS).toContain("like");
	});

	it("mutating the resolved wordList does not leak into later calls", () => {
		const first = resolveFillerOptions(undefined);
		first.wordList.push("mutated");
		const second = resolveFillerOptions(undefined);
		expect(second.wordList).toEqual([...DEFAULT_FILLER_WORDS]);
	});
});

describe("detectFillers — WORD MODE (per-word timing present)", () => {
	it("cuts a single filler word with padding, never crossing a neighbor word", () => {
		// "I  um  went" — generous 200ms gaps around "um" so the default 80ms
		// pad fits comfortably without clamping.
		const segments: DetectableSegment[] = [
			{
				start: 0,
				end: 1.2,
				text: "I um went",
				words: [
					{ word: "I", start: 0, end: 0.2 },
					{ word: "um", start: 0.4, end: 0.6 },
					{ word: "went", start: 0.8, end: 1.0 },
				],
			},
		];
		const { ranges, undetectableFillerCount } = detectFillers(segments);
		expect(undetectableFillerCount).toBe(0);
		expect(ranges).toHaveLength(1);
		const r = ranges[0];
		expect(r.source).toBe("filler");
		expect(r.confidence).toBe("high");
		expect(r.label).toBe("um");
		// Requested pad is 0.08s each side; neighbor words end/start at
		// 0.2 and 0.8, plenty of room, so pad applies un-clamped.
		expect(r.start).toBeGreaterThanOrEqual(0.2);
		expect(r.end).toBeLessThanOrEqual(0.8);
		expect(r.start).toBeCloseTo(0.4 - 0.08, 5);
		expect(r.end).toBeCloseTo(0.6 + 0.08, 5);
	});

	it("clamps padding at the exact neighbor boundary when words are packed tighter than the pad", () => {
		// Words back-to-back with zero gap; 80ms default pad must clamp to 0.
		const segments: DetectableSegment[] = [
			{
				start: 0,
				end: 1,
				text: "so uh yes",
				words: [
					{ word: "so", start: 0, end: 0.1 },
					{ word: "uh", start: 0.1, end: 0.15 },
					{ word: "yes", start: 0.15, end: 0.4 },
				],
			},
		];
		const { ranges } = detectFillers(segments);
		expect(ranges).toHaveLength(1);
		expect(ranges[0].start).toBe(0.1);
		expect(ranges[0].end).toBe(0.15);
	});

	it("matches a multi-word phrase ('you know') as one cut, greedy over single-word fillers", () => {
		const segments: DetectableSegment[] = [
			{
				start: 0,
				end: 2,
				text: "you know that works",
				words: [
					{ word: "you", start: 0, end: 0.2 },
					{ word: "know", start: 0.3, end: 0.5 },
					{ word: "that", start: 0.6, end: 0.8 },
					{ word: "works", start: 0.9, end: 1.1 },
				],
			},
		];
		const { ranges } = detectFillers(segments);
		expect(ranges).toHaveLength(1);
		expect(ranges[0].label).toBe("you know");
	});

	it("'like' is not matched unless explicitly opted in via wordList", () => {
		const segments: DetectableSegment[] = [
			{
				start: 0,
				end: 1,
				text: "I like turtles",
				words: [
					{ word: "I", start: 0, end: 0.1 },
					{ word: "like", start: 0.2, end: 0.4 },
					{ word: "turtles", start: 0.5, end: 0.9 },
				],
			},
		];
		expect(detectFillers(segments).ranges).toHaveLength(0);
		const optedIn = detectFillers(segments, {
			wordList: [...DEFAULT_FILLER_WORDS, ...OPTIONAL_FILLER_WORDS],
		});
		expect(optedIn.ranges).toHaveLength(1);
		expect(optedIn.ranges[0].label).toBe("like");
	});
});

describe("detectFillers — SEGMENT MODE degradation (no word timing)", () => {
	it("cuts a segment that is ENTIRELY filler text", () => {
		const segments: DetectableSegment[] = [
			{ start: 0, end: 3, text: "Hello there." },
			{ start: 3, end: 4, text: "Um, uh." },
			{ start: 4, end: 7, text: "So the plan is simple." },
		];
		const { ranges, undetectableFillerCount } = detectFillers(segments);
		expect(undetectableFillerCount).toBe(0);
		expect(ranges).toHaveLength(1);
		expect(ranges[0].start).toBeCloseTo(3, 5); // clamped to prev segment end
		expect(ranges[0].end).toBeCloseTo(4, 5); // clamped to next segment start
		expect(ranges[0].confidence).toBe("high");
	});

	it("does NOT cut a filler word embedded inside a longer sentence — reports it as undetectable instead", () => {
		const segments: DetectableSegment[] = [
			{ start: 0, end: 4, text: "So, um, I think we should go." },
		];
		const { ranges, undetectableFillerCount } = detectFillers(segments);
		expect(ranges).toHaveLength(0);
		expect(undetectableFillerCount).toBe(1);
	});

	it("counts multiple embedded filler occurrences in one uncuttable segment", () => {
		const segments: DetectableSegment[] = [
			{ start: 0, end: 4, text: "So um I think uh we should go." },
		];
		const { ranges, undetectableFillerCount } = detectFillers(segments);
		expect(ranges).toHaveLength(0);
		expect(undetectableFillerCount).toBe(2);
	});

	it("segment-mode padding clamps against neighboring segment boundaries, not into their text", () => {
		const segments: DetectableSegment[] = [
			{ start: 0, end: 1, text: "Okay." },
			// Filler segment starts only 20ms after previous ends — pad must clamp.
			{ start: 1.02, end: 1.5, text: "um" },
			{ start: 1.53, end: 3, text: "Ready." },
		];
		const { ranges } = detectFillers(segments, { prePad: 0.5, postPad: 0.5 });
		expect(ranges).toHaveLength(1);
		expect(ranges[0].start).toBeGreaterThanOrEqual(1); // never crosses prev segment end
		expect(ranges[0].end).toBeLessThanOrEqual(1.53); // never crosses next segment start
	});

	it("empty segment list / no speech is a no-op", () => {
		expect(detectFillers([])).toEqual({
			ranges: [],
			undetectableFillerCount: 0,
		});
	});
});

describe("detectFalseStarts", () => {
	it("flags a restarted-verbatim segment as a low-confidence cut", () => {
		const segments: DetectableSegment[] = [
			{ start: 0, end: 1.5, text: "I want to" },
			{ start: 1.7, end: 4, text: "I want to go home now" },
		];
		const ranges = detectFalseStarts(segments);
		expect(ranges).toHaveLength(1);
		expect(ranges[0].source).toBe("false-start");
		expect(ranges[0].confidence).toBe("low");
		expect(ranges[0].start).toBeCloseTo(0, 5);
	});

	it("does not flag when the gap exceeds falseStartWindowSec", () => {
		const segments: DetectableSegment[] = [
			{ start: 0, end: 1.5, text: "I want to" },
			{ start: 5, end: 8, text: "I want to go home now" },
		];
		expect(detectFalseStarts(segments)).toHaveLength(0);
		expect(
			detectFalseStarts(segments, { falseStartWindowSec: 10 }),
		).toHaveLength(1);
	});

	it("does not flag unrelated consecutive segments", () => {
		const segments: DetectableSegment[] = [
			{ start: 0, end: 1.5, text: "The weather is nice" },
			{ start: 1.6, end: 4, text: "I want to go home now" },
		];
		expect(detectFalseStarts(segments)).toHaveLength(0);
	});

	it("does not flag a single-word attempt (avoids 1-word false positives)", () => {
		const segments: DetectableSegment[] = [
			{ start: 0, end: 0.5, text: "So" },
			{ start: 0.6, end: 2, text: "So anyway, let's go" },
		];
		expect(detectFalseStarts(segments)).toHaveLength(0);
	});

	it("is disabled entirely via detectFalseStarts: false", () => {
		const segments: DetectableSegment[] = [
			{ start: 0, end: 1.5, text: "I want to" },
			{ start: 1.7, end: 4, text: "I want to go home now" },
		];
		expect(
			detectFalseStarts(segments, { detectFalseStarts: false }),
		).toHaveLength(0);
	});
});

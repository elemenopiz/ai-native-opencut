/**
 * The `readMix` verb — `mix-read.ts` (pure, already unit-tested in
 * `mix-read.test.ts`) wired into `director-api.ts` as an agent-reachable read.
 *
 * Two halves, tested separately because they fail for different reasons:
 *  1. `mixElementInto` — the PLACEMENT math (trim window, playback rate,
 *     reverse, track/element gain, volume keyframes). Module-scope and pure,
 *     so it takes synthetic PCM and a plain object; no editor, no browser.
 *  2. The verb itself — gathering speech/music off a real (fake) timeline,
 *     reducing the analysis to `MixReadData`, and the coaching failures. The
 *     real mixdown decodes audio in the browser, so these inject a
 *     `mixAudio.decode` stub — same injectable-seam pattern as
 *     `director-watch-back.test.ts`'s `watchBack.render`.
 *
 * NOT covered here: `decodeTimelineMixdown`'s own `decodeToMono16k` calls
 * (browser `AudioContext`). The track/element WALK around them is covered — a
 * fake editor's `getAssetById` returns undefined, so every element is skipped
 * without a decode ever being attempted.
 */
import { describe, expect, it } from "bun:test";
import {
	createDirectorApi,
	mixElementInto,
	type DecodedTimelineMix,
} from "./director-api";
import { makeFakeEditor } from "./fake-editor";
import { scopeForTool, toolCatalog } from "./tool-catalog";
import type { MixReadData } from "./types";

const SAMPLE_RATE = 8000; // matches mix-read.test.ts — small, exact, easy to reason about

/** The fields every AUDIO element needs beyond {type, sourceType, mediaId, name}. */
const audioBase = { trimStart: 0, trimEnd: 0 };

/** A mono PCM buffer of `durationSec`, silent except for the given windows. */
function pcm(
	durationSec: number,
	windows: { fromSec: number; toSec: number; amplitude: number }[],
): Float32Array {
	const samples = new Float32Array(Math.round(durationSec * SAMPLE_RATE));
	for (const w of windows) {
		const from = Math.round(w.fromSec * SAMPLE_RATE);
		const to = Math.min(samples.length, Math.round(w.toSec * SAMPLE_RATE));
		for (let i = from; i < to; i++) samples[i] = w.amplitude;
	}
	return samples;
}

/** A `mixAudio.decode` stub returning the given buffer as the whole mix. */
function fixedMix(
	samples: Float32Array,
	over: Partial<DecodedTimelineMix> = {},
): () => Promise<DecodedTimelineMix> {
	return async () => ({
		samples,
		sampleRate: SAMPLE_RATE,
		sourcesMixed: 1,
		sourcesSkipped: 0,
		...over,
	});
}

function addAudio(
	fake: ReturnType<typeof makeFakeEditor>,
	name: string,
	startTime: number,
	duration: number,
) {
	fake.editor.timeline.insertElement({
		element: {
			type: "audio",
			sourceType: "upload",
			mediaId: `media_${name.replace(/\s+/g, "_")}`,
			name,
			volume: 1,
			startTime,
			duration,
			...audioBase,
		},
		placement: { mode: "auto", trackType: "audio" },
	});
}

// ── mixElementInto (pure placement math) ─────────────────────────────────────

describe("mixElementInto", () => {
	/** A 1-second ramp 0,1,2,… so a sample's VALUE identifies its source index. */
	const ramp = (length: number) => Float32Array.from({ length }, (_, i) => i);

	it("writes the trimmed source span at the element's timeline start", () => {
		const mix = new Float32Array(4 * SAMPLE_RATE);
		mixElementInto({
			mix,
			source: ramp(4 * SAMPLE_RATE),
			element: { startTime: 1, duration: 1, trimStart: 2 },
			sampleRate: SAMPLE_RATE,
			trackGain: 1,
		});
		// Nothing before the element; its first sample is source index 2s.
		expect(mix[SAMPLE_RATE - 1]).toBe(0);
		expect(mix[SAMPLE_RATE]).toBe(2 * SAMPLE_RATE);
		// …and nothing after its 1s span.
		expect(mix[2 * SAMPLE_RATE]).toBe(0);
	});

	it("honors playbackRate by stepping through the source faster", () => {
		const mix = new Float32Array(SAMPLE_RATE);
		mixElementInto({
			mix,
			source: ramp(4 * SAMPLE_RATE),
			element: { startTime: 0, duration: 1, trimStart: 0, playbackRate: 2 },
			sampleRate: SAMPLE_RATE,
			trackGain: 1,
		});
		// One second of timeline consumed two seconds of source.
		expect(mix[0]).toBe(0);
		expect(mix[100]).toBe(200);
		expect(mix[SAMPLE_RATE - 1]).toBeCloseTo(2 * SAMPLE_RATE - 2, 0);
	});

	it("honors reversed by stepping backwards through the trimmed span", () => {
		const mix = new Float32Array(SAMPLE_RATE);
		mixElementInto({
			mix,
			source: ramp(2 * SAMPLE_RATE),
			element: { startTime: 0, duration: 1, trimStart: 0, reversed: true },
			sampleRate: SAMPLE_RATE,
			trackGain: 1,
		});
		expect(mix[0]).toBe(SAMPLE_RATE - 1);
		expect(mix[SAMPLE_RATE - 1]).toBe(0);
	});

	it("multiplies track gain by the element's static volume", () => {
		const mix = new Float32Array(SAMPLE_RATE);
		mixElementInto({
			mix,
			source: new Float32Array(SAMPLE_RATE).fill(1),
			element: { startTime: 0, duration: 1, trimStart: 0, volume: 0.5 },
			sampleRate: SAMPLE_RATE,
			trackGain: 0.5,
		});
		expect(mix[0]).toBeCloseTo(0.25, 6);
	});

	it("follows a volume ENVELOPE so a duck is visible to a re-read", () => {
		// The keyframe shape duckMusicUnderSpeech writes: element-start-relative
		// times, a hold down to a ducked gain and back up.
		const mix = new Float32Array(2 * SAMPLE_RATE);
		mixElementInto({
			mix,
			source: new Float32Array(2 * SAMPLE_RATE).fill(1),
			element: {
				startTime: 0,
				duration: 2,
				trimStart: 0,
				volume: 1,
				animations: {
					channels: {
						volume: {
							valueKind: "number",
							keyframes: [
								{ id: "k1", time: 0, value: 1, interpolation: "hold" },
								{ id: "k2", time: 0.5, value: 0.25, interpolation: "hold" },
								{ id: "k3", time: 1.5, value: 1, interpolation: "hold" },
							],
						},
					},
				},
			},
			sampleRate: SAMPLE_RATE,
			trackGain: 1,
		});
		expect(mix[0]).toBeCloseTo(1, 6);
		expect(mix[Math.round(1 * SAMPLE_RATE)]).toBeCloseTo(0.25, 6);
		expect(mix[Math.round(1.75 * SAMPLE_RATE)]).toBeCloseTo(1, 6);
	});

	it("truncates at the end of the mix buffer instead of overrunning it", () => {
		const mix = new Float32Array(SAMPLE_RATE);
		expect(() =>
			mixElementInto({
				mix,
				source: new Float32Array(10 * SAMPLE_RATE).fill(1),
				element: { startTime: 0.5, duration: 10, trimStart: 0 },
				sampleRate: SAMPLE_RATE,
				trackGain: 1,
			}),
		).not.toThrow();
		expect(mix[SAMPLE_RATE - 1]).toBeCloseTo(1, 6);
	});
});

// ── the verb ─────────────────────────────────────────────────────────────────

describe("readMix verb", () => {
	it("refuses an empty timeline rather than reporting silence", async () => {
		const d = createDirectorApi(makeFakeEditor().editor);
		const res = await d.readMix();
		expect(res.ok).toBe(false);
		expect(res.message).toContain("Nothing on the timeline");
	});

	it("refuses when nothing decodable was mixed (no confident-looking floor)", async () => {
		const fake = makeFakeEditor();
		addAudio(fake, "Background Music", 0, 5);
		const d = createDirectorApi(fake.editor, {
			mixAudio: {
				decode: fixedMix(pcm(5, []), { sourcesMixed: 0, sourcesSkipped: 1 }),
			},
		});
		const res = await d.readMix();
		expect(res.ok).toBe(false);
		expect(res.message).toContain("No decodable audio");
	});

	it("default mixdown skips elements whose media has no file, and says so", async () => {
		// The fake editor's media surface resolves nothing, so the real
		// `decodeTimelineMixdown` walks the tracks and skips every element —
		// exercising the walk + skip accounting without a browser decode.
		const fake = makeFakeEditor();
		addAudio(fake, "Background Music", 0, 5);
		const res = await createDirectorApi(fake.editor).readMix();
		expect(res.ok).toBe(false);
		expect(res.message).toContain("No decodable audio");
	});

	it("surfaces a mixdown failure as a plain-language result, never a throw", async () => {
		const fake = makeFakeEditor();
		addAudio(fake, "Background Music", 0, 5);
		const d = createDirectorApi(fake.editor, {
			mixAudio: {
				decode: async () => {
					throw new Error("decode exploded");
				},
			},
		});
		const res = await d.readMix();
		expect(res.ok).toBe(false);
		expect(res.message).toContain("decode exploded");
	});

	it("reports loudness + dead air, and names the verbs that would fix it", async () => {
		const fake = makeFakeEditor();
		addAudio(fake, "Background Music", 0, 10);
		// Loud for 4s, then 6s of nothing — unmistakable dead air.
		const d = createDirectorApi(fake.editor, {
			mixAudio: {
				decode: fixedMix(pcm(10, [{ fromSec: 0, toSec: 4, amplitude: 0.5 }])),
			},
		});

		const res = await d.readMix();
		expect(res.ok).toBe(true);
		const data = res.data as MixReadData;

		expect(data.durationSec).toBe(10);
		expect(data.sourcesMixed).toBe(1);
		expect(data.loudnessCurve.length).toBeGreaterThan(0);
		expect(data.integratedLoudness.integrated).toBeLessThan(0);
		expect(data.deadAir.length).toBeGreaterThan(0);
		expect(data.deadAirTotalSec).toBeGreaterThan(1);
		// The remedy is NAMED in the message, not left for the model to infer.
		expect(res.message).toContain("removeSilence");
	});

	it("flags a music bed competing with speech and points at an applyEdit duck remedy", async () => {
		const fake = makeFakeEditor();
		addAudio(fake, "Background Music", 0, 10);
		addAudio(fake, "Voiceover", 4, 3); // name matches the voiceover heuristic
		// Constant level throughout: the bed measures exactly as loud under the
		// voiceover as it does on its own, i.e. it was never ducked.
		const d = createDirectorApi(fake.editor, {
			mixAudio: {
				decode: fixedMix(pcm(10, [{ fromSec: 0, toSec: 10, amplitude: 0.5 }])),
			},
		});

		const res = await d.readMix();
		expect(res.ok).toBe(true);
		const data = res.data as MixReadData;

		expect(data.overlaps.length).toBe(1);
		expect(data.overlaps[0].startSec).toBeCloseTo(4, 1);
		expect(data.overlaps[0].endSec).toBeCloseTo(7, 1);
		expect(data.competingOverlapCount).toBe(1);
		expect(res.message).toContain("applyEdit with a duck-style program");
	});

	it("does NOT flag a bed that is already ducked under the speech", async () => {
		const fake = makeFakeEditor();
		addAudio(fake, "Background Music", 0, 10);
		addAudio(fake, "Voiceover", 4, 3);
		// -12dB under the speech is exactly duckMusicUnderSpeech's own target.
		const d = createDirectorApi(fake.editor, {
			mixAudio: {
				decode: fixedMix(
					pcm(10, [
						{ fromSec: 0, toSec: 4, amplitude: 0.5 },
						{ fromSec: 4, toSec: 7, amplitude: 0.5 * 10 ** (-12 / 20) },
						{ fromSec: 7, toSec: 10, amplitude: 0.5 },
					]),
				),
			},
		});

		const res = await d.readMix();
		const data = res.data as MixReadData;
		expect(data.overlaps.length).toBe(1);
		expect(data.competingOverlapCount).toBe(0);
		expect(res.message).toContain("already ducked");
		expect(res.message).not.toContain("duckMusicUnderSpeech");
	});

	it("widens the curve interval on a long timeline to keep the payload bounded", async () => {
		const fake = makeFakeEditor();
		addAudio(fake, "Background Music", 0, 300);
		const d = createDirectorApi(fake.editor, {
			mixAudio: {
				decode: fixedMix(
					pcm(300, [{ fromSec: 0, toSec: 300, amplitude: 0.4 }]),
				),
			},
		});

		const res = await d.readMix();
		const data = res.data as MixReadData;
		// 300s at the module default (0.5s) would be 600 points.
		expect(data.loudnessSampleIntervalSec).toBeGreaterThan(0.5);
		expect(data.loudnessCurve.length).toBeLessThanOrEqual(120);
	});

	it("is a read: it reports no mutation delta", async () => {
		const fake = makeFakeEditor();
		addAudio(fake, "Background Music", 0, 5);
		const d = createDirectorApi(fake.editor, {
			mixAudio: {
				decode: fixedMix(pcm(5, [{ fromSec: 0, toSec: 5, amplitude: 0.5 }])),
			},
		});
		const res = await d.readMix();
		expect(res.ok).toBe(true);
		expect(res.delta).toBeUndefined();
	});
});

// ── catalog registration (the point of the whole exercise) ───────────────────

describe("readMix is reachable", () => {
	it("appears exactly once in the catalog as a read-scope verb", () => {
		const entries = toolCatalog().filter((t) => t.name === "readMix");
		expect(entries).toHaveLength(1);
		expect(entries[0].mutating).toBe(false);
		expect(scopeForTool("readMix")).toBe("reel:read");
	});

	it("its handler routes to DirectorApi.readMix with the coerced interval", async () => {
		const entry = toolCatalog().find((t) => t.name === "readMix");
		if (!entry) throw new Error("readMix missing from the catalog");
		let seen: { loudnessSampleIntervalSec?: number } | undefined;
		const director = {
			readMix: async (input: { loudnessSampleIntervalSec?: number }) => {
				seen = input;
				return { ok: true, message: "stub" };
			},
		} as unknown as Parameters<typeof entry.handler>[0];

		await entry.handler(director, { loudnessSampleIntervalSec: 0.25 });
		expect(seen).toEqual({ loudnessSampleIntervalSec: 0.25 });

		await entry.handler(director, {});
		expect(seen).toEqual({ loudnessSampleIntervalSec: undefined });
	});
});

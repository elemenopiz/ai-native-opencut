import { describe, expect, it } from "bun:test";
import { DEFAULT_DUCK_AMOUNT_DB } from "./craft";
import {
	computeDeadAirStretches,
	computeIntegratedLoudness,
	computeLoudnessCurveDb,
	computeSpeechMusicOverlaps,
	DB_FLOOR,
	DEFAULT_LOUDNESS_SAMPLE_INTERVAL_SEC,
	readMix,
} from "./mix-read";

const SAMPLE_RATE = 8000; // low but exact — keeps generated fixtures small and their block boundaries easy to reason about

/** A mono PCM buffer of `durationSec` at `SAMPLE_RATE`, built from windows.
 *  Each window is `{ fromSec, toSec, amplitude }`; unmentioned time is silence (0). */
function pcm(
	durationSec: number,
	windows: { fromSec: number; toSec: number; amplitude: number }[],
): Float32Array {
	const total = Math.round(durationSec * SAMPLE_RATE);
	const samples = new Float32Array(total);
	for (const w of windows) {
		const from = Math.round(w.fromSec * SAMPLE_RATE);
		const to = Math.min(total, Math.round(w.toSec * SAMPLE_RATE));
		for (let i = from; i < to; i++) {
			// A steady tone at the given amplitude (constant, not oscillating) —
			// computeLoudness/measureLUFS only care about |sample|/sample^2, so a
			// DC-like constant window exercises the same math as a real tone
			// while keeping the fixture trivial to reason about by hand.
			samples[i] = w.amplitude;
		}
	}
	return samples;
}

// ── computeLoudnessCurveDb ───────────────────────────────────────────────────

describe("computeLoudnessCurveDb", () => {
	it("returns [] for empty input", () => {
		expect(computeLoudnessCurveDb(new Float32Array(0), SAMPLE_RATE)).toEqual(
			[],
		);
	});

	it("reports full-scale amplitude as ~0dBFS and silence as the floor", () => {
		const samples = pcm(2, [{ fromSec: 0, toSec: 1, amplitude: 1 }]);
		const curve = computeLoudnessCurveDb(samples, SAMPLE_RATE, 0.5);
		expect(curve.length).toBeGreaterThan(0);
		// First point sits inside the loud window.
		expect(curve[0].levelDb).toBeCloseTo(0, 1);
		// Last point sits inside the silent tail.
		expect(curve[curve.length - 1].levelDb).toBe(DB_FLOOR);
	});

	it("samples at the requested interval (points spaced ~intervalSec apart)", () => {
		const samples = pcm(4, [{ fromSec: 0, toSec: 4, amplitude: 0.5 }]);
		const curve = computeLoudnessCurveDb(samples, SAMPLE_RATE, 1);
		expect(curve.length).toBe(4);
		expect(curve[0].atSec).toBeCloseTo(0.5, 5);
		expect(curve[1].atSec).toBeCloseTo(1.5, 5);
	});

	it("a quieter tone reports a proportionally lower dBFS level", () => {
		const loud = pcm(1, [{ fromSec: 0, toSec: 1, amplitude: 1 }]);
		const quiet = pcm(1, [{ fromSec: 0, toSec: 1, amplitude: 0.1 }]);
		const loudDb = computeLoudnessCurveDb(loud, SAMPLE_RATE, 1)[0].levelDb;
		const quietDb = computeLoudnessCurveDb(quiet, SAMPLE_RATE, 1)[0].levelDb;
		// 20*log10(0.1) = -20dB relative to full scale.
		expect(loudDb - quietDb).toBeCloseTo(20, 0);
	});

	it("uses DEFAULT_LOUDNESS_SAMPLE_INTERVAL_SEC when no interval is given", () => {
		const samples = pcm(2, [{ fromSec: 0, toSec: 2, amplitude: 0.5 }]);
		const withDefault = computeLoudnessCurveDb(samples, SAMPLE_RATE);
		const explicit = computeLoudnessCurveDb(
			samples,
			SAMPLE_RATE,
			DEFAULT_LOUDNESS_SAMPLE_INTERVAL_SEC,
		);
		expect(withDefault).toEqual(explicit);
	});
});

// ── computeIntegratedLoudness ────────────────────────────────────────────────

describe("computeIntegratedLoudness", () => {
	it("returns the absolute gate floor for empty/silent input", () => {
		const result = computeIntegratedLoudness(new Float32Array(0), SAMPLE_RATE);
		expect(result.integrated).toBe(-70);
		expect(result.range).toBe(0);
	});

	it("reports a louder, steady tone as louder than a quieter one", () => {
		const loud = pcm(2, [{ fromSec: 0, toSec: 2, amplitude: 0.9 }]);
		const quiet = pcm(2, [{ fromSec: 0, toSec: 2, amplitude: 0.1 }]);
		const loudResult = computeIntegratedLoudness(loud, SAMPLE_RATE);
		const quietResult = computeIntegratedLoudness(quiet, SAMPLE_RATE);
		expect(loudResult.integrated).toBeGreaterThan(quietResult.integrated);
		expect(loudResult.truePeak).toBeGreaterThan(quietResult.truePeak);
	});

	it("a full-scale constant tone measures a near-0dBFS true peak", () => {
		const samples = pcm(1, [{ fromSec: 0, toSec: 1, amplitude: 1 }]);
		const result = computeIntegratedLoudness(samples, SAMPLE_RATE);
		expect(result.truePeak).toBeCloseTo(0, 1);
	});

	it("is deterministic — same input twice, same output", () => {
		const samples = pcm(1.5, [{ fromSec: 0.2, toSec: 1.1, amplitude: 0.6 }]);
		const a = computeIntegratedLoudness(samples, SAMPLE_RATE);
		const b = computeIntegratedLoudness(samples, SAMPLE_RATE);
		expect(a).toEqual(b);
	});
});

// ── computeDeadAirStretches ──────────────────────────────────────────────────

describe("computeDeadAirStretches", () => {
	it("finds no dead air in a fully loud clip", () => {
		const samples = pcm(2, [{ fromSec: 0, toSec: 2, amplitude: 0.8 }]);
		expect(computeDeadAirStretches(samples, SAMPLE_RATE, 2)).toEqual([]);
	});

	it("flags a silent stretch long enough to survive auto-cut's smoothing", () => {
		const samples = pcm(3, [
			{ fromSec: 0, toSec: 1, amplitude: 0.8 },
			// [1, 2) stays silent (0) — 1s of dead air.
			{ fromSec: 2, toSec: 3, amplitude: 0.8 },
		]);
		const dead = computeDeadAirStretches(samples, SAMPLE_RATE, 3);
		expect(dead.length).toBe(1);
		// Reported bounds are the CUTTABLE span, not the raw acoustic silence:
		// auto-cut's margins (marginAfter 0.3 / marginBefore 0.2) hold the keep
		// open past the speech tail and ahead of the next head, so the 1s of
		// silence at [1, 2) yields [1.3, 1.8]. That is the honest answer — a
		// Director acting on [1, 2] would clip 0.3s of tail and 0.2s of head.
		expect(dead[0].startSec).toBeCloseTo(1.3, 1);
		expect(dead[0].endSec).toBeCloseTo(1.8, 1);
		expect(dead[0].durationSec).toBeCloseTo(0.5, 1);
	});

	it("reports a trailing silent stretch to the very end of the duration", () => {
		const samples = pcm(3, [{ fromSec: 0, toSec: 1.5, amplitude: 0.8 }]);
		const dead = computeDeadAirStretches(samples, SAMPLE_RATE, 3);
		expect(dead.length).toBeGreaterThan(0);
		const last = dead[dead.length - 1];
		expect(last.endSec).toBeCloseTo(3, 1);
	});

	it("forwards silence options through to detectSilenceSegments (tighter threshold keeps a quiet tone)", () => {
		const samples = pcm(3, [
			{ fromSec: 0, toSec: 1, amplitude: 0.8 },
			{ fromSec: 1, toSec: 2, amplitude: 0.03 }, // below the default 0.04 threshold, above a lowered one
			{ fromSec: 2, toSec: 3, amplitude: 0.8 },
		]);
		const defaultDead = computeDeadAirStretches(samples, SAMPLE_RATE, 3);
		const lowThresholdDead = computeDeadAirStretches(samples, SAMPLE_RATE, 3, {
			threshold: 0.01,
		});
		expect(defaultDead.length).toBeGreaterThan(0);
		expect(lowThresholdDead.length).toBe(0);
	});
});

// ── computeSpeechMusicOverlaps ───────────────────────────────────────────────

describe("computeSpeechMusicOverlaps", () => {
	it("returns [] when there is no music or no speech", () => {
		expect(
			computeSpeechMusicOverlaps({
				samples: pcm(2, [{ fromSec: 0, toSec: 2, amplitude: 0.5 }]),
				sampleRate: SAMPLE_RATE,
				durationSec: 2,
				speechIntervals: [],
				musicElements: [{ elementId: "m1", startSec: 0, durationSec: 2 }],
			}),
		).toEqual([]);
	});

	it("returns [] when speech and music never overlap in time", () => {
		const overlaps = computeSpeechMusicOverlaps({
			samples: pcm(6, [{ fromSec: 0, toSec: 6, amplitude: 0.5 }]),
			sampleRate: SAMPLE_RATE,
			durationSec: 6,
			speechIntervals: [{ startSec: 4, endSec: 5 }],
			musicElements: [{ elementId: "m1", startSec: 0, durationSec: 2 }],
		});
		expect(overlaps).toEqual([]);
	});

	it("flags a real overlap window with a positive competingDb when music stays loud under speech", () => {
		// Music plays the whole clip at a steady level; speech happens in the
		// middle but the mix NEVER recedes (no ducking happened) — the overlap
		// window should measure the SAME level as the baseline, so
		// competingDb should land close to +DEFAULT_DUCK_AMOUNT_DB (the mix is
		// exactly that much louder than a properly ducked mix would be).
		const samples = pcm(6, [{ fromSec: 0, toSec: 6, amplitude: 0.5 }]);
		const overlaps = computeSpeechMusicOverlaps({
			samples,
			sampleRate: SAMPLE_RATE,
			durationSec: 6,
			speechIntervals: [{ startSec: 2, endSec: 4 }],
			musicElements: [{ elementId: "music-bed", startSec: 0, durationSec: 6 }],
		});
		expect(overlaps.length).toBe(1);
		const overlap = overlaps[0];
		expect(overlap.musicElementId).toBe("music-bed");
		expect(overlap.startSec).toBeCloseTo(2, 1);
		expect(overlap.endSec).toBeCloseTo(4, 1);
		expect(overlap.competingDb).toBeCloseTo(-DEFAULT_DUCK_AMOUNT_DB, 0);
	});

	it("reads close to zero competingDb when the mix actually ducks during the overlap", () => {
		const duckedAmplitude = 0.5 * 10 ** (DEFAULT_DUCK_AMOUNT_DB / 20);
		const samples = pcm(6, [
			{ fromSec: 0, toSec: 2, amplitude: 0.5 },
			{ fromSec: 2, toSec: 4, amplitude: duckedAmplitude }, // ducked under speech
			{ fromSec: 4, toSec: 6, amplitude: 0.5 },
		]);
		const overlaps = computeSpeechMusicOverlaps({
			samples,
			sampleRate: SAMPLE_RATE,
			durationSec: 6,
			speechIntervals: [{ startSec: 2, endSec: 4 }],
			musicElements: [{ elementId: "music-bed", startSec: 0, durationSec: 6 }],
		});
		expect(overlaps.length).toBe(1);
		expect(overlaps[0].competingDb).toBeCloseTo(0, 0);
	});

	it("merges two speech intervals close enough to produce one overlap window per music element", () => {
		const samples = pcm(10, [{ fromSec: 0, toSec: 10, amplitude: 0.5 }]);
		const overlaps = computeSpeechMusicOverlaps({
			samples,
			sampleRate: SAMPLE_RATE,
			durationSec: 10,
			speechIntervals: [
				{ startSec: 2, endSec: 3 },
				{ startSec: 3.05, endSec: 4 }, // touching-enough gap
			],
			musicElements: [{ elementId: "m1", startSec: 0, durationSec: 10 }],
		});
		expect(overlaps.length).toBe(1);
		expect(overlaps[0].startSec).toBeCloseTo(2, 1);
		expect(overlaps[0].endSec).toBeCloseTo(4, 1);
	});

	it("clips overlap math to each music element's own timeline span", () => {
		const samples = pcm(10, [{ fromSec: 0, toSec: 10, amplitude: 0.5 }]);
		const overlaps = computeSpeechMusicOverlaps({
			samples,
			sampleRate: SAMPLE_RATE,
			durationSec: 10,
			speechIntervals: [{ startSec: 4, endSec: 8 }],
			musicElements: [{ elementId: "m1", startSec: 0, durationSec: 5 }], // ends at t=5
		});
		expect(overlaps.length).toBe(1);
		expect(overlaps[0].endSec).toBeCloseTo(5, 1); // clipped, not 8
	});

	it("is deterministic and sorted by startSec across multiple elements", () => {
		const samples = pcm(20, [{ fromSec: 0, toSec: 20, amplitude: 0.5 }]);
		const input = {
			samples,
			sampleRate: SAMPLE_RATE,
			durationSec: 20,
			speechIntervals: [
				{ startSec: 1, endSec: 2 },
				{ startSec: 10, endSec: 11 },
			],
			musicElements: [
				{ elementId: "late", startSec: 8, durationSec: 12 },
				{ elementId: "early", startSec: 0, durationSec: 4 },
			],
		};
		const a = computeSpeechMusicOverlaps(input);
		const b = computeSpeechMusicOverlaps(input);
		expect(a).toEqual(b);
		expect(a.map((o) => o.musicElementId)).toEqual(["early", "late"]);
	});
});

// ── readMix (composition) ────────────────────────────────────────────────────

describe("readMix", () => {
	it("composes a curve, integrated loudness, overlaps and dead air from one input", () => {
		const samples = pcm(8, [
			{ fromSec: 0, toSec: 3, amplitude: 0.6 },
			// [3, 4) silent — dead air
			{ fromSec: 4, toSec: 8, amplitude: 0.6 },
		]);
		const result = readMix({
			samples,
			sampleRate: SAMPLE_RATE,
			durationSec: 8,
			speechIntervals: [{ startSec: 5, endSec: 6 }],
			musicElements: [{ elementId: "m1", startSec: 4, durationSec: 4 }],
		});

		expect(result.loudnessSampleIntervalSec).toBe(
			DEFAULT_LOUDNESS_SAMPLE_INTERVAL_SEC,
		);
		expect(result.loudnessCurve.length).toBeGreaterThan(0);
		expect(result.integratedLoudness.integrated).toBeGreaterThan(-70);
		expect(result.deadAir.length).toBe(1);
		expect(result.overlaps.length).toBe(1);
		expect(result.overlaps[0].musicElementId).toBe("m1");
	});

	it("respects a caller-supplied loudnessSampleIntervalSec", () => {
		const samples = pcm(4, [{ fromSec: 0, toSec: 4, amplitude: 0.5 }]);
		const result = readMix({
			samples,
			sampleRate: SAMPLE_RATE,
			durationSec: 4,
			speechIntervals: [],
			musicElements: [],
			loudnessSampleIntervalSec: 1,
		});
		expect(result.loudnessSampleIntervalSec).toBe(1);
		expect(result.loudnessCurve.length).toBe(4);
	});

	it("is deterministic — same input twice, deep-equal output", () => {
		const samples = pcm(5, [{ fromSec: 1, toSec: 4, amplitude: 0.7 }]);
		const input = {
			samples,
			sampleRate: SAMPLE_RATE,
			durationSec: 5,
			speechIntervals: [{ startSec: 1, endSec: 3 }],
			musicElements: [{ elementId: "m1", startSec: 0, durationSec: 5 }],
		};
		expect(readMix(input)).toEqual(readMix(input));
	});
});

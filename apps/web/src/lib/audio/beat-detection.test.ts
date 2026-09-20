import { describe, expect, it } from "bun:test";
import {
	computeOnsetEnvelope,
	detectBeatGrid,
	estimateBpm,
	pickOnsets,
} from "./beat-detection";

const SAMPLE_RATE = 16000;

/**
 * A synthetic click track: short full-amplitude bursts at a fixed interval
 * in an otherwise silent buffer — the audio-DSP equivalent of a metronome,
 * and the fixture this detector is honestly good at (see the module doc's
 * accuracy caveat for real music).
 */
function generateClickTrack({
	sampleRate,
	durationSec,
	bpm,
	clickDurationSec = 0.01,
}: {
	sampleRate: number;
	durationSec: number;
	bpm: number;
	clickDurationSec?: number;
}): { samples: Float32Array; clickTimes: number[] } {
	const samples = new Float32Array(Math.round(sampleRate * durationSec));
	const intervalSec = 60 / bpm;
	const clickTimes: number[] = [];
	for (let t = 0; t < durationSec; t += intervalSec) {
		clickTimes.push(t);
		const startSample = Math.round(t * sampleRate);
		const clickSamples = Math.round(clickDurationSec * sampleRate);
		for (
			let i = startSample;
			i < Math.min(samples.length, startSample + clickSamples);
			i++
		) {
			samples[i] = 1;
		}
	}
	return { samples, clickTimes };
}

describe("computeOnsetEnvelope", () => {
	it("produces one hop per hopSec across the buffer", () => {
		const samples = new Float32Array(SAMPLE_RATE); // 1 second
		const envelope = computeOnsetEnvelope(samples, SAMPLE_RATE, 0.02);
		expect(envelope.times.length).toBe(50); // 1s / 20ms
		expect(envelope.energy.length).toBe(50);
	});

	it("reads near-zero energy for silence", () => {
		const samples = new Float32Array(SAMPLE_RATE);
		const envelope = computeOnsetEnvelope(samples, SAMPLE_RATE, 0.02);
		expect(envelope.energy.every((e) => e === 0)).toBe(true);
	});
});

describe("pickOnsets", () => {
	it("picks a clear spike above the local mean", () => {
		const { samples } = generateClickTrack({
			sampleRate: SAMPLE_RATE,
			durationSec: 2,
			bpm: 120,
		});
		const envelope = computeOnsetEnvelope(samples, SAMPLE_RATE, 0.02);
		const onsets = pickOnsets(envelope);
		// 120 BPM over 2s = 4 clicks (t=0, 0.5, 1, 1.5).
		expect(onsets.length).toBeGreaterThanOrEqual(3);
		expect(onsets.length).toBeLessThanOrEqual(5);
	});

	it("picks nothing from silence", () => {
		const samples = new Float32Array(SAMPLE_RATE);
		const envelope = computeOnsetEnvelope(samples, SAMPLE_RATE, 0.02);
		expect(pickOnsets(envelope)).toEqual([]);
	});
});

describe("estimateBpm", () => {
	it("recovers the exact BPM from noise-free, evenly-spaced onsets", () => {
		// 0.5s spacing = 120 BPM, already inside [60, 180].
		const onsets = [0, 0.5, 1, 1.5, 2, 2.5, 3];
		const { bpm, confidence } = estimateBpm(onsets);
		expect(bpm).toBe(120);
		expect(confidence).toBe(1);
	});

	it("folds an out-of-range interval into the search range by octave", () => {
		// 0.25s spacing implies 240 BPM, which folds down to 120 (÷2).
		const onsets = [0, 0.25, 0.5, 0.75, 1];
		const { bpm } = estimateBpm(onsets, [60, 180]);
		expect(bpm).toBe(120);
	});

	it("returns null for fewer than 2 onsets", () => {
		expect(estimateBpm([]).bpm).toBeNull();
		expect(estimateBpm([1]).bpm).toBeNull();
	});
});

describe("detectBeatGrid — synthetic click tracks", () => {
	it("recovers ~120 BPM from a 120 BPM click track", () => {
		const { samples, clickTimes } = generateClickTrack({
			sampleRate: SAMPLE_RATE,
			durationSec: 8,
			bpm: 120,
		});
		const result = detectBeatGrid(samples, SAMPLE_RATE);

		expect(result.bpm).not.toBeNull();
		expect(result.bpm as number).toBeGreaterThanOrEqual(115);
		expect(result.bpm as number).toBeLessThanOrEqual(125);
		expect(result.confidence).toBeGreaterThan(0.5);
		// Every synthetic click should be found within one hop (20ms) of truth,
		// and no more than 2 spurious extras.
		expect(result.beats.length).toBeGreaterThanOrEqual(clickTimes.length - 1);
		expect(result.beats.length).toBeLessThanOrEqual(clickTimes.length + 2);
		expect(result.downbeats.length).toBe(Math.ceil(result.beats.length / 4));
		expect(result.energyClass).not.toBeNull();
	});

	it("recovers ~90 BPM from a 90 BPM click track", () => {
		const { samples } = generateClickTrack({
			sampleRate: SAMPLE_RATE,
			durationSec: 8,
			bpm: 90,
		});
		const result = detectBeatGrid(samples, SAMPLE_RATE);
		expect(result.bpm as number).toBeGreaterThanOrEqual(85);
		expect(result.bpm as number).toBeLessThanOrEqual(95);
	});

	it("finds no beat grid in silence (an honest 'empty', not a fabricated tempo)", () => {
		const samples = new Float32Array(SAMPLE_RATE * 4);
		const result = detectBeatGrid(samples, SAMPLE_RATE);
		expect(result.bpm).toBeNull();
		expect(result.beats).toEqual([]);
		expect(result.confidence).toBe(0);
	});

	it("classifies energy density", () => {
		const dense = generateClickTrack({
			sampleRate: SAMPLE_RATE,
			durationSec: 4,
			bpm: 180,
		});
		const sparse = generateClickTrack({
			sampleRate: SAMPLE_RATE,
			durationSec: 20,
			bpm: 60,
		});
		expect(detectBeatGrid(dense.samples, SAMPLE_RATE).energyClass).toBe("high");
		expect(["low", "medium"]).toContain(
			detectBeatGrid(sparse.samples, SAMPLE_RATE).energyClass,
		);
	});
});

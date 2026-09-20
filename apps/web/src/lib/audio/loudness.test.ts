import { describe, expect, it } from "bun:test";
import { computeLUFS, isEffectivelySilent } from "./loudness";

const SAMPLE_RATE = 16000;

describe("computeLUFS", () => {
	it("floors pure silence at the absolute gate (-70 LUFS) and reads it as effectively silent", () => {
		const samples = new Float32Array(SAMPLE_RATE * 2);
		const result = computeLUFS(samples, SAMPLE_RATE);
		expect(result.integrated).toBe(-70);
		expect(isEffectivelySilent(result)).toBe(true);
	});

	it("measures a constant-amplitude signal as a real, non-silent loudness", () => {
		const samples = new Float32Array(SAMPLE_RATE * 2).fill(0.5);
		const result = computeLUFS(samples, SAMPLE_RATE);
		// RMS of a constant 0.5 signal is 0.5 → 10*log10(0.25) ≈ -6.02 dB.
		expect(result.integrated).toBeCloseTo(-6, 0);
		expect(result.truePeak).toBeCloseTo(-6, 0);
		expect(isEffectivelySilent(result)).toBe(false);
	});

	it("reports true peak at ~0 dBFS for a full-scale signal", () => {
		const samples = new Float32Array(SAMPLE_RATE).fill(1);
		const result = computeLUFS(samples, SAMPLE_RATE);
		expect(result.truePeak).toBeCloseTo(0, 0);
	});

	it("reports a lower loudness for a quieter constant signal", () => {
		const loud = computeLUFS(
			new Float32Array(SAMPLE_RATE).fill(0.8),
			SAMPLE_RATE,
		);
		const quiet = computeLUFS(
			new Float32Array(SAMPLE_RATE).fill(0.05),
			SAMPLE_RATE,
		);
		expect(quiet.integrated).toBeLessThan(loud.integrated);
	});

	it("handles a buffer shorter than one analysis block", () => {
		const samples = new Float32Array(10).fill(0.3);
		const result = computeLUFS(samples, SAMPLE_RATE);
		expect(Number.isFinite(result.integrated)).toBe(true);
	});
});

describe("isEffectivelySilent", () => {
	it("is false for a clip with a brief loud moment gated out of the integrated mean", () => {
		// Mostly silent, with one loud block — matches "quiet clip with a single
		// spoken word" more than "silent clip", so it should NOT read as silent
		// even though the (gated) integrated loudness alone might look low.
		const samples = new Float32Array(SAMPLE_RATE * 4);
		const loudBlockSamples = Math.round(SAMPLE_RATE * 0.4);
		samples.fill(0.9, 0, loudBlockSamples);
		const result = computeLUFS(samples, SAMPLE_RATE);
		expect(isEffectivelySilent(result)).toBe(false);
	});
});

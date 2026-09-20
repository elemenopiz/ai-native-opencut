import { describe, expect, it } from "bun:test";
import {
	computeMotionEnergy,
	decodeMotionEnergy,
	encodeMotionEnergy,
} from "./motion-energy";
import type { FrameSample } from "./frame-sample-types";

function frame(timestampSec: number, histogram: number[]): FrameSample {
	return {
		timestampSec,
		meanLuma: 128,
		lumaHistogram: histogram,
		stripMeans: new Array(7).fill(128),
		bandMeans: [128, 128, 128],
	};
}

describe("computeMotionEnergy", () => {
	it("reports 0 energy for the first sample (nothing to diff against)", () => {
		const points = computeMotionEnergy([frame(0, [1, 0, 0, 0])]);
		expect(points).toEqual([{ timestampSec: 0, energy: 0 }]);
	});

	it("reports 0 energy across a perfectly static sequence", () => {
		const still = [0, 1, 2, 3].map((t) => frame(t, [0.25, 0.25, 0.25, 0.25]));
		const points = computeMotionEnergy(still);
		expect(points.every((p) => p.energy === 0)).toBe(true);
	});

	it("reports high energy (~1) at a maximal histogram swap", () => {
		const points = computeMotionEnergy([frame(0, [1, 0]), frame(1, [0, 1])]);
		expect(points[1].energy).toBeCloseTo(1, 5);
	});

	it("reports a proportional value for a partial change", () => {
		// L1 distance = |1-0.5| + |0-0.5| = 1, normalized (÷2) = 0.5.
		const points = computeMotionEnergy([
			frame(0, [1, 0]),
			frame(1, [0.5, 0.5]),
		]);
		expect(points[1].energy).toBeCloseTo(0.5, 5);
	});

	it("returns [] for an empty input", () => {
		expect(computeMotionEnergy([])).toEqual([]);
	});
});

describe("encode/decodeMotionEnergy round-trip", () => {
	it("quantizes to Uint8 and back within rounding tolerance", () => {
		const points = [
			{ timestampSec: 0, energy: 0 },
			{ timestampSec: 1, energy: 0.5 },
			{ timestampSec: 2, energy: 1 },
		];
		const encoded = encodeMotionEnergy(points, 1);
		expect(encoded.values).toBeInstanceOf(Uint8Array);
		expect(encoded.values.length).toBe(3);
		expect(encoded.startSec).toBe(0);
		expect(encoded.stepSec).toBe(1);

		const decoded = decodeMotionEnergy(encoded);
		expect(decoded).toHaveLength(3);
		for (let i = 0; i < points.length; i++) {
			expect(decoded[i].timestampSec).toBe(points[i].timestampSec);
			expect(decoded[i].energy).toBeCloseTo(points[i].energy, 2);
		}
	});

	it("clamps out-of-range energy before quantizing", () => {
		const encoded = encodeMotionEnergy(
			[
				{ timestampSec: 0, energy: -1 },
				{ timestampSec: 1, energy: 5 },
			],
			1,
		);
		expect(encoded.values[0]).toBe(0);
		expect(encoded.values[1]).toBe(255);
	});

	it("handles an empty timeseries", () => {
		const encoded = encodeMotionEnergy([], 1);
		expect(encoded.values.length).toBe(0);
		expect(decodeMotionEnergy(encoded)).toEqual([]);
	});
});

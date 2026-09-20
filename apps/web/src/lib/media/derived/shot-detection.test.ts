import { describe, expect, it } from "bun:test";
import { detectShotChanges } from "./shot-detection";
import type { FrameSample } from "./frame-sample-types";

/** A frame sample that's entirely one luma bucket — a flat solid color. */
function solidFrame(
	timestampSec: number,
	bucket: number,
	buckets = 16,
): FrameSample {
	const histogram = new Array(buckets).fill(0);
	histogram[bucket] = 1;
	return {
		timestampSec,
		meanLuma: (bucket / buckets) * 255,
		lumaHistogram: histogram,
		stripMeans: new Array(7).fill((bucket / buckets) * 255),
		bandMeans: [
			(bucket / buckets) * 255,
			(bucket / buckets) * 255,
			(bucket / buckets) * 255,
		],
	};
}

describe("detectShotChanges", () => {
	it("finds a hard cut between two distinct solid-color runs", () => {
		// 5 seconds of a dark solid color, then 5 seconds of a bright solid color.
		const frames: FrameSample[] = [
			...[0, 1, 2, 3, 4].map((t) => solidFrame(t, 1)),
			...[5, 6, 7, 8, 9].map((t) => solidFrame(t, 14)),
		];

		const cuts = detectShotChanges(frames);

		expect(cuts).toHaveLength(1);
		expect(cuts[0].timeSec).toBe(5);
		// Two disjoint one-hot histograms are maximally different (L1 distance 2).
		expect(cuts[0].strength).toBeCloseTo(2, 5);
	});

	it("finds no cut across a single unbroken run", () => {
		const frames = [0, 1, 2, 3, 4, 5].map((t) => solidFrame(t, 8));
		expect(detectShotChanges(frames)).toHaveLength(0);
	});

	it("finds multiple cuts across three distinct runs", () => {
		const frames: FrameSample[] = [
			...[0, 1, 2].map((t) => solidFrame(t, 0)),
			...[3, 4, 5].map((t) => solidFrame(t, 8)),
			...[6, 7, 8].map((t) => solidFrame(t, 15)),
		];
		const cuts = detectShotChanges(frames);
		expect(cuts.map((c) => c.timeSec)).toEqual([3, 6]);
	});

	/** A histogram with mass spread across two adjacent buckets — for testing partial (non-maximal) distances; one-hot solids always differ maximally regardless of "how far apart" their buckets are. */
	function blendedFrame(
		timestampSec: number,
		weights: Record<number, number>,
	): FrameSample {
		const histogram = new Array(16).fill(0);
		for (const [bucket, weight] of Object.entries(weights)) {
			histogram[Number(bucket)] = weight;
		}
		return {
			timestampSec,
			meanLuma: 128,
			lumaHistogram: histogram,
			stripMeans: new Array(7).fill(128),
			bandMeans: [128, 128, 128],
		};
	}

	it("ignores a gradual drift that never crosses the threshold", () => {
		// Each step shifts 10% of the mass from bucket 8 to bucket 9 — a slow,
		// continuous drift (a pan/dissolve), not a hard cut. Adjacent frames are
		// never more than 0.2 apart in L1 distance, well under the default 0.55.
		const frames: FrameSample[] = [];
		for (let t = 0; t <= 5; t++) {
			const bucket9Share = t * 0.1;
			frames.push(blendedFrame(t, { 8: 1 - bucket9Share, 9: bucket9Share }));
		}
		expect(detectShotChanges(frames)).toHaveLength(0);
	});

	it("respects a custom threshold and minGapSec", () => {
		const frames: FrameSample[] = [
			blendedFrame(0, { 0: 1 }),
			blendedFrame(0.2, { 0: 0.7, 1: 0.3 }), // small change (L1 = 0.6), below a high threshold
			blendedFrame(0.4, { 15: 1 }), // big change (L1 = 2), within minGapSec of nothing yet
		];
		const cuts = detectShotChanges(frames, { threshold: 1.5, minGapSec: 1 });
		expect(cuts).toHaveLength(1);
		expect(cuts[0].timeSec).toBe(0.4);
	});

	it("returns [] for fewer than 2 frames", () => {
		expect(detectShotChanges([])).toEqual([]);
		expect(detectShotChanges([solidFrame(0, 0)])).toEqual([]);
	});
});

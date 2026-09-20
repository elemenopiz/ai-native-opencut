import { describe, expect, it } from "bun:test";
import { detectHeadTail } from "./head-tail-detection";
import type { FrameSample } from "./frame-sample-types";

function flatHistogram(dominantShare: number, buckets = 16): number[] {
	const rest = (1 - dominantShare) / (buckets - 1);
	const histogram = new Array(buckets).fill(rest);
	histogram[8] = dominantShare;
	return histogram;
}

function blackFrame(timestampSec: number): FrameSample {
	return {
		timestampSec,
		meanLuma: 2,
		lumaHistogram: flatHistogram(0.98),
		stripMeans: new Array(7).fill(2),
		bandMeans: [2, 2, 2],
	};
}

function blankFrame(timestampSec: number): FrameSample {
	// Flat mid-gray card: high dominant-bucket share, not black, no strip/band spread.
	return {
		timestampSec,
		meanLuma: 140,
		lumaHistogram: flatHistogram(0.95),
		stripMeans: new Array(7).fill(140),
		bandMeans: [140, 140, 140],
	};
}

function barsFrame(timestampSec: number): FrameSample {
	// SMPTE-bars-like: wide spread across vertical strips, textured histogram
	// (not a single dominant bucket) so it doesn't also read as "blank".
	const histogram = new Array(16).fill(1 / 16);
	return {
		timestampSec,
		meanLuma: 128,
		lumaHistogram: histogram,
		stripMeans: [20, 180, 40, 200, 60, 220, 30],
		bandMeans: [128, 128, 128],
	};
}

function letterboxedFrame(timestampSec: number): FrameSample {
	const histogram = new Array(16).fill(1 / 16);
	return {
		timestampSec,
		meanLuma: 70,
		lumaHistogram: histogram,
		stripMeans: new Array(7).fill(70),
		bandMeans: [5, 150, 5],
	};
}

function normalFrame(timestampSec: number): FrameSample {
	const histogram = new Array(16).fill(1 / 16);
	return {
		timestampSec,
		meanLuma: 130,
		lumaHistogram: histogram,
		stripMeans: [120, 125, 130, 135, 128, 122, 118],
		bandMeans: [125, 135, 128],
	};
}

describe("detectHeadTail", () => {
	it("finds leading black frames", () => {
		const frames = [
			blackFrame(0),
			blackFrame(1),
			blackFrame(2),
			normalFrame(3),
			normalFrame(4),
		];
		const result = detectHeadTail(frames);
		expect(result.head).toEqual({ durationSec: 3, kind: "black" });
		expect(result.tail).toBeNull();
	});

	it("finds trailing black frames", () => {
		const frames = [
			normalFrame(0),
			normalFrame(1),
			blackFrame(2),
			blackFrame(3),
		];
		const result = detectHeadTail(frames);
		expect(result.head).toBeNull();
		expect(result.tail).toEqual({ durationSec: 2, kind: "black" });
	});

	it("finds a leading color-bars slate", () => {
		const frames = [barsFrame(0), barsFrame(1), normalFrame(2), normalFrame(3)];
		const result = detectHeadTail(frames);
		expect(result.head).toEqual({ durationSec: 2, kind: "bars" });
	});

	it("classifies a leading letterboxed run as bars", () => {
		const frames = [letterboxedFrame(0), letterboxedFrame(1), normalFrame(2)];
		const result = detectHeadTail(frames);
		expect(result.head?.kind).toBe("bars");
	});

	it("finds a leading blank (flat) card", () => {
		const frames = [blankFrame(0), blankFrame(1), normalFrame(2)];
		const result = detectHeadTail(frames);
		expect(result.head).toEqual({ durationSec: 2, kind: "blank" });
	});

	it("reports null for both ends on an all-normal clip", () => {
		const frames = [normalFrame(0), normalFrame(1), normalFrame(2)];
		const result = detectHeadTail(frames);
		expect(result.head).toBeNull();
		expect(result.tail).toBeNull();
	});

	it("finds both a leading and a trailing issue independently", () => {
		const frames = [
			blackFrame(0),
			normalFrame(1),
			normalFrame(2),
			blankFrame(3),
		];
		const result = detectHeadTail(frames);
		expect(result.head).toEqual({ durationSec: 1, kind: "black" });
		expect(result.tail).toEqual({ durationSec: 1, kind: "blank" });
	});

	it("returns null/null for an empty input", () => {
		const result = detectHeadTail([]);
		expect(result.head).toBeNull();
		expect(result.tail).toBeNull();
	});
});

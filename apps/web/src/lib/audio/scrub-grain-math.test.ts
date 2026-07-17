import { describe, expect, test } from "bun:test";
import {
	GRAIN_DURATION_SECONDS,
	SCRUB_WINDOW_DURATION_SECONDS,
	computeGrainSampleRange,
	computeWindowStart,
	directionFromDelta,
	isOutsideWindow,
	sourceTimeForTimelineTime,
} from "./scrub-grain-math";

describe("directionFromDelta", () => {
	test("positive delta is forward", () => {
		expect(directionFromDelta(0.5)).toBe("forward");
	});

	test("negative delta is reverse", () => {
		expect(directionFromDelta(-0.5)).toBe("reverse");
	});

	test("zero delta defaults to forward", () => {
		expect(directionFromDelta(0)).toBe("forward");
	});
});

describe("computeWindowStart", () => {
	test("centers the window on time", () => {
		expect(computeWindowStart({ time: 10, windowDuration: 2 })).toBe(9);
	});

	test("clamps to zero near the start of the timeline", () => {
		expect(computeWindowStart({ time: 0.3, windowDuration: 2 })).toBe(0);
	});

	test("defaults to the standard 2s window", () => {
		expect(computeWindowStart({ time: 10 })).toBe(
			10 - SCRUB_WINDOW_DURATION_SECONDS / 2,
		);
	});
});

describe("isOutsideWindow", () => {
	test("inside the window is false", () => {
		expect(
			isOutsideWindow({ time: 5, windowStart: 4, windowDuration: 2 }),
		).toBe(false);
	});

	test("before the window start is true", () => {
		expect(
			isOutsideWindow({ time: 3.9, windowStart: 4, windowDuration: 2 }),
		).toBe(true);
	});

	test("at/after the window end is true", () => {
		expect(
			isOutsideWindow({ time: 6, windowStart: 4, windowDuration: 2 }),
		).toBe(true);
	});
});

describe("sourceTimeForTimelineTime", () => {
	test("maps timeline time to source time at rate 1", () => {
		const sourceTime = sourceTimeForTimelineTime({
			time: 12,
			clipStartTime: 10,
			trimStart: 3,
			playbackRate: 1,
		});
		expect(sourceTime).toBe(5); // 3 + (12 - 10) * 1
	});

	test("scales elapsed time by playbackRate", () => {
		const sourceTime = sourceTimeForTimelineTime({
			time: 12,
			clipStartTime: 10,
			trimStart: 3,
			playbackRate: 2,
		});
		expect(sourceTime).toBe(7); // 3 + (12 - 10) * 2
	});

	test("treats a non-positive rate as 1 (defensive)", () => {
		const sourceTime = sourceTimeForTimelineTime({
			time: 12,
			clipStartTime: 10,
			trimStart: 3,
			playbackRate: 0,
		});
		expect(sourceTime).toBe(5);
	});
});

describe("computeGrainSampleRange", () => {
	const grainSamples = Math.round(GRAIN_DURATION_SECONDS * 48000); // 2400 @ 48kHz

	test("centers the grain around the requested sample, forward", () => {
		const range = computeGrainSampleRange({
			centerSample: 96000, // mid-buffer
			grainSamples,
			bufferLength: 192000,
			direction: "forward",
		});
		expect(range).not.toBeNull();
		expect(range?.length).toBe(grainSamples);
		expect(range?.reversed).toBe(false);
		expect(range?.startSample).toBe(96000 - grainSamples / 2);
	});

	test("same sample window is selected for reverse, but flagged reversed", () => {
		const forward = computeGrainSampleRange({
			centerSample: 96000,
			grainSamples,
			bufferLength: 192000,
			direction: "forward",
		});
		const reverse = computeGrainSampleRange({
			centerSample: 96000,
			grainSamples,
			bufferLength: 192000,
			direction: "reverse",
		});
		expect(reverse?.startSample).toBe(forward?.startSample);
		expect(reverse?.length).toBe(forward?.length);
		expect(reverse?.reversed).toBe(true);
		expect(forward?.reversed).toBe(false);
	});

	test("clamps and shrinks near the start of the buffer", () => {
		const range = computeGrainSampleRange({
			centerSample: 10,
			grainSamples,
			bufferLength: 192000,
			direction: "forward",
		});
		expect(range).not.toBeNull();
		expect(range?.startSample).toBe(0);
		expect(range?.length).toBeLessThan(grainSamples);
	});

	test("clamps and shrinks near the end of the buffer", () => {
		const bufferLength = 100000;
		const range = computeGrainSampleRange({
			centerSample: bufferLength - 5,
			grainSamples,
			bufferLength,
			direction: "forward",
		});
		expect(range).not.toBeNull();
		expect(range && range.startSample + range.length).toBeLessThanOrEqual(
			bufferLength,
		);
	});

	test("returns null when the center is entirely outside the buffer", () => {
		const range = computeGrainSampleRange({
			centerSample: -50000,
			grainSamples,
			bufferLength: 192000,
			direction: "forward",
		});
		expect(range).toBeNull();
	});

	test("returns null for an empty buffer", () => {
		const range = computeGrainSampleRange({
			centerSample: 0,
			grainSamples,
			bufferLength: 0,
			direction: "forward",
		});
		expect(range).toBeNull();
	});
});

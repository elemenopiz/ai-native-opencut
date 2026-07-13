import { describe, expect, it } from "bun:test";
import {
	boolOps,
	chunkify,
	computeLoudness,
	detectSilenceSegments,
	mutMargin,
	resolveOptions,
	secondsToTicks,
	smoothing,
	thresholdLevels,
} from "../engine";
import type { ResolvedAutoCutOptions } from "../types";

// Helper: build resolved options with overrides for chunkify tests.
function opts(
	over: Partial<ResolvedAutoCutOptions> = {},
): ResolvedAutoCutOptions {
	return resolveOptions(over);
}

describe("thresholdLevels", () => {
	it("keeps chunks at or above the threshold, drops below", () => {
		// Use float32-exact values so the >= boundary is unambiguous.
		const levels = new Float32Array([0.0, 0.5, 0.25, 0.75, 0.5]);
		expect(thresholdLevels(levels, 0.5)).toEqual([
			false,
			true, // >= threshold is inclusive
			false,
			true,
			true,
		]);
	});

	it("all-silent and all-loud degenerate curves", () => {
		expect(thresholdLevels(new Float32Array([0, 0, 0]), 0.04)).toEqual([
			false,
			false,
			false,
		]);
		expect(thresholdLevels(new Float32Array([1, 1, 1]), 0.04)).toEqual([
			true,
			true,
			true,
		]);
	});
});

describe("boolOps combinators", () => {
	const a = [true, true, false, false];
	const b = [true, false, true, false];
	it("not / and / or / xor are element-wise", () => {
		expect(boolOps.not(a)).toEqual([false, false, true, true]);
		expect(boolOps.and(a, b)).toEqual([true, false, false, false]);
		expect(boolOps.or(a, b)).toEqual([true, true, true, false]);
		expect(boolOps.xor(a, b)).toEqual([false, true, true, false]);
	});
});

describe("mutMargin (verbatim auto-editor semantics)", () => {
	it("positive asymmetric margin: before grows back, after grows forward", () => {
		// One loud region at ticks [5,6]. startIndex=[5], endIndex=[7].
		const arr = falseArr(12);
		arr[5] = true;
		arr[6] = true;
		mutMargin(arr, 2, 3); // before=2, after=3
		// before: ticks 3,4 set true (max(5-2,0)..5)
		// after: ticks 7,8,9 set true (7..min(7+3,12))
		expect(boolsToIndices(arr)).toEqual([3, 4, 5, 6, 7, 8, 9]);
	});

	it("asymmetry: before != after produces different pad widths", () => {
		const arr = falseArr(12);
		arr[5] = true;
		arr[6] = true;
		mutMargin(arr, 1, 4);
		// before: tick 4 ; after: ticks 7,8,9,10
		expect(boolsToIndices(arr)).toEqual([4, 5, 6, 7, 8, 9, 10]);
	});

	it("negative margins shrink the region at its edges", () => {
		// Loud region ticks [3..8]. startIndex=[3], endIndex=[9].
		const arr = falseArr(12);
		for (let i = 3; i <= 8; i++) arr[i] = true;
		mutMargin(arr, -2, -2);
		// startM<0: from i=3, k in 3..<min(3+2,12)=5 => set 3,4 false
		// endM<0:   from i=9, k in max(9-2,0)=7..<9 => set 7,8 false
		expect(boolsToIndices(arr)).toEqual([5, 6]);
	});

	it("clamps at array edges (no out-of-bounds writes)", () => {
		// Loud region at the very start and end.
		const arr = falseArr(5);
		arr[0] = true; // rising edge is at j=0 which is NOT a transition (no j-1)
		arr[4] = true;
		// Transitions: arr[4] rising at j=4 -> startIndex=[4]; falling: none (ends true)
		mutMargin(arr, 10, 10);
		// startM=10 from i=4: k in max(4-10,0)=0..<4 => set 0,1,2,3 true
		expect(boolsToIndices(arr)).toEqual([0, 1, 2, 3, 4]);
	});

	it("adjacent regions merge when margins overlap", () => {
		// Two loud singletons at 3 and 8; big margins bridge the gap.
		const arr = falseArr(12);
		arr[3] = true;
		arr[8] = true;
		mutMargin(arr, 3, 3);
		// region@3: startIndex 3 -> before 0,1,2 ; endIndex 4 -> after 4,5,6
		// region@8: startIndex 8 -> before 5,6,7 ; endIndex 9 -> after 9,10,11
		// union covers 0..11 contiguous
		expect(boolsToIndices(arr)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
	});

	it("transitions collected once up front (before any mutation)", () => {
		// If transitions were recomputed after startM grew the array, endM would
		// see shifted edges. Verify against the collect-once contract.
		const arr = falseArr(10);
		arr[4] = true;
		arr[5] = true;
		mutMargin(arr, 2, 2);
		// startIndex=[4], endIndex=[6] computed from ORIGINAL arr.
		// before: 2,3 ; after: 6,7
		expect(boolsToIndices(arr)).toEqual([2, 3, 4, 5, 6, 7]);
	});
});

describe("smoothing (min-run, verbatim auto-editor)", () => {
	it("drops a short TRUE (keep) run below minclip", () => {
		// keep run of length 2 with minclip=3 -> dropped.
		const arr = [false, true, true, false, false];
		expect(smoothing(arr, 1, 3)).toEqual([false, false, false, false, false]);
	});

	it("keeps a TRUE run exactly == minclip (strictly-shorter rule)", () => {
		const arr = [false, true, true, true, false];
		expect(smoothing(arr, 1, 3)).toEqual(arr);
	});

	it("fills a short FALSE (cut) run below mincut", () => {
		// false run of length 1 between trues, mincut=2 -> filled.
		const arr = [true, true, false, true, true];
		expect(smoothing(arr, 2, 1)).toEqual([true, true, true, true, true]);
	});

	it("handles terminal short runs (run reaching the last index)", () => {
		// Trailing TRUE run length 1, minclip=2 -> dropped at the end.
		const arr = [false, false, false, false, true];
		expect(smoothing(arr, 1, 2)).toEqual([false, false, false, false, false]);
	});

	it("converges on a pathological alternating case (2-cycle guard)", () => {
		// Alternating single-tick runs; without a 2-cycle guard this loops forever.
		const arr = [true, false, true, false, true, false];
		const out = smoothing(arr, 2, 2);
		// Just assert it terminates and returns a same-length array.
		expect(out.length).toBe(arr.length);
	});
});

describe("chunkify (multi-label, merging, exact end)", () => {
	it("emits keep/cut segments in seconds with exact final end", () => {
		// timebase 10 -> each tick 0.1s. keep = [T,T,F,F,F]. duration 0.53s.
		const keep = [true, true, false, false, false];
		const segs = chunkify(keep, 10, 0.53, opts());
		expect(segs).toEqual([
			{ start: 0, end: 0.2, action: { type: "keep" } },
			{ start: 0.2, end: 0.53, action: { type: "cut" } },
		]);
	});

	it("emits a speed label when silentAction is 'speed'", () => {
		const keep = [true, false, false];
		const segs = chunkify(
			keep,
			10,
			0.3,
			opts({ silentAction: "speed", silentSpeed: 4 }),
		);
		expect(segs).toEqual([
			{ start: 0, end: 0.1, action: { type: "keep" } },
			{ start: 0.1, end: 0.3, action: { type: "speed", speed: 4 } },
		]);
	});

	it("merges adjacent same-label runs (defensive)", () => {
		// A fully-loud signal is one keep segment covering the duration.
		const keep = [true, true, true, true];
		const segs = chunkify(keep, 10, 0.4, opts());
		expect(segs).toEqual([{ start: 0, end: 0.4, action: { type: "keep" } }]);
	});

	it("empty label array yields one full-duration silent segment", () => {
		expect(chunkify([], 10, 0.5, opts())).toEqual([
			{ start: 0, end: 0.5, action: { type: "cut" } },
		]);
		expect(chunkify([], 10, 0, opts())).toEqual([]);
	});
});

describe("computeLoudness", () => {
	it("max-abs per chunk, normalized [0,1]", () => {
		// 2 samples/chunk at sr=20, timebase=10 -> exactSize=2.
		const samples = new Float32Array([0.25, -0.75, 0.125, 0.0625, -1.0, 0.5]);
		const levels = computeLoudness(samples, 20, 10);
		expect(levels.length).toBe(3);
		expect(levels[0]).toBeCloseTo(0.75, 6);
		expect(levels[1]).toBeCloseTo(0.125, 6);
		expect(levels[2]).toBeCloseTo(1.0, 6);
	});

	it("chunk count matches duration in ticks", () => {
		// 100 samples, sr=100, timebase=30 -> exactSize≈3.33 -> ~30 chunks.
		const samples = new Float32Array(100).fill(0.5);
		const levels = computeLoudness(samples, 100, 30);
		expect(levels.length).toBe(Math.round(100 / (100 / 30)));
	});

	it("empty input -> empty curve", () => {
		expect(computeLoudness(new Float32Array(0), 16000, 30).length).toBe(0);
	});

	it("covers every sample exactly once (last chunk absorbs remainder)", () => {
		// A single loud spike in the LAST sample must show up in the last chunk.
		const samples = new Float32Array(101);
		samples[100] = 1.0;
		const levels = computeLoudness(samples, 100, 30);
		expect(levels[levels.length - 1]).toBe(1.0);
	});
});

describe("secondsToTicks", () => {
	it("rounds seconds*timebase", () => {
		expect(secondsToTicks(0.2, 30)).toBe(6);
		expect(secondsToTicks(0.3, 30)).toBe(9);
		expect(secondsToTicks(0.26, 30)).toBe(8); // 7.8 -> 8
		expect(secondsToTicks(0.4, 30)).toBe(12);
	});
});

describe("detectSilenceSegments end-to-end (synthetic PCM)", () => {
	// Build a 16kHz signal: 1kHz sine burst / silence / burst.
	function sineBurst(
		samples: Float32Array,
		from: number,
		to: number,
		amp = 0.8,
	) {
		const sr = 16000;
		for (let i = from; i < to; i++) {
			samples[i] = amp * Math.sin((2 * Math.PI * 1000 * i) / sr);
		}
	}

	it("detects a loud/silent/loud structure within one tick", () => {
		const sr = 16000;
		const total = sr * 3; // 3 seconds
		const samples = new Float32Array(total);
		// [0.0s, 1.0s) loud, [1.0s, 2.0s) silent, [2.0s, 3.0s) loud.
		sineBurst(samples, 0, sr * 1);
		sineBurst(samples, sr * 2, sr * 3);

		// No margins/min-runs so the raw threshold boundaries survive.
		const analysis = detectSilenceSegments(samples, sr, {
			threshold: 0.04,
			marginBefore: 0,
			marginAfter: 0,
			minKeep: 0,
			minCut: 0,
		});

		expect(analysis.duration).toBeCloseTo(3, 5);
		expect(analysis.timebase).toBe(30);

		// Expect keep / cut / keep.
		expect(analysis.segments.length).toBe(3);
		expect(analysis.segments[0].action).toEqual({ type: "keep" });
		expect(analysis.segments[1].action).toEqual({ type: "cut" });
		expect(analysis.segments[2].action).toEqual({ type: "keep" });

		const tick = 1 / 30;
		// Boundaries within one tick of 1.0s and 2.0s.
		expect(Math.abs(analysis.segments[0].end - 1.0)).toBeLessThanOrEqual(tick);
		expect(Math.abs(analysis.segments[1].end - 2.0)).toBeLessThanOrEqual(tick);
		// Final segment ends at exact duration.
		expect(analysis.segments[2].end).toBeCloseTo(3, 5);
	});

	it("margin extends the kept region into the silence", () => {
		const sr = 16000;
		const total = sr * 3;
		const samples = new Float32Array(total);
		sineBurst(samples, 0, sr * 1);
		sineBurst(samples, sr * 2, sr * 3);

		const withMargin = detectSilenceSegments(samples, sr, {
			marginBefore: 0.2,
			marginAfter: 0.3,
			minKeep: 0,
			minCut: 0,
		});
		// The cut segment should be shorter than the raw 1s of silence because
		// marginAfter (0.3s) + marginBefore (0.2s) eat into it.
		const cut = withMargin.segments.find((s) => s.action.type === "cut");
		expect(cut).toBeDefined();
		if (cut) expect(cut.end - cut.start).toBeLessThan(1.0);
	});

	it("all-silent -> single cut segment", () => {
		const sr = 16000;
		const samples = new Float32Array(sr).fill(0);
		const analysis = detectSilenceSegments(samples, sr);
		expect(analysis.segments).toEqual([
			{ start: 0, end: 1, action: { type: "cut" } },
		]);
	});

	it("all-loud -> single keep segment", () => {
		const sr = 16000;
		const samples = new Float32Array(sr);
		for (let i = 0; i < samples.length; i++) samples[i] = 0.8;
		const analysis = detectSilenceSegments(samples, sr);
		expect(analysis.segments).toEqual([
			{ start: 0, end: 1, action: { type: "keep" } },
		]);
	});

	it("very short input (< 1 chunk) still yields a covering segment", () => {
		const sr = 16000;
		// 100 samples ~ 6ms, far less than one 1/30s chunk.
		const samples = new Float32Array(100).fill(0);
		const analysis = detectSilenceSegments(samples, sr);
		expect(analysis.segments.length).toBe(1);
		expect(analysis.segments[0].start).toBe(0);
		expect(analysis.segments[0].end).toBeCloseTo(100 / sr, 6);
	});

	it("empty input -> no segments, zero duration", () => {
		const analysis = detectSilenceSegments(new Float32Array(0), 16000);
		expect(analysis.segments).toEqual([]);
		expect(analysis.duration).toBe(0);
	});
});

// --- tiny local helpers -----------------------------------------------------

function falseArr(n: number): boolean[] {
	return new Array<boolean>(n).fill(false);
}

function boolsToIndices(arr: boolean[]): number[] {
	const out: number[] = [];
	for (let i = 0; i < arr.length; i++) if (arr[i]) out.push(i);
	return out;
}

import { describe, expect, it } from "bun:test";
import type { FillerCutRange } from "../filler-detect";
import {
	allKeepBase,
	buildSmartCleanupPlan,
	summarizeSmartCleanup,
} from "../smart-cleanup";
import type { EditSegment } from "../types";

function filler(
	start: number,
	end: number,
	over: Partial<FillerCutRange> = {},
): FillerCutRange {
	return {
		start,
		end,
		source: "filler",
		confidence: "high",
		label: "um",
		...over,
	};
}

describe("allKeepBase", () => {
	it("covers [0, duration] as a single keep segment", () => {
		expect(allKeepBase(10)).toEqual([
			{ start: 0, end: 10, action: { type: "keep" } },
		]);
	});
	it("zero/negative duration yields no segments", () => {
		expect(allKeepBase(0)).toEqual([]);
	});
});

describe("buildSmartCleanupPlan", () => {
	it("returns base unchanged when there are no extra cuts (byte-identical silence-only behavior)", () => {
		const base: EditSegment[] = [
			{ start: 0, end: 2, action: { type: "keep" } },
			{ start: 2, end: 3, action: { type: "cut" } },
			{ start: 3, end: 10, action: { type: "keep" } },
		];
		expect(buildSmartCleanupPlan(base, [])).toBe(base);
	});

	it("splits a keep segment 3-way when a filler range is fully inside it", () => {
		const base = allKeepBase(10);
		const plan = buildSmartCleanupPlan(base, [filler(4, 5)]);
		expect(plan).toEqual([
			{ start: 0, end: 4, action: { type: "keep" } },
			{ start: 4, end: 5, action: { type: "cut" } },
			{ start: 5, end: 10, action: { type: "keep" } },
		]);
	});

	it("converts an entire keep segment to cut when the filler range matches its bounds exactly (no zero-length slivers)", () => {
		const base: EditSegment[] = [
			{ start: 0, end: 2, action: { type: "cut" } },
			{ start: 2, end: 5, action: { type: "keep" } },
			{ start: 5, end: 8, action: { type: "cut" } },
		];
		const plan = buildSmartCleanupPlan(base, [filler(2, 5)]);
		// The middle keep is fully consumed and fuses with its cut neighbors
		// into one contiguous cut span — no zero-length keep/cut slivers.
		expect(plan).toEqual([{ start: 0, end: 8, action: { type: "cut" } }]);
	});

	it("clips a filler range that spans a keep/cut boundary, without creating overlap or a gap", () => {
		const base: EditSegment[] = [
			{ start: 0, end: 5, action: { type: "keep" } },
			{ start: 5, end: 10, action: { type: "cut" } },
		];
		// Filler range straddles the boundary: [4, 7) — only [4,5) is inside
		// the keep segment; [5,7) is already cut.
		const plan = buildSmartCleanupPlan(base, [filler(4, 7)]);
		expect(plan).toEqual([
			{ start: 0, end: 4, action: { type: "keep" } },
			{ start: 4, end: 10, action: { type: "cut" } },
		]);
	});

	it("fuses two overlapping filler ranges before subtracting (no double-count, no duplicate cut segments)", () => {
		const base = allKeepBase(10);
		const plan = buildSmartCleanupPlan(base, [
			filler(3, 5, { label: "um" }),
			filler(4.5, 6, {
				source: "false-start",
				confidence: "low",
				label: "retry",
			}),
		]);
		expect(plan).toEqual([
			{ start: 0, end: 3, action: { type: "keep" } },
			{ start: 3, end: 6, action: { type: "cut" } },
			{ start: 6, end: 10, action: { type: "keep" } },
		]);
	});

	it("fuses a filler cut that touches (zero-gap) an existing cut segment into one contiguous cut", () => {
		const base: EditSegment[] = [
			{ start: 0, end: 5, action: { type: "keep" } },
			{ start: 5, end: 6, action: { type: "cut" } },
			{ start: 6, end: 10, action: { type: "keep" } },
		];
		// Filler cut is [4, 5) — touches the existing cut at exactly 5.
		const plan = buildSmartCleanupPlan(base, [filler(4, 5)]);
		expect(plan).toEqual([
			{ start: 0, end: 4, action: { type: "keep" } },
			{ start: 4, end: 6, action: { type: "cut" } },
			{ start: 6, end: 10, action: { type: "keep" } },
		]);
	});

	it("preserves a speed segment's remainder action when subtracting a filler cut from it", () => {
		const base: EditSegment[] = [
			{ start: 0, end: 10, action: { type: "speed", speed: 4 } },
		];
		const plan = buildSmartCleanupPlan(base, [filler(4, 5)]);
		expect(plan).toEqual([
			{ start: 0, end: 4, action: { type: "speed", speed: 4 } },
			{ start: 4, end: 5, action: { type: "cut" } },
			{ start: 5, end: 10, action: { type: "speed", speed: 4 } },
		]);
	});

	it("ignores extra cuts that fall entirely outside the base range", () => {
		const base = allKeepBase(10);
		const plan = buildSmartCleanupPlan(base, [filler(20, 21)]);
		expect(plan).toEqual(base);
	});

	it("a filler range covering multiple base segments removes across all of them", () => {
		const base: EditSegment[] = [
			{ start: 0, end: 3, action: { type: "keep" } },
			{ start: 3, end: 4, action: { type: "cut" } },
			{ start: 4, end: 8, action: { type: "keep" } },
		];
		const plan = buildSmartCleanupPlan(base, [filler(1, 6)]);
		expect(plan).toEqual([
			{ start: 0, end: 1, action: { type: "keep" } },
			{ start: 1, end: 6, action: { type: "cut" } },
			{ start: 6, end: 8, action: { type: "keep" } },
		]);
	});
});

describe("summarizeSmartCleanup", () => {
	it("counts fillers vs. false-starts separately and carries the undetectable count through", () => {
		const cuts: FillerCutRange[] = [
			filler(0, 1),
			filler(2, 3),
			{
				start: 4,
				end: 5,
				source: "false-start",
				confidence: "low",
				label: "x",
			},
		];
		expect(summarizeSmartCleanup(cuts, 3)).toEqual({
			fillerCount: 2,
			falseStartCount: 1,
			undetectableFillerCount: 3,
		});
	});
});

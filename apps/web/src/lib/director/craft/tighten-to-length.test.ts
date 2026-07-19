import { describe, expect, it } from "bun:test";
import {
	DEFAULT_CONVERGENCE_TOLERANCE_SEC,
	DEFAULT_MIN_CLIP_DURATION_SEC,
	tightenToLength,
	type TightenElementInput,
} from "./tighten-to-length";

function el(
	elementId: string,
	startSec: number,
	durationSec: number,
	trimmableSegments?: { start: number; end: number }[],
): TightenElementInput {
	return { elementId, startSec, durationSec, trimmableSegments };
}

describe("tightenToLength", () => {
	it("no-ops when the current runtime is already within tolerance of the target", () => {
		const plan = tightenToLength({
			elements: [el("a", 0, 5)],
			targetDurationSec: 5,
		});
		expect(plan).toEqual({ ops: [], projectedDurationSec: 5 });
	});

	it("reports a shortfall (not an error) when the target is longer than the current cut", () => {
		const plan = tightenToLength({
			elements: [el("a", 0, 5)],
			targetDurationSec: 10,
		});
		expect(plan.ops).toEqual([]);
		expect(plan.projectedDurationSec).toBe(5);
		expect(plan.shortfall).toEqual({
			deltaSec: 5,
			reason:
				"current runtime is already shorter than the target — trims can only shorten, not add content",
		});
	});

	it("prefers each element's own trimmable (silence) budget before touching anything else", () => {
		// a has 3s of detected low-interest content; removing exactly that
		// much hits the target without ever falling back to proportional trim.
		const plan = tightenToLength({
			elements: [el("a", 0, 10, [{ start: 6, end: 9 }]), el("b", 10, 10)],
			targetDurationSec: 17,
		});

		expect(plan.shortfall).toBeUndefined();
		expect(plan.projectedDurationSec).toBe(17);
		expect(plan.ops).toEqual([
			{ verb: "trim", args: { slotId: "a", duration: 7 } },
			{ verb: "move", args: { slotId: "b", newStartTime: 7 } },
		]);
	});

	it("never trims into a protected range, even tail-only", () => {
		// protected [8,9] inside a's [0,10] span leaves only the last 1s (9-10) tail-trimmable.
		const plan = tightenToLength({
			elements: [el("a", 0, 10)],
			targetDurationSec: 9,
			protectedRanges: [{ startSec: 8, endSec: 9 }],
		});

		expect(plan.shortfall).toBeUndefined();
		expect(plan.ops).toEqual([
			{ verb: "trim", args: { slotId: "a", duration: 9 } },
		]);
	});

	it("returns a stated shortfall when a protected range makes the target unreachable", () => {
		const plan = tightenToLength({
			elements: [el("a", 0, 10)],
			targetDurationSec: 5,
			protectedRanges: [{ startSec: 8, endSec: 9 }],
		});

		// Only the [9,10] second is ever trimmable (tail-only, protected [8,9]).
		expect(plan.ops).toEqual([
			{ verb: "trim", args: { slotId: "a", duration: 9 } },
		]);
		expect(plan.shortfall).toEqual({
			deltaSec: 4,
			reason:
				"elements are at their protected/minimum-duration floor — cannot trim further without violating protected ranges or minClipDurationSec",
		});
	});

	it("never trims an element below minClipDurationSec", () => {
		const plan = tightenToLength({
			elements: [el("a", 0, 1), el("b", 1, 1)],
			targetDurationSec: 1, // needs to remove exactly the two elements' combined floor-respecting capacity (0.5 each)
		});

		expect(plan.shortfall).toBeUndefined();
		for (const op of plan.ops) {
			if (op.verb !== "trim") continue;
			const duration = (op.args as { duration: number }).duration;
			expect(duration).toBeGreaterThanOrEqual(
				DEFAULT_MIN_CLIP_DURATION_SEC - 1e-6,
			);
		}
		expect(plan.projectedDurationSec).toBe(1);
	});

	it("respects a configurable minClipDurationSec floor", () => {
		// cap = 10 - 4 = 6; need to remove 9 (10 -> 1), so 3s is an unreachable shortfall.
		const plan = tightenToLength({
			elements: [el("a", 0, 10)],
			targetDurationSec: 1,
			minClipDurationSec: 4,
		});
		expect(plan.ops).toEqual([
			{ verb: "trim", args: { slotId: "a", duration: 4 } },
		]);
		expect(plan.shortfall).toEqual({
			deltaSec: 3,
			reason:
				"elements are at their protected/minimum-duration floor — cannot trim further without violating protected ranges or minClipDurationSec",
		});
	});

	it("distributes the remainder proportionally to each element's available tail capacity", () => {
		// a: 3s (cap 2.5 @ default 0.5 floor), b: 10s (cap 9.5). capacitySum=12, need to remove 3 <= 12
		// => single-pass proportional: a gives 2.5/12*3=0.625, b gives 9.5/12*3=2.375.
		const plan = tightenToLength({
			elements: [el("a", 0, 3), el("b", 3, 10)],
			targetDurationSec: 10,
		});

		expect(plan.shortfall).toBeUndefined();
		expect(plan.projectedDurationSec).toBe(10);
		expect(plan.ops).toEqual([
			{ verb: "trim", args: { slotId: "a", duration: 2.375 } },
			{ verb: "trim", args: { slotId: "b", duration: 7.625 } },
			{ verb: "move", args: { slotId: "b", newStartTime: 2.375 } },
		]);
	});

	it("combines phase 1 (trimmable budget) and phase 2 (proportional) when phase 1 alone isn't enough", () => {
		// a has a 1s trimmable budget (phase 1 takes it all); target still needs
		// 1 more second, which falls back to proportional across remaining capacity.
		const plan = tightenToLength({
			elements: [
				el("a", 0, 4, [{ start: 3, end: 4 }]), // trimmable budget 1s, cap 3.5
				el("b", 4, 4), // no trimmable, cap 3.5
			],
			targetDurationSec: 6, // originalTotal 8, excess 2: phase1 removes 1 from a, phase2 splits remaining 1 across a(cap 2.5) + b(cap 3.5)
		});

		expect(plan.shortfall).toBeUndefined();
		expect(plan.projectedDurationSec).toBe(6);
		// a: 1 (phase1) + 2.5/6*1 (phase2) ; b: 3.5/6*1 (phase2)
		const aOp = plan.ops.find(
			(op) =>
				op.verb === "trim" && (op.args as { slotId: string }).slotId === "a",
		);
		const bOp = plan.ops.find(
			(op) =>
				op.verb === "trim" && (op.args as { slotId: string }).slotId === "b",
		);
		expect(aOp).toBeDefined();
		expect(bOp).toBeDefined();
		const aDuration = (aOp?.args as { duration: number }).duration;
		const bDuration = (bOp?.args as { duration: number }).duration;
		// Converged exactly: the two NEW (post-trim) durations sum to the target.
		expect(aDuration + bDuration).toBeCloseTo(6, 6);
		// a gave up more than its 1s phase-1 budget alone (phase 2 topped it up).
		expect(4 - aDuration).toBeGreaterThan(1);
	});

	it("keeps downstream elements gapless by emitting move ops when a start shifts", () => {
		const plan = tightenToLength({
			elements: [el("a", 0, 10, [{ start: 8, end: 10 }]), el("b", 10, 5)],
			targetDurationSec: 13,
		});
		const moveOp = plan.ops.find((op) => op.verb === "move");
		expect(moveOp).toEqual({
			verb: "move",
			args: { slotId: "b", newStartTime: 8 },
		});
	});

	it("omits a move op for an element whose start did not shift", () => {
		const plan = tightenToLength({
			elements: [el("a", 0, 10, [{ start: 8, end: 10 }])],
			targetDurationSec: 8,
		});
		expect(plan.ops.some((op) => op.verb === "move")).toBe(false);
	});

	it("honors a configurable convergenceToleranceSec", () => {
		const strict = tightenToLength({
			elements: [el("a", 0, 5)],
			targetDurationSec: 4.9,
			convergenceToleranceSec: 0.05,
		});
		expect(strict.shortfall).toBeUndefined(); // 0.1 excess > phase capacity? cap=4.5, so fully reachable
		expect(strict.projectedDurationSec).toBeCloseTo(4.9, 6);
	});

	it("is deterministic: same input twice yields deep-equal plans", () => {
		const input = {
			elements: [
				el("a", 0, 10, [{ start: 6, end: 9 }]),
				el("b", 10, 10),
				el("c", 20, 5),
			],
			targetDurationSec: 15,
			protectedRanges: [{ startSec: 21, endSec: 22 }],
		};
		const p1 = tightenToLength(input);
		const p2 = tightenToLength(input);
		expect(p1).toEqual(p2);
	});

	it("exposes its documented defaults", () => {
		expect(DEFAULT_CONVERGENCE_TOLERANCE_SEC).toBe(0.25);
		expect(DEFAULT_MIN_CLIP_DURATION_SEC).toBe(0.5);
	});
});

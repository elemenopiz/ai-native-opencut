import { describe, expect, it } from "bun:test";
import {
	type CraftBeatMarker,
	type CraftClip,
	cutOnBeat,
	DEFAULT_BEAT_SNAP_TOLERANCE_SEC,
} from "./cut-on-beat";

function clip(
	elementId: string,
	startSec: number,
	durationSec: number,
	trimStart = 0,
): CraftClip {
	return { elementId, startSec, durationSec, trimStart };
}

function beat(time: number, isDownbeat = false): CraftBeatMarker {
	return { time, isDownbeat };
}

describe("cutOnBeat", () => {
	it("returns an empty plan with a stated reason when there is no beat grid", () => {
		const clips = [clip("a", 0, 2), clip("b", 2, 2)];
		const plan = cutOnBeat(clips, []);
		expect(plan).toEqual({
			ops: [],
			skipped: [],
			reason: "no beat grid supplied",
		});
	});

	it("returns an empty plan with a stated reason for fewer than two clips", () => {
		const plan = cutOnBeat([clip("a", 0, 2)], [beat(2)]);
		expect(plan.ops).toEqual([]);
		expect(plan.reason).toBe("fewer than two clips — no cut point to snap");
	});

	it("snaps a cut point to a nearby beat within tolerance", () => {
		// join at t=2.0, nearest beat at t=2.1 (100ms away, within default 150ms).
		const clips = [clip("a", 0, 2), clip("b", 2, 3)];
		const plan = cutOnBeat(clips, [beat(2.1)]);

		expect(plan.skipped).toEqual([]);
		expect(plan.ops).toEqual([
			{ verb: "trim", args: { slotId: "a", duration: 2.1 } },
			{
				verb: "trim",
				args: { slotId: "b", startTime: 2.1, trimStart: 0.1, duration: 2.9 },
			},
		]);
	});

	it("carries an existing trimStart through the right clip's snap", () => {
		const clips = [clip("a", 0, 2), clip("b", 2, 3, 5)];
		const plan = cutOnBeat(clips, [beat(2.1)]);
		const rightOp = plan.ops.find(
			(op) => (op.args as { slotId: string }).slotId === "b",
		);
		expect(rightOp?.args).toEqual({
			slotId: "b",
			startTime: 2.1,
			trimStart: 5.1,
			duration: 2.9,
		});
	});

	it("omits a no-op entry when the cut is already exactly on the beat", () => {
		const clips = [clip("a", 0, 2), clip("b", 2, 3)];
		const plan = cutOnBeat(clips, [beat(2)]);
		expect(plan.ops).toEqual([]);
		expect(plan.skipped).toEqual([
			{ elementId: "a", reason: "already-on-beat" },
		]);
	});

	it("skips a join with no beat inside tolerance", () => {
		const clips = [clip("a", 0, 2), clip("b", 2, 3)];
		const plan = cutOnBeat(clips, [
			beat(2 + DEFAULT_BEAT_SNAP_TOLERANCE_SEC + 0.01),
		]);
		expect(plan.ops).toEqual([]);
		expect(plan.skipped).toEqual([
			{ elementId: "a", reason: "no-beat-within-tolerance" },
		]);
	});

	it("honors the exact tolerance boundary (inclusive)", () => {
		const clips = [clip("a", 0, 2), clip("b", 2, 3)];
		const plan = cutOnBeat(clips, [beat(2 + DEFAULT_BEAT_SNAP_TOLERANCE_SEC)]);
		expect(plan.ops).toHaveLength(2);
		expect(plan.skipped).toEqual([]);
	});

	it("skips a snap that would shrink the left clip below the min duration", () => {
		// left clip is 0.6s; snapping the join backward by 0.12s (within the
		// default 150ms tolerance) would drop it to 0.48s (< default 0.5s floor).
		const clips = [clip("a", 0, 0.6), clip("b", 0.6, 3)];
		const plan = cutOnBeat(clips, [beat(0.48)]);
		expect(plan.ops).toEqual([]);
		expect(plan.skipped).toEqual([
			{ elementId: "a", reason: "would-shrink-left-below-min-duration" },
		]);
	});

	it("skips a snap that would shrink the right clip below the min duration", () => {
		// right clip is 0.6s; snapping the join forward by 0.12s (within tolerance)
		// would drop it to 0.48s.
		const clips = [clip("a", 0, 2), clip("b", 2, 0.6)];
		const plan = cutOnBeat(clips, [beat(2.12)]);
		expect(plan.ops).toEqual([]);
		expect(plan.skipped).toEqual([
			{ elementId: "a", reason: "would-shrink-right-below-min-duration" },
		]);
	});

	it("respects a configurable minClipDurationSec", () => {
		// join at t=0.9, beat at t=0.8 (0.1s away, within default tolerance) -> left clip would become 0.8s.
		const clips = [clip("a", 0, 0.9), clip("b", 0.9, 3)];
		const strict = cutOnBeat(clips, [beat(0.8)], { minClipDurationSec: 1 });
		expect(strict.ops).toEqual([]);
		const lenient = cutOnBeat(clips, [beat(0.8)], { minClipDurationSec: 0.5 });
		expect(lenient.ops).toHaveLength(2);
	});

	it("respects a configurable toleranceSec", () => {
		const clips = [clip("a", 0, 2), clip("b", 2, 3)];
		const tight = cutOnBeat(clips, [beat(2.3)], { toleranceSec: 0.1 });
		expect(tight.ops).toEqual([]);
		const wide = cutOnBeat(clips, [beat(2.3)], { toleranceSec: 0.5 });
		expect(wide.ops).toHaveLength(2);
	});

	it("only snaps real joins — a gap between clips has no cut point to move", () => {
		const clips = [clip("a", 0, 2), clip("b", 2.5, 3)]; // 0.5s gap
		const plan = cutOnBeat(clips, [beat(2.1), beat(2.6)]);
		expect(plan.ops).toEqual([]);
		expect(plan.skipped).toEqual([]);
	});

	it("handles a multi-clip sequence, folding a middle clip's two joins into ONE merged op", () => {
		const clips = [clip("a", 0, 2), clip("b", 2, 2), clip("c", 4, 2)];
		// join1 (a|b) at t=2 -> beat 2.05 (delta +0.05); join2 (b|c) at t=4 -> beat 3.95 (delta -0.05).
		// b sits on both joins: it gets ONE op with the RIGHT-side fields from
		// join1 (startTime/trimStart) and the cumulative duration after join2
		// (1.95 - 0.05 = 1.9), not two conflicting ops.
		const plan = cutOnBeat(clips, [beat(2.05), beat(3.95)]);
		expect(plan.ops).toEqual([
			{ verb: "trim", args: { slotId: "a", duration: 2.05 } },
			{
				verb: "trim",
				args: { slotId: "b", startTime: 2.05, trimStart: 0.05, duration: 1.9 },
			},
			{
				verb: "trim",
				args: {
					slotId: "c",
					startTime: 3.95,
					trimStart: -0.05,
					duration: 2.05,
				},
			},
		]);
	});

	it("picks the nearest beat when several are within tolerance", () => {
		const clips = [clip("a", 0, 2), clip("b", 2, 3)];
		const plan = cutOnBeat(clips, [beat(1.9), beat(2.05), beat(2.12)]);
		expect(plan.ops[0].args).toEqual({ slotId: "a", duration: 2.05 });
	});

	it("is deterministic: same input twice yields deep-equal plans", () => {
		const clips = [clip("a", 0, 2), clip("b", 2, 2), clip("c", 4, 2)];
		const beats = [beat(0.4), beat(2.05), beat(3.95), beat(6.1)];
		const p1 = cutOnBeat(clips, beats);
		const p2 = cutOnBeat(clips, beats);
		expect(p1).toEqual(p2);
	});
});

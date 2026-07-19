/**
 * `cutOnBeat` — snap cut points (the join between two adjacent clips) to the
 * nearest beat. Craft rule (editor terms): a cut landing even a few frames
 * off the beat reads as sloppy on music-driven footage; nudging it onto the
 * beat is one of the first things an editor does on a cut with a music bed.
 *
 * INPUT GROUNDING (read-only):
 *  - {@link CraftClip} mirrors the fields `stores/beat-grid-store.ts` /
 *    `types/timeline.ts`'s `TimelineElement` already carry (`startTime`,
 *    `duration`, `trimStart`) — just the slice this macro needs.
 *  - {@link CraftBeatMarker} mirrors `lib/timeline/audio-sync-utils.ts`'s
 *    `BeatMarker` (`{ time, isDownbeat }`) AFTER `mapBeatsToTimeline` has
 *    already projected the store's SOURCE-time `BeatGrid.beats` onto the
 *    TIMELINE — this macro only ever reasons in timeline time, same as
 *    `useBeatGridStore`'s own `getTimelineBeatMarkers`. Own local mirror,
 *    not an import — same "own copy" discipline `edit-critic.ts` uses for
 *    `EditCriticBeatGrid`.
 *
 * SCOPE: `clips` is one ordered, single-track sequence (the "cut-together"
 * clips a beat-synced edit is built from). A "cut point" only exists where
 * clip[i] and clip[i+1] actually JOIN (clip[i]'s end === clip[i+1]'s start,
 * within {@link CRAFT_EPSILON}) — a gap between clips has no single edit
 * point to snap, so non-adjacent boundaries are left alone. The very first
 * clip's own start and the very last clip's own end are not cut points
 * (nothing to join there) and are never moved.
 *
 * MOVING A CUT POINT: shifting the join by `delta` seconds trims the LEFT
 * clip's tail by `delta` (`duration += delta`) and slides+re-trims the RIGHT
 * clip's head by the same `delta` (`startTime += delta`, `trimStart +=
 * delta`, `duration -= delta`) so the two clips stay contiguous and every
 * frame either side of the new join is real, un-fabricated footage — never
 * a freeze or a gap. Both are emitted as one `trim` {@link CraftOp} each
 * (the `trim` verb accepts `trimStart`/`startTime`/`duration` together in a
 * single call).
 *
 * A middle clip sits on TWO joins (it is the right side of one, the left
 * side of the next) — each join's delta is computed against a running
 * "working" copy of every clip (updated as each join is resolved, left to
 * right) rather than the original input, so a clip's second adjustment
 * always starts from its first one. The two joins' effects on that one
 * clip are folded into a SINGLE `trim` {@link CraftOp} (one op per
 * element, fields merged) rather than two ops that would otherwise
 * clobber each other if a caller applied them in order.
 */

import { CRAFT_EPSILON, type CraftOp, roundSec } from "./types";

/** Default snap tolerance: a cut within this many seconds of a beat gets pulled onto it. */
export const DEFAULT_BEAT_SNAP_TOLERANCE_SEC = 0.15;

/** Default floor: a snap is never applied if it would shrink either side of the join below this duration. */
export const DEFAULT_MIN_CLIP_DURATION_SEC = 0.5;

/** One clip in the cut-together sequence `cutOnBeat` reasons about. */
export interface CraftClip {
	/** The `DirectorApi` slot/element id this clip is addressed by in emitted ops. */
	elementId: string;
	/** Timeline start, seconds. */
	startSec: number;
	/** Visible (post-trim) duration, seconds. */
	durationSec: number;
	/** Source in-point offset, seconds (`TimelineElement.trimStart`). Defaults to 0 — a clip that starts at the top of its media. */
	trimStart?: number;
}

/** One beat, already projected onto TIMELINE time (mirrors `audio-sync-utils.ts`'s `BeatMarker`). */
export interface CraftBeatMarker {
	/** TIMELINE time of the beat, seconds. */
	time: number;
	isDownbeat: boolean;
}

/** Why a candidate cut point was NOT snapped — diagnostic, not an error. */
export type CutOnBeatSkipReason =
	| "already-on-beat"
	| "no-beat-within-tolerance"
	| "would-shrink-left-below-min-duration"
	| "would-shrink-right-below-min-duration";

export interface CutOnBeatSkip {
	/** The left clip of the join that was skipped. */
	elementId: string;
	reason: CutOnBeatSkipReason;
}

export interface CutOnBeatPlan {
	ops: CraftOp[];
	/** One entry per candidate join that was NOT snapped (including no-op "already on beat" joins), for diagnostics/tests. */
	skipped: CutOnBeatSkip[];
	/** Set when the plan is trivially empty for a structural reason (no beat grid, fewer than 2 clips) rather than per-join skips. */
	reason?: string;
}

export interface CutOnBeatOptions {
	/** Snap tolerance, seconds. Default {@link DEFAULT_BEAT_SNAP_TOLERANCE_SEC} (±150ms). */
	toleranceSec?: number;
	/** Minimum clip duration a snap must preserve on both sides. Default {@link DEFAULT_MIN_CLIP_DURATION_SEC} (0.5s). */
	minClipDurationSec?: number;
}

/** Nearest beat to `t` within `toleranceSec`, or `undefined` when none qualifies. */
function nearestBeat(
	t: number,
	beats: CraftBeatMarker[],
	toleranceSec: number,
): CraftBeatMarker | undefined {
	let best: CraftBeatMarker | undefined;
	let bestDist = Number.POSITIVE_INFINITY;
	for (const beat of beats) {
		const dist = Math.abs(beat.time - t);
		if (dist <= toleranceSec && dist < bestDist) {
			best = beat;
			bestDist = dist;
		}
	}
	return best;
}

/**
 * Plan trims that snap every clip-to-clip join in `clips` onto the nearest
 * beat in `beats`, within `toleranceSec`, never shrinking either side below
 * `minClipDurationSec`. Deterministic: iterates `clips` in the given order
 * and `beats` is only ever read, never reordered by this function (callers
 * should pass beats already sorted, though correctness does not depend on
 * it — `nearestBeat` scans the full list).
 */
export function cutOnBeat(
	clips: CraftClip[],
	beats: CraftBeatMarker[],
	options: CutOnBeatOptions = {},
): CutOnBeatPlan {
	const toleranceSec = Math.max(
		0,
		options.toleranceSec ?? DEFAULT_BEAT_SNAP_TOLERANCE_SEC,
	);
	const minClipDurationSec = Math.max(
		0,
		options.minClipDurationSec ?? DEFAULT_MIN_CLIP_DURATION_SEC,
	);

	if (beats.length === 0) {
		return { ops: [], skipped: [], reason: "no beat grid supplied" };
	}
	if (clips.length < 2) {
		return {
			ops: [],
			skipped: [],
			reason: "fewer than two clips — no cut point to snap",
		};
	}

	const skipped: CutOnBeatSkip[] = [];

	// Running "working" copy of every clip, updated left-to-right as each
	// join is resolved — a middle clip's second adjustment (as the LEFT of
	// its next join) always starts from its first one (as the RIGHT of the
	// previous join).
	const working = new Map<
		string,
		{ startSec: number; durationSec: number; trimStart: number }
	>(
		clips.map((c) => [
			c.elementId,
			{
				startSec: c.startSec,
				durationSec: c.durationSec,
				trimStart: c.trimStart ?? 0,
			},
		]),
	);

	// Merged args per touched element — a clip on two joins gets ONE op, not two.
	const argsByElement = new Map<
		string,
		{ startTime?: number; trimStart?: number; duration?: number }
	>();
	const touchOrder: string[] = [];
	function mergeArgs(elementId: string, patch: Record<string, number>) {
		let existing = argsByElement.get(elementId);
		if (!existing) {
			existing = {};
			argsByElement.set(elementId, existing);
			touchOrder.push(elementId);
		}
		Object.assign(existing, patch);
	}

	for (let i = 0; i < clips.length - 1; i++) {
		const leftId = clips[i].elementId;
		const rightId = clips[i + 1].elementId;
		// biome-ignore lint/style/noNonNullAssertion: seeded from `clips` above, always present.
		const left = working.get(leftId)!;
		// biome-ignore lint/style/noNonNullAssertion: seeded from `clips` above, always present.
		const right = working.get(rightId)!;
		const leftEnd = left.startSec + left.durationSec;

		// Only a real join has a single well-defined cut point to snap.
		if (Math.abs(right.startSec - leftEnd) > CRAFT_EPSILON) continue;

		const cutPoint = leftEnd;
		const beat = nearestBeat(cutPoint, beats, toleranceSec);
		if (!beat) {
			skipped.push({ elementId: leftId, reason: "no-beat-within-tolerance" });
			continue;
		}

		const delta = beat.time - cutPoint;
		if (Math.abs(delta) <= CRAFT_EPSILON) {
			skipped.push({ elementId: leftId, reason: "already-on-beat" });
			continue;
		}

		const newLeftDuration = left.durationSec + delta;
		if (newLeftDuration < minClipDurationSec - CRAFT_EPSILON) {
			skipped.push({
				elementId: leftId,
				reason: "would-shrink-left-below-min-duration",
			});
			continue;
		}

		const newRightDuration = right.durationSec - delta;
		if (newRightDuration < minClipDurationSec - CRAFT_EPSILON) {
			skipped.push({
				elementId: leftId,
				reason: "would-shrink-right-below-min-duration",
			});
			continue;
		}

		const newRightStart = right.startSec + delta;
		const newRightTrimStart = right.trimStart + delta;

		left.durationSec = newLeftDuration;
		right.startSec = newRightStart;
		right.trimStart = newRightTrimStart;
		right.durationSec = newRightDuration;

		mergeArgs(leftId, { duration: roundSec(newLeftDuration) });
		mergeArgs(rightId, {
			startTime: roundSec(newRightStart),
			trimStart: roundSec(newRightTrimStart),
			duration: roundSec(newRightDuration),
		});
	}

	const ops: CraftOp[] = touchOrder.map((elementId) => ({
		verb: "trim",
		// biome-ignore lint/style/noNonNullAssertion: every id in `touchOrder` was just inserted into `argsByElement`.
		args: { slotId: elementId, ...argsByElement.get(elementId)! },
	}));

	return { ops, skipped };
}

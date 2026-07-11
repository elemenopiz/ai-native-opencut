// Ported (loose reimplementation) from OpenCut mainline `pre-rewrite` tag
// (238750c0), MIT licensed:
//   apps/web/src/timeline/group-resize/{compute-resize,types}.ts
//
// `MediaTime` (integer ticks) is replaced with plain seconds-as-numbers, and
// the source's per-member `retime` (variable-speed clip-time <-> source-time
// curve) is dropped entirely — our codebase has no retime/speed-ramp concept
// (only a constant `playbackRate`, which the existing single-element resize
// hook already ignores for trim math), so every helper below reduces to the
// 1:1 (no-retime) branch of pre-rewrite's math. This keeps behavior
// consistent with `use-element-resize.ts`'s existing single-element trim
// logic, which this ports the *group* version of.
//
// `buildGroupResizeMembers` has no pre-rewrite equivalent in the ported
// files — it's original glue that assembles `GroupResizeMember[]` from a
// list of element refs, computing each member's left/right neighbor bound
// while excluding every other member of the same resize group (so group
// members never block each other; only stationary, non-selected elements
// on the same track can bound a member's trim).

import type { TimelineTrack } from "@/types/timeline";
import { snapTimeToFrame } from "@/lib/time";

export type ResizeSide = "left" | "right";

/** One member of a resize group, snapshotted at drag-start. */
export interface GroupResizeMember {
	trackId: string;
	elementId: string;
	startTime: number;
	duration: number;
	trimStart: number;
	trimEnd: number;
	/** Present (any value) ⇒ this element has a fixed source length and its
	 *  trim is bounded; absent ⇒ unlimited extension (matches the existing
	 *  single-element hook's `canExtendElementDuration`). */
	sourceDuration?: number;
	/** End time of the nearest non-group element to the left on the same
	 *  track, or null when unbounded. */
	leftNeighborBound: number | null;
	/** Start time of the nearest non-group element to the right on the same
	 *  track, or null when unbounded. */
	rightNeighborBound: number | null;
}

export interface GroupResizeUpdate {
	trackId: string;
	elementId: string;
	patch: {
		trimStart: number;
		trimEnd: number;
		startTime: number;
		duration: number;
	};
}

export interface GroupResizeResult {
	deltaTime: number;
	updates: GroupResizeUpdate[];
}

export interface ComputeGroupResizeArgs {
	members: GroupResizeMember[];
	side: ResizeSide;
	deltaTime: number;
	fps: number;
}

/** Compute the group-wide clamped delta (the same delta is applied to every
 *  member) and the resulting per-member trim/duration/startTime patch. The
 *  delta is clamped by the *tightest* bound across all members — one
 *  member's neighbor or minimum-duration limit can restrict the whole
 *  group's drag, exactly like pre-rewrite's `computeGroupResize`. */
export function computeGroupResize({
	members,
	side,
	deltaTime,
	fps,
}: ComputeGroupResizeArgs): GroupResizeResult {
	if (members.length === 0) {
		return { deltaTime: 0, updates: [] };
	}

	const minDuration = fps > 0 ? 1 / fps : 0;

	let minimumDeltaTime = getMinimumAllowedDeltaTime({
		member: members[0],
		side,
		minDuration,
	});
	let maximumDeltaTime = getMaximumAllowedDeltaTime({
		member: members[0],
		side,
		minDuration,
	});

	for (const member of members.slice(1)) {
		minimumDeltaTime = Math.max(
			minimumDeltaTime,
			getMinimumAllowedDeltaTime({ member, side, minDuration }),
		);
		const memberMaximum = getMaximumAllowedDeltaTime({
			member,
			side,
			minDuration,
		});
		if (memberMaximum !== null) {
			maximumDeltaTime =
				maximumDeltaTime === null
					? memberMaximum
					: Math.min(maximumDeltaTime, memberMaximum);
		}
	}

	const clampedDeltaTime =
		maximumDeltaTime === null
			? Math.max(minimumDeltaTime, deltaTime)
			: Math.min(Math.max(deltaTime, minimumDeltaTime), maximumDeltaTime);

	// Snap once, then re-clamp (bounds are usually frame-aligned already, so
	// this is normally a no-op; at a hard source-extent limit it may not be,
	// and honoring the bound wins over frame alignment).
	const snappedDeltaTime =
		fps > 0
			? snapTimeToFrame({ time: clampedDeltaTime, fps })
			: clampedDeltaTime;
	const finalDeltaTimeRaw =
		maximumDeltaTime === null
			? Math.max(minimumDeltaTime, snappedDeltaTime)
			: Math.min(
					Math.max(snappedDeltaTime, minimumDeltaTime),
					maximumDeltaTime,
				);
	const finalDeltaTime = Object.is(finalDeltaTimeRaw, -0)
		? 0
		: finalDeltaTimeRaw;

	return {
		deltaTime: finalDeltaTime,
		updates: members.map((member) =>
			buildResizeUpdate({ member, side, deltaTime: finalDeltaTime }),
		),
	};
}

function buildResizeUpdate({
	member,
	side,
	deltaTime,
}: {
	member: GroupResizeMember;
	side: ResizeSide;
	deltaTime: number;
}): GroupResizeUpdate {
	if (side === "left") {
		return {
			trackId: member.trackId,
			elementId: member.elementId,
			patch: {
				trimStart: Math.max(0, member.trimStart + deltaTime),
				trimEnd: member.trimEnd,
				startTime: member.startTime + deltaTime,
				duration: member.duration - deltaTime,
			},
		};
	}

	return {
		trackId: member.trackId,
		elementId: member.elementId,
		patch: {
			trimStart: member.trimStart,
			trimEnd: Math.max(0, member.trimEnd - deltaTime),
			startTime: member.startTime,
			duration: member.duration + deltaTime,
		},
	};
}

function getMinimumAllowedDeltaTime({
	member,
	side,
	minDuration,
}: {
	member: GroupResizeMember;
	side: ResizeSide;
	minDuration: number;
}): number {
	if (side === "right") {
		return minDuration - member.duration;
	}

	const leftNeighborFloor =
		member.leftNeighborBound !== null
			? member.leftNeighborBound - member.startTime
			: -member.startTime;

	if (member.sourceDuration == null) {
		return leftNeighborFloor;
	}

	// Bounded: can extend left by at most `trimStart` (down to trimStart 0).
	return Math.max(leftNeighborFloor, -member.trimStart);
}

function getMaximumAllowedDeltaTime({
	member,
	side,
	minDuration,
}: {
	member: GroupResizeMember;
	side: ResizeSide;
	minDuration: number;
}): number | null {
	if (side === "left") {
		return member.duration - minDuration;
	}

	const rightNeighborCeiling =
		member.rightNeighborBound === null
			? null
			: member.rightNeighborBound - (member.startTime + member.duration);

	if (member.sourceDuration == null) {
		return rightNeighborCeiling;
	}

	// Bounded: can extend right by at most `trimEnd` (down to trimEnd 0).
	const sourceDurationCeiling = member.trimEnd;
	return rightNeighborCeiling === null
		? sourceDurationCeiling
		: Math.min(rightNeighborCeiling, sourceDurationCeiling);
}

/** Assemble `GroupResizeMember[]` for a set of selected element refs,
 *  computing each member's neighbor bounds from its own track while
 *  excluding every other member of the group (group members move together
 *  and must never block each other — only stationary elements do). */
export function buildGroupResizeMembers({
	tracks,
	elements,
}: {
	tracks: TimelineTrack[];
	elements: Array<{ trackId: string; elementId: string }>;
}): GroupResizeMember[] {
	const memberElementIds = new Set(elements.map((ref) => ref.elementId));
	const members: GroupResizeMember[] = [];

	for (const ref of elements) {
		const track = tracks.find((candidate) => candidate.id === ref.trackId);
		const element = track?.elements.find(
			(candidate) => candidate.id === ref.elementId,
		);
		if (!track || !element) continue;

		const otherElements = track.elements.filter(
			(candidate) => !memberElementIds.has(candidate.id),
		);
		const elementEndTime = element.startTime + element.duration;

		const rightNeighborBound = otherElements
			.filter((candidate) => candidate.startTime >= elementEndTime)
			.reduce<number | null>(
				(min, candidate) =>
					min === null
						? candidate.startTime
						: Math.min(min, candidate.startTime),
				null,
			);

		const leftNeighborBound = otherElements
			.filter(
				(candidate) =>
					candidate.startTime + candidate.duration <= element.startTime,
			)
			.reduce<number | null>((max, candidate) => {
				const candidateEnd = candidate.startTime + candidate.duration;
				return max === null ? candidateEnd : Math.max(max, candidateEnd);
			}, null);

		members.push({
			trackId: track.id,
			elementId: element.id,
			startTime: element.startTime,
			duration: element.duration,
			trimStart: element.trimStart,
			trimEnd: element.trimEnd,
			sourceDuration: element.sourceDuration,
			leftNeighborBound,
			rightNeighborBound,
		});
	}

	return members;
}

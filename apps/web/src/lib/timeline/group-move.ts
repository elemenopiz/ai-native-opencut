// Ported (loose reimplementation) from OpenCut mainline `pre-rewrite` tag
// (238750c0), MIT licensed:
//   apps/web/src/timeline/group-move/{build-group,resolve-move,snap,types}.ts
//
// Adapted from their `SceneTracks` model (separate overlay[]/main/audio[]
// sections addressed via a synthetic "display index") to our flat
// `TimelineTrack[]` array — every track lives in one ordered list, so the
// track-placement bookkeeping pre-rewrite needed (`track-placement.ts`)
// collapses to plain array indices here. `MediaTime` (integer ticks) is
// replaced with plain seconds-as-numbers throughout, matching our codebase.
//
// This powers "group move": when multiple timeline elements are selected and
// the user drags one of them (the "anchor"), the whole selection moves
// together, preserving each member's time offset from the anchor and,
// for cross-track drags, its relative track position.

import type { ElementType, TimelineTrack, TrackType } from "@/types/timeline";
import {
	buildEmptyTrack,
	canElementGoOnTrack,
	getMainTrack,
	isMainTrack,
} from "@/lib/timeline/track-utils";
import { wouldElementOverlap } from "@/lib/timeline/element-utils";
import {
	findSnapPoints,
	snapToNearestPoint,
	type SnapPoint,
} from "@/lib/timeline/snap-utils";
import { generateUUID } from "@/utils/id";

export interface ElementRef {
	trackId: string;
	elementId: string;
}

/** One member of a move group, snapshotted at drag-start. `timeOffset` is
 *  this member's `startTime` minus the anchor's `startTime` (seconds) — the
 *  invariant every resolved move preserves. `trackIndex` is this member's
 *  track's index in the `tracks` array at build time. */
export interface GroupMoveMember extends ElementRef {
	elementType: ElementType;
	duration: number;
	timeOffset: number;
	trackIndex: number;
}

export interface MoveGroup {
	anchor: GroupMoveMember;
	members: GroupMoveMember[];
}

export interface PlannedElementMove {
	sourceTrackId: string;
	targetTrackId: string;
	elementId: string;
	newStartTime: number;
}

export interface PlannedTrackCreation {
	id: string;
	type: TrackType;
	index: number;
}

export interface GroupMoveResult {
	moves: PlannedElementMove[];
	createTracks: PlannedTrackCreation[];
	targetSelection: ElementRef[];
}

/** Where the anchor is being dropped: onto an existing track (by id), or
 *  into a "new track" insertion slot (by index) — mirrors the single-element
 *  `DropTarget.isNewTrack` distinction already used by the drag hook. */
export type GroupMoveTarget =
	| { kind: "existingTrack"; targetTrackId: string }
	| { kind: "newTracks"; insertIndex: number };

/** Build a move group from the anchor (the element the user actually
 *  grabbed) plus the current selection. The anchor is always included even
 *  if the caller's `selectedElements` list omits it (matches pre-rewrite). */
export function buildMoveGroup({
	anchorRef,
	selectedElements,
	tracks,
}: {
	anchorRef: ElementRef;
	selectedElements: ElementRef[];
	tracks: TimelineTrack[];
}): MoveGroup | null {
	const anchorTrackIndex = tracks.findIndex(
		(track) => track.id === anchorRef.trackId,
	);
	const anchorTrack = tracks[anchorTrackIndex];
	const anchorElement = anchorTrack?.elements.find(
		(element) => element.id === anchorRef.elementId,
	);
	if (!anchorTrack || !anchorElement) {
		return null;
	}

	const seen = new Set<string>();
	const orderedRefs = [anchorRef, ...selectedElements].filter((ref) => {
		if (seen.has(ref.elementId)) return false;
		seen.add(ref.elementId);
		return true;
	});

	const members = orderedRefs.flatMap((ref): GroupMoveMember[] => {
		const trackIndex = tracks.findIndex((track) => track.id === ref.trackId);
		const track = tracks[trackIndex];
		const element = track?.elements.find(
			(trackElement) => trackElement.id === ref.elementId,
		);
		if (!track || !element) return [];

		return [
			{
				trackId: track.id,
				elementId: element.id,
				elementType: element.type,
				duration: element.duration,
				timeOffset: element.startTime - anchorElement.startTime,
				trackIndex,
			},
		];
	});

	if (members.length === 0) return null;

	const anchor = members.find(
		(member) =>
			member.trackId === anchorRef.trackId &&
			member.elementId === anchorRef.elementId,
	);
	if (!anchor) return null;

	return { anchor, members };
}

/** Resolve a move group's target tracks + snapped anchor start time into a
 *  concrete plan (per-member moves, any tracks that need to be created).
 *  Returns null when the drop is invalid (out-of-bounds, type-incompatible,
 *  or would overlap another element) — callers should treat that as "reject
 *  the drop", exactly like the single-element flow's `!dropTarget` guard. */
export function resolveGroupMove({
	group,
	tracks,
	anchorStartTime,
	target,
}: {
	group: MoveGroup;
	tracks: TimelineTrack[];
	anchorStartTime: number;
	target: GroupMoveTarget;
}): GroupMoveResult | null {
	if (target.kind === "newTracks") {
		return resolveNewTrackMove({
			group,
			tracks,
			anchorStartTime,
			insertIndex: target.insertIndex,
		});
	}

	return resolveExistingTrackMove({
		group,
		tracks,
		anchorStartTime,
		targetTrackId: target.targetTrackId,
	});
}

function resolveExistingTrackMove({
	group,
	tracks,
	anchorStartTime,
	targetTrackId,
}: {
	group: MoveGroup;
	tracks: TimelineTrack[];
	anchorStartTime: number;
	targetTrackId: string;
}): GroupMoveResult | null {
	const anchorTargetIndex = tracks.findIndex(
		(track) => track.id === targetTrackId,
	);
	if (anchorTargetIndex < 0) return null;

	const trackIndexDelta = anchorTargetIndex - group.anchor.trackIndex;

	const targetTrackIdByElementId = new Map<string, string>();
	for (const member of group.members) {
		const targetIndex = member.trackIndex + trackIndexDelta;
		const targetTrack = tracks[targetIndex];
		if (!targetTrack) return null;
		if (
			!canElementGoOnTrack({
				elementType: member.elementType,
				trackType: targetTrack.type,
			})
		) {
			return null;
		}
		targetTrackIdByElementId.set(member.elementId, targetTrack.id);
	}

	const clampedAnchorStartTime = clampAnchorStartTime({
		group,
		tracks,
		anchorStartTime,
		targetTrackIdByElementId,
	});

	const moves = group.members.map((member) => ({
		sourceTrackId: member.trackId,
		targetTrackId:
			targetTrackIdByElementId.get(member.elementId) ?? member.trackId,
		elementId: member.elementId,
		newStartTime: clampedAnchorStartTime + member.timeOffset,
	}));

	if (!canApplyMovesToExistingTracks({ tracks, moves })) {
		return null;
	}

	return {
		moves,
		createTracks: [],
		targetSelection: moves.map(({ elementId, targetTrackId: trackId }) => ({
			trackId,
			elementId,
		})),
	};
}

function resolveNewTrackMove({
	group,
	tracks,
	anchorStartTime,
	insertIndex,
}: {
	group: MoveGroup;
	tracks: TimelineTrack[];
	anchorStartTime: number;
	insertIndex: number;
}): GroupMoveResult | null {
	const sortedMembers = [...group.members].sort(
		(left, right) => left.trackIndex - right.trackIndex,
	);
	const anchorMemberIndex = sortedMembers.findIndex(
		(member) => member.elementId === group.anchor.elementId,
	);
	if (anchorMemberIndex < 0) return null;

	const blockStartIndex = Math.max(
		0,
		Math.min(insertIndex - anchorMemberIndex, tracks.length),
	);

	const newTrackIds = sortedMembers.map(() => generateUUID());
	const createTracks: PlannedTrackCreation[] = sortedMembers.map(
		(member, memberIndex) => ({
			id: newTrackIds[memberIndex],
			type:
				tracks[member.trackIndex]?.type ??
				inferTrackTypeForElement(member.elementType),
			index: blockStartIndex + memberIndex,
		}),
	);

	// The anchor never needs to be clamped to an existing main-track earliest
	// start here — every new track is freshly created and empty (never main).
	const minimumAnchorStartTime = getMinimumAnchorStartTime({ group });
	const clampedAnchorStartTime = Math.max(
		anchorStartTime,
		minimumAnchorStartTime,
	);

	const moves = sortedMembers.map((member, memberIndex) => ({
		sourceTrackId: member.trackId,
		targetTrackId: newTrackIds[memberIndex],
		elementId: member.elementId,
		newStartTime: clampedAnchorStartTime + member.timeOffset,
	}));

	return {
		moves,
		createTracks,
		targetSelection: moves.map(({ elementId, targetTrackId }) => ({
			trackId: targetTrackId,
			elementId,
		})),
	};
}

function inferTrackTypeForElement(elementType: ElementType): TrackType {
	if (elementType === "video" || elementType === "image") return "video";
	if (elementType === "audio") return "audio";
	if (elementType === "text") return "text";
	if (elementType === "sticker") return "sticker";
	return "effect";
}

function getMinimumAnchorStartTime({ group }: { group: MoveGroup }): number {
	return group.members.reduce((minimum, member) => {
		if (member.timeOffset < 0) {
			return Math.max(minimum, -member.timeOffset);
		}
		return minimum;
	}, 0);
}

/** Clamp the anchor's requested start time so no member goes negative, and
 *  so the main track (if a member lands on it) still starts at exactly 0
 *  when it would otherwise become the new earliest element — mirroring
 *  `enforceMainTrackStart`, generalized to whichever group member (if any)
 *  targets the main track. */
function clampAnchorStartTime({
	group,
	tracks,
	anchorStartTime,
	targetTrackIdByElementId,
}: {
	group: MoveGroup;
	tracks: TimelineTrack[];
	anchorStartTime: number;
	targetTrackIdByElementId: Map<string, string>;
}): number {
	const minimumAnchorStartTime = getMinimumAnchorStartTime({ group });
	let clamped = Math.max(anchorStartTime, minimumAnchorStartTime);

	const mainTrack = getMainTrack({ tracks });
	if (!mainTrack) return clamped;

	const memberOnMain = group.members.find(
		(member) =>
			(targetTrackIdByElementId.get(member.elementId) ?? member.trackId) ===
			mainTrack.id,
	);
	if (!memberOnMain) return clamped;

	const movingElementIds = new Set(
		group.members.map((member) => member.elementId),
	);
	const requestedMainStartTime = clamped + memberOnMain.timeOffset;
	const earliestStationaryStartTime = mainTrack.elements
		.filter((element) => !movingElementIds.has(element.id))
		.reduce<number | null>((earliest, element) => {
			if (earliest === null || element.startTime < earliest)
				return element.startTime;
			return earliest;
		}, null);

	if (
		earliestStationaryStartTime === null ||
		requestedMainStartTime <= earliestStationaryStartTime
	) {
		clamped = Math.max(minimumAnchorStartTime, -memberOnMain.timeOffset);
	}

	return clamped;
}

function canApplyMovesToExistingTracks({
	tracks,
	moves,
}: {
	tracks: TimelineTrack[];
	moves: PlannedElementMove[];
}): boolean {
	const movingElementIds = new Set(moves.map((move) => move.elementId));
	const durationByElementId = new Map<string, number>();
	for (const track of tracks) {
		for (const element of track.elements) {
			durationByElementId.set(element.id, element.duration);
		}
	}

	const movesByTargetTrackId = new Map<string, PlannedElementMove[]>();
	for (const move of moves) {
		const existing = movesByTargetTrackId.get(move.targetTrackId) ?? [];
		existing.push(move);
		movesByTargetTrackId.set(move.targetTrackId, existing);
	}

	for (const [targetTrackId, targetMoves] of movesByTargetTrackId) {
		const targetTrack = tracks.find((track) => track.id === targetTrackId);
		if (!targetTrack) return false;

		const timeSpans = targetMoves.map((move) => ({
			startTime: move.newStartTime,
			duration: durationByElementId.get(move.elementId) ?? 0,
		}));
		if (hasOverlappingTimeSpans({ timeSpans })) return false;

		const stationaryElements = targetTrack.elements.filter(
			(element) => !movingElementIds.has(element.id),
		);
		for (const span of timeSpans) {
			if (
				wouldElementOverlap({
					elements: stationaryElements,
					startTime: span.startTime,
					endTime: span.startTime + span.duration,
				})
			) {
				return false;
			}
		}
	}

	return true;
}

function hasOverlappingTimeSpans({
	timeSpans,
}: {
	timeSpans: Array<{ startTime: number; duration: number }>;
}): boolean {
	const sorted = [...timeSpans].sort(
		(left, right) => left.startTime - right.startTime,
	);
	for (let index = 1; index < sorted.length; index += 1) {
		const previous = sorted[index - 1];
		const current = sorted[index];
		if (previous.startTime + previous.duration > current.startTime) {
			return true;
		}
	}
	return false;
}

/** Snap the anchor's requested start time against every other element's
 *  edges (and the playhead), trying each group member's start/end edge in
 *  turn and picking whichever snap is closest — so the whole group snaps as
 *  a unit, not just the anchor. Group members themselves are excluded from
 *  the snap-point set (a clip shouldn't snap to its own sibling). */
export function snapGroupEdges({
	group,
	anchorStartTime,
	tracks,
	playheadTime,
	zoomLevel,
}: {
	group: MoveGroup;
	anchorStartTime: number;
	tracks: TimelineTrack[];
	playheadTime: number;
	zoomLevel: number;
}): {
	snappedAnchorStartTime: number;
	snapPoint: SnapPoint | null;
} {
	const memberElementIds = new Set(
		group.members.map((member) => member.elementId),
	);
	const allSnapPoints = findSnapPoints({ tracks, playheadTime }).filter(
		(point) => !point.elementId || !memberElementIds.has(point.elementId),
	);

	let closestSnapDistance = Infinity;
	let snappedAnchorStartTime = anchorStartTime;
	let snapPoint: SnapPoint | null = null;

	for (const member of group.members) {
		const memberStartTime = anchorStartTime + member.timeOffset;

		const startSnap = snapToNearestPoint({
			targetTime: memberStartTime,
			snapPoints: allSnapPoints,
			zoomLevel,
		});
		if (startSnap.snapPoint && startSnap.snapDistance < closestSnapDistance) {
			closestSnapDistance = startSnap.snapDistance;
			snappedAnchorStartTime = startSnap.snappedTime - member.timeOffset;
			snapPoint = startSnap.snapPoint;
		}

		const endSnap = snapToNearestPoint({
			targetTime: memberStartTime + member.duration,
			snapPoints: allSnapPoints,
			zoomLevel,
		});
		if (endSnap.snapPoint && endSnap.snapDistance < closestSnapDistance) {
			closestSnapDistance = endSnap.snapDistance;
			snappedAnchorStartTime =
				endSnap.snappedTime - member.duration - member.timeOffset;
			snapPoint = endSnap.snapPoint;
		}
	}

	return { snappedAnchorStartTime, snapPoint };
}

/** Apply a resolved `GroupMoveResult` to a tracks array, producing the next
 *  tracks state. Pure — the caller (a `Command`) is responsible for
 *  snapshotting `tracks` for undo. */
export function applyGroupMoveResult({
	tracks,
	result,
}: {
	tracks: TimelineTrack[];
	result: GroupMoveResult;
}): TimelineTrack[] {
	let workingTracks = [...tracks];

	const sortedCreations = [...result.createTracks].sort(
		(a, b) => a.index - b.index,
	);
	for (const creation of sortedCreations) {
		const newTrack = buildEmptyTrack({ id: creation.id, type: creation.type });
		const insertIndex = Math.max(
			0,
			Math.min(creation.index, workingTracks.length),
		);
		workingTracks = [
			...workingTracks.slice(0, insertIndex),
			newTrack,
			...workingTracks.slice(insertIndex),
		];
	}

	const originalElementById = new Map<
		string,
		TimelineTrack["elements"][number]
	>();
	for (const track of workingTracks) {
		for (const element of track.elements) {
			originalElementById.set(element.id, element);
		}
	}

	const moveByElementId = new Map(
		result.moves.map((move) => [move.elementId, move]),
	);
	const sourceTrackIds = new Set(
		result.moves.map((move) => move.sourceTrackId),
	);

	workingTracks = workingTracks.map(
		(track) =>
			({
				...track,
				elements: track.elements.filter(
					(element) => !moveByElementId.has(element.id),
				),
			}) as TimelineTrack,
	);

	workingTracks = workingTracks.map((track) => {
		const incoming = result.moves.filter(
			(move) => move.targetTrackId === track.id,
		);
		if (incoming.length === 0) return track;

		const newElements = incoming
			.map((move) => {
				const original = originalElementById.get(move.elementId);
				if (!original) return null;
				return { ...original, startTime: move.newStartTime };
			})
			.filter(
				(element): element is NonNullable<typeof element> => element !== null,
			);

		return {
			...track,
			elements: [...track.elements, ...newElements],
		} as TimelineTrack;
	});

	workingTracks = workingTracks.filter(
		(track) =>
			track.elements.length > 0 ||
			isMainTrack(track) ||
			!sourceTrackIds.has(track.id),
	);

	return workingTracks;
}

/**
 * Auto-cut APPLY layer — turn an engine {@link EditSegment}[] into real
 * timeline edits. This is the one file under `lib/auto-cut/` the timeline/UI
 * worktree owns; everything else here is the analysis engine's contract.
 *
 * The engine reports edits in SOURCE-relative seconds (relative to the media
 * file, ignoring trims). This layer:
 *   1. intersects those segments with the element's VISIBLE source window
 *      `[trimStart, sourceDuration - trimEnd]`,
 *   2. maps kept source spans to timeline seconds via the codebase's 1:1
 *      trim model (timeline second = startTime + (srcSecond - trimStart)),
 *   3. carves the element into the kept pieces (packed back-to-back from the
 *      element's original start) and ripple-closes the removed gaps so every
 *      downstream element on the track slides left, then
 *   4. commits the whole thing as ONE undoable {@link TracksSnapshotCommand}.
 *
 * SPEED segments (`silentAction: "speed"`) are DOWNGRADED to "keep" in v1: the
 * timeline trim model is strictly 1:1 source↔timeline seconds (see
 * `computeRippleTrim` / `SplitElementsCommand`), with `playbackRate` a separate
 * render-only field that scene-builder applies to VIDEO only. Compressing a
 * silent piece's timeline footprint via speed would break the
 * duration == source-span invariant the ripple/resize math depends on — i.e.
 * new playback plumbing, out of scope. v1 ships the audio-only hard cut.
 */

import type { EditorCore } from "@/core";
import { TracksSnapshotCommand } from "@/lib/commands/timeline";
import { rippleShiftElements } from "@/lib/timeline";
import type { TimelineElement, TimelineTrack } from "@/types/timeline";
import { generateUUID } from "@/utils/id";
import type { EditSegment } from "./types";

/** Sub-second slop used for boundary/no-op comparisons (matches ripple-utils). */
const EPSILON = 1e-4;

/** Outcome of applying an edit list, for toasts / Director narration. */
export interface AutoCutApplySummary {
	/** Number of distinct silent gaps removed from the element's visible span. */
	removedCount: number;
	/** Total seconds removed from the timeline (gaps closed by ripple). */
	removedSeconds: number;
	/** How silence was handled. v1 always hard-cuts (see file header). */
	appliedAs: "cut" | "speed";
}

/** The functional result of {@link planAutoCut}: new tracks + a summary. */
export interface AutoCutPlan {
	tracks: TimelineTrack[];
	summary: AutoCutApplySummary;
}

/** The full source duration a trim window is measured against. */
function sourceDurationOf(element: TimelineElement): number {
	return (
		element.sourceDuration ??
		element.trimStart + element.duration + element.trimEnd
	);
}

/**
 * PURE core: compute the post-cut tracks + summary for one element, without
 * touching the editor. Returns `null` when the element isn't found. Kept spans
 * are packed back-to-back from the element's original start; downstream
 * elements on the same track are ripple-shifted left by the removed total.
 *
 * Unit-testable with synthetic tracks and a mocked segment list — never calls
 * the analysis engine.
 */
export function planAutoCut({
	tracks,
	elementId,
	segments,
}: {
	tracks: TimelineTrack[];
	elementId: string;
	segments: EditSegment[];
}): AutoCutPlan | null {
	let trackIndex = -1;
	let element: TimelineElement | undefined;
	for (let i = 0; i < tracks.length; i++) {
		const found = tracks[i].elements.find((e) => e.id === elementId);
		if (found) {
			trackIndex = i;
			element = found;
			break;
		}
	}
	if (!element || trackIndex === -1) return null;

	const sourceDuration = sourceDurationOf(element);
	const visStart = element.trimStart;
	const visEnd = sourceDuration - element.trimEnd;
	const visibleDuration = Math.max(0, visEnd - visStart);

	// Kept source spans = every non-cut segment (speed downgraded to keep),
	// clamped to the visible window. Segments outside the window contribute
	// nothing, so a media edit entirely before/after the trim is a no-op.
	const keptRaw: Array<[number, number]> = [];
	for (const seg of segments) {
		if (seg.action.type === "cut") continue;
		const start = Math.max(seg.start, visStart);
		const end = Math.min(seg.end, visEnd);
		if (end - start > EPSILON) keptRaw.push([start, end]);
	}
	keptRaw.sort((a, b) => a[0] - b[0]);

	// Merge touching / overlapping kept spans so adjacent keeps don't create a
	// pointless split boundary.
	const kept: Array<[number, number]> = [];
	for (const [start, end] of keptRaw) {
		const last = kept[kept.length - 1];
		if (last && start - last[1] <= EPSILON) {
			last[1] = Math.max(last[1], end);
		} else {
			kept.push([start, end]);
		}
	}

	const keptTotal = kept.reduce((sum, [s, e]) => sum + (e - s), 0);
	const removedSeconds = Math.max(0, visibleDuration - keptTotal);

	// A "removed gap" is any stretch of the visible window not covered by a kept
	// span: a leading gap, gaps between kept spans, and a trailing gap.
	let removedCount = 0;
	let cursorSrc = visStart;
	for (const [start, end] of kept) {
		if (start - cursorSrc > EPSILON) removedCount++;
		cursorSrc = end;
	}
	if (visEnd - cursorSrc > EPSILON) removedCount++;
	if (kept.length === 0 && visibleDuration > EPSILON) removedCount = 1;

	const summary: AutoCutApplySummary = {
		removedCount,
		removedSeconds,
		appliedAs: "cut",
	};

	// Carve the element into its kept pieces, packed from its original start.
	// The first piece keeps the element's id (selection / provenance continuity);
	// later pieces get fresh ids (mirrors SplitElementsCommand's right side).
	const originalEnd = element.startTime + element.duration;
	const pieces: TimelineElement[] = [];
	let cursorTimeline = element.startTime;
	let first = true;
	for (const [start, end] of kept) {
		const pieceDuration = end - start;
		pieces.push({
			...element,
			id: first ? element.id : generateUUID(),
			startTime: cursorTimeline,
			duration: pieceDuration,
			trimStart: start,
			trimEnd: sourceDuration - end,
		} as TimelineElement);
		cursorTimeline += pieceDuration;
		first = false;
	}

	const updatedTracks = tracks.map((track, i) => {
		if (i !== trackIndex) return track;

		let elements: TimelineElement[] = [];
		for (const el of track.elements) {
			if (el.id === elementId) {
				elements.push(...pieces);
			} else {
				elements.push(el);
			}
		}

		// Close the removed time: everything that started at/after the element's
		// original end slides left by the removed total. Kept pieces all start
		// strictly before `originalEnd - EPSILON`, so they are never shifted.
		if (removedSeconds > EPSILON) {
			elements = rippleShiftElements({
				elements,
				afterTime: originalEnd - EPSILON,
				shiftAmount: removedSeconds,
			});
		}

		return { ...track, elements } as typeof track;
	});

	return { tracks: updatedTracks, summary };
}

/**
 * Apply an engine edit list to a timeline element through the editor, as a
 * SINGLE undoable step. Returns the summary, or `null` when the element no
 * longer exists. A no-op edit (nothing removed) makes no history entry.
 *
 * Single-undo is achieved by committing the functionally-computed
 * before/after tracks as one {@link TracksSnapshotCommand} on the command
 * stack — undo restores the exact prior tracks in one pop.
 */
export function applyAutoCut({
	editor,
	elementId,
	segments,
}: {
	editor: EditorCore;
	elementId: string;
	segments: EditSegment[];
}): AutoCutApplySummary | null {
	const before = editor.timeline.getTracks();
	const plan = planAutoCut({ tracks: before, elementId, segments });
	if (!plan) return null;

	// Nothing to remove ⇒ don't pollute the undo stack.
	if (
		plan.summary.removedSeconds <= EPSILON ||
		plan.summary.removedCount === 0
	) {
		return plan.summary;
	}

	editor.command.execute({
		command: new TracksSnapshotCommand(before, plan.tracks),
	});
	return plan.summary;
}

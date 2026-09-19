/**
 * Transcript ↔ timeline timebase conversion.
 *
 * THE RULE (see `audio-sync-utils.ts` for the element-level primitives):
 *
 *  - A transcription backend returns segment/word times in ASSET-RELATIVE
 *    seconds — measured from the start of the media FILE. This is the same
 *    timebase as an element's `trimStart`/`trimEnd`.
 *  - Every timeline operation (split, cut, seek, element `startTime`) is in
 *    TIMELINE-ABSOLUTE seconds — measured from the start of the project.
 *  - Converting between them needs the owning element's placement:
 *    `timelineTime = assetTime + (element.startTime - element.trimStart)`.
 *
 * `useTranscriptStore` holds TIMELINE-ABSOLUTE times. That is the contract the
 * renderer (`services/renderer/nodes/text-node.ts` matches segment times
 * against element `startTime`), the subtitle-track builder, and the
 * text-timeline bridge all already assume — so every ingest path MUST convert
 * raw backend output before writing it into the store. `attachProvenance`
 * records where those times came from so an operation performed LATER (after
 * the user trims or moves the clip) can recover the asset-relative range and
 * re-project it onto wherever the footage actually sits now.
 *
 * One asset can back SEVERAL timeline elements (a split leaves N pieces), so an
 * asset range maps to zero, one, or many timeline ranges — hence
 * `resolveAssetRangeToTimelineRanges` returns an array, and an empty array is a
 * meaningful answer: that part of the asset is not on the timeline at all.
 */

import type { TimelineElement, TimelineTrack } from "@/types/timeline";
import type { TranscriptionSegment } from "@/types/ai";
import {
	mergeRanges,
	sourceRangeToTimelineRange,
	type TimeRange,
} from "./audio-sync-utils";

export type { TimeRange };

/**
 * Where this element places asset time 0 on the timeline. Equivalent to the
 * `startTime - trimStart` offset `sourceTimeToTimeline` applies; negative when
 * a clip is trimmed further in than it is pushed right (i.e. the head of the
 * asset would fall before t=0).
 */
export function timelineOffsetForElement(
	element: Pick<TimelineElement, "startTime" | "trimStart">,
): number {
	return element.startTime - element.trimStart;
}

/** Every element across all tracks backed by `mediaId`, in timeline order. */
export function elementsForMedia({
	tracks,
	mediaId,
}: {
	tracks: TimelineTrack[];
	mediaId: string;
}): TimelineElement[] {
	const out: TimelineElement[] = [];
	for (const track of tracks) {
		for (const element of track.elements) {
			if ((element as { mediaId?: string }).mediaId === mediaId) {
				out.push(element);
			}
		}
	}
	return out.sort((a, b) => a.startTime - b.startTime);
}

/**
 * Timeline position of asset time 0, taken from the EARLIEST-placed clip of
 * that asset. This is the ingest-time normalization offset: it reproduces the
 * "whole file laid down once" reading that transcript display times want, and
 * stays correct when a later transcribe finds the asset already split into
 * several pieces. Returns `null` when the asset isn't on the timeline.
 */
export function ingestOffsetForMedia({
	tracks,
	mediaId,
}: {
	tracks: TimelineTrack[];
	mediaId: string;
}): number | null {
	let best: number | null = null;
	for (const element of elementsForMedia({ tracks, mediaId })) {
		const offset = timelineOffsetForElement(element);
		if (best === null || offset < best) best = offset;
	}
	return best;
}

/**
 * Project an ASSET-RELATIVE range onto the TIMELINE through every element that
 * currently shows `mediaId`, clamped to each element's visible trim window and
 * merged.
 *
 * Returns `[]` when no part of the range is on the timeline — the asset was
 * removed, or that stretch of it is trimmed away. Callers must treat `[]` as a
 * real answer ("nothing to cut"), not as "cut everything".
 */
export function resolveAssetRangeToTimelineRanges({
	tracks,
	mediaId,
	range,
}: {
	tracks: TimelineTrack[];
	mediaId: string;
	range: TimeRange;
}): TimeRange[] {
	if (!(range.end > range.start)) return [];
	const projected: TimeRange[] = [];
	for (const element of elementsForMedia({ tracks, mediaId })) {
		const timelineRange = sourceRangeToTimelineRange({ element, range });
		if (timelineRange) projected.push(timelineRange);
	}
	return mergeRanges(projected);
}

/**
 * Project a single ASSET-RELATIVE instant onto the TIMELINE through every
 * element showing `mediaId`, keeping only the elements whose visible trim
 * window actually contains it.
 *
 * Returns `[]` when that instant isn't on the timeline. Used for split points,
 * where one asset boundary can legitimately fall inside several clips (the
 * same footage placed twice) or none (trimmed away).
 */
export function resolveAssetTimeToTimelineTimes({
	tracks,
	mediaId,
	assetTime,
}: {
	tracks: TimelineTrack[];
	mediaId: string;
	assetTime: number;
}): number[] {
	const out: number[] = [];
	for (const element of elementsForMedia({ tracks, mediaId })) {
		const visibleStart = element.trimStart;
		const visibleEnd = element.trimStart + element.duration;
		if (assetTime <= visibleStart || assetTime >= visibleEnd) continue;
		out.push(assetTime + timelineOffsetForElement(element));
	}
	return out;
}

/**
 * Normalize raw backend segments (ASSET-RELATIVE) into the store's
 * TIMELINE-ABSOLUTE contract, stamping each segment with the provenance needed
 * to re-resolve it later.
 *
 * `offsetSeconds` is normally `ingestOffsetForMedia`; pass 0 only when the
 * asset genuinely starts at timeline 0 untrimmed.
 */
export function toTimelineSegments({
	segments,
	offsetSeconds,
	mediaId,
}: {
	segments: TranscriptionSegment[];
	offsetSeconds: number;
	mediaId?: string;
}): TranscriptionSegment[] {
	return segments.map((seg) => ({
		...seg,
		start: seg.start + offsetSeconds,
		end: seg.end + offsetSeconds,
		words: (seg.words ?? []).map((w) => ({
			...w,
			start: w.start + offsetSeconds,
			end: w.end + offsetSeconds,
		})),
		...(mediaId ? { mediaId } : {}),
		sourceStart: seg.start,
		sourceEnd: seg.end,
	}));
}

/** Overlap of two ranges, or `null` when they don't intersect. */
function intersect(a: TimeRange, b: TimeRange): TimeRange | null {
	const start = Math.max(a.start, b.start);
	const end = Math.min(a.end, b.end);
	return end > start ? { start, end } : null;
}

/** `range` minus every part covered by `holes` (which need not be sorted). */
function subtract(range: TimeRange, holes: TimeRange[]): TimeRange[] {
	let remaining: TimeRange[] = [range];
	for (const hole of mergeRanges(holes)) {
		const next: TimeRange[] = [];
		for (const piece of remaining) {
			if (hole.end <= piece.start || hole.start >= piece.end) {
				next.push(piece);
				continue;
			}
			if (hole.start > piece.start)
				next.push({ start: piece.start, end: hole.start });
			if (hole.end < piece.end) next.push({ start: hole.end, end: piece.end });
		}
		remaining = next;
	}
	return remaining;
}

export interface ResolvedTranscriptCuts {
	/** TIMELINE ranges to actually cut — merged, sorted, ready for the timeline. */
	ranges: TimeRange[];
	/**
	 * Requested pieces whose footage is no longer anywhere on the timeline
	 * (trimmed away or deleted). Non-empty means part of what the user asked to
	 * remove could not be removed — say so rather than silently doing nothing.
	 */
	dropped: TimeRange[];
}

/**
 * Re-project cut ranges expressed in STORE time onto the LIVE timeline.
 *
 * The panel computes cuts straight from stored segment/word times, which were
 * correct for the clip layout at ingest. Between then and now the user may have
 * trimmed, moved, or split the clip — so for every piece of a requested cut
 * that a provenance-carrying segment covers, we recover the ASSET-RELATIVE
 * range and project it back onto every element still showing that asset. One
 * sentence can therefore map to several timeline ranges (asset split into
 * pieces) or to none (that stretch trimmed away).
 *
 * Pieces not covered by any provenance-carrying segment pass through unchanged:
 * segments from older projects have no provenance to resolve, and their stored
 * times are the best information available.
 */
export function resolveTranscriptCuts({
	tracks,
	segments,
	cuts,
}: {
	tracks: TimelineTrack[];
	segments: TranscriptionSegment[];
	cuts: TimeRange[];
}): ResolvedTranscriptCuts {
	const resolved: TimeRange[] = [];
	const dropped: TimeRange[] = [];
	const traceable = segments.filter(
		(seg) => seg.mediaId != null && seg.sourceStart != null,
	);

	for (const cut of cuts) {
		if (!(cut.end > cut.start)) continue;
		const covered: TimeRange[] = [];

		for (const seg of traceable) {
			const piece = intersect(cut, { start: seg.start, end: seg.end });
			if (!piece) continue;
			covered.push(piece);

			const assetRange = timelineRangeToAssetRange({
				segment: seg,
				range: piece,
			});
			if (!assetRange) continue;
			const projected = resolveAssetRangeToTimelineRanges({
				tracks,
				// biome-ignore lint/style/noNonNullAssertion: filtered above.
				mediaId: seg.mediaId!,
				range: assetRange,
			});
			if (projected.length === 0) dropped.push(piece);
			else resolved.push(...projected);
		}

		// Anything no traceable segment claims keeps its stored timing.
		resolved.push(...subtract(cut, covered));
	}

	return { ranges: mergeRanges(resolved), dropped: mergeRanges(dropped) };
}

/**
 * TIMELINE times at which to split so each transcript segment lands on its own
 * clip. Segment boundaries are resolved through the owning asset's placement,
 * so a boundary inside a clip that was moved or trimmed still lands on the
 * right frame — and one boundary can produce several split points when the same
 * asset appears more than once.
 *
 * The outermost boundaries of each asset are naturally excluded: a split point
 * exactly at a clip's visible edge is a no-op, and
 * `resolveAssetTimeToTimelineTimes` only keeps instants strictly inside a
 * clip's visible window.
 */
export function computeTranscriptSplitPoints({
	tracks,
	segments,
}: {
	tracks: TimelineTrack[];
	segments: TranscriptionSegment[];
}): number[] {
	const points = new Set<number>();
	for (const seg of segments) {
		const mediaId = seg.mediaId;
		if (mediaId == null || seg.sourceStart == null || seg.sourceEnd == null) {
			continue;
		}
		for (const assetTime of [seg.sourceStart, seg.sourceEnd]) {
			for (const time of resolveAssetTimeToTimelineTimes({
				tracks,
				mediaId,
				assetTime,
			})) {
				points.add(time);
			}
		}
	}
	return [...points].sort((a, b) => a - b);
}

/**
 * Recover the asset-relative range behind a TIMELINE range that was derived
 * from `segment`'s stored times.
 *
 * Word-level cuts inherit the segment's offset (the whole segment was shifted
 * by one constant at ingest), so this works for a sub-range of the segment too.
 * Returns `null` when the segment carries no provenance — an older project, or
 * a segment whose times were rewritten by a path that doesn't record it.
 */
export function timelineRangeToAssetRange({
	segment,
	range,
}: {
	segment: TranscriptionSegment;
	range: TimeRange;
}): TimeRange | null {
	if (segment.sourceStart == null) return null;
	const offset = segment.start - segment.sourceStart;
	return { start: range.start - offset, end: range.end - offset };
}

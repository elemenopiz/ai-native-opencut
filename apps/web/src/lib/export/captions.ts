// Collect subtitle cues (timeline time, seconds) for local SRT/VTT export.
//
// Fully client-side — no aiClient / ai-backend round-trip. Two sources, tried
// in this precedence order:
//
//  (a) "timeline": subtitle/caption text elements already on the timeline —
//      the tracks created by `addSubtitleTrack` (Add subtitles / Add
//      language) and `insertSubtitleCuesAsTextTrack` (Import subtitles) in
//      captions.tsx. What renders on the timeline is the source of truth, and
//      for text elements `startTime` IS timeline time already — no mapping
//      needed. Both call sites name their tracks with a "Subs:" prefix; there
//      is no dedicated schema field marking a text track as caption-derived
//      (TextTrack/TextElement carry no such discriminator — see
//      apps/web/src/types/timeline.ts), so the name prefix is the only signal
//      available without inventing a schema change.
//
//  (b) "transcript": falls back to the transcript store's segments, mapped
//      from asset-relative time to timeline time through the timeline media
//      element(s) that reference the transcribed asset.
//
//      LIMITATION: `TranscriptionSegment` (apps/web/src/types/ai.ts) and the
//      transcript store (apps/web/src/stores/transcript-store.ts) do not
//      record which media asset was transcribed — `segments` is a single flat
//      array for the whole project with no mediaId/assetId field. There is no
//      way to recover the exact linkage without a schema change, which is out
//      of scope here. We fall back to the FIRST video/audio element found on
//      the timeline (by track order), matching the same first-media-wins
//      heuristic `handleGenerateTranscript` already uses in captions.tsx when
//      picking a file to send for transcription — so in the common case
//      (single source clip) this is exactly right; with multiple unrelated
//      clips it may pick the wrong one, which is called out to the user via
//      the returned `source` discriminator.
//
//      Once a reference asset is identified, every on-timeline occurrence of
//      that asset (every element whose mediaId matches, across every
//      video/audio track) gets its own set of cues: each transcript segment
//      is clipped to that element's trimmed window
//      [trimStart, trimStart + duration) and mapped via
//      timelineT = element.startTime + (assetRelativeT - element.trimStart).
//      Segments wholly outside an element's window are dropped for that
//      element; segments straddling the window boundary are clipped to it.

import type { TranscriptionSegment } from "@/types/ai";
import type { MediaAsset } from "@/types/assets";
import type {
	AudioElement,
	TimelineTrack,
	VideoElement,
} from "@/types/timeline";
import { hasMediaId } from "@/lib/timeline";
import type { SubtitleCue } from "@/lib/subtitles/types";

/** Track-name prefix used by both subtitle-import and Add-subtitles flows
 *  (see addSubtitleTrack / insertSubtitleCuesAsTextTrack in captions.tsx). */
const SUBTITLE_TRACK_NAME_PREFIX = "Subs:";

export interface CollectCaptionCuesParams {
	tracks: TimelineTrack[];
	transcriptSegments: TranscriptionSegment[];
	mediaAssets: MediaAsset[];
}

export interface CollectCaptionCuesResult {
	cues: SubtitleCue[];
	/** Which source produced the cues, so the UI can tell the user. */
	source: "timeline" | "transcript";
}

export function collectCaptionCues({
	tracks,
	transcriptSegments,
	mediaAssets,
}: CollectCaptionCuesParams): CollectCaptionCuesResult {
	const timelineCues = collectFromSubtitleTextTracks({ tracks });
	if (timelineCues.length > 0) {
		return { cues: sortByStart(timelineCues), source: "timeline" };
	}

	const transcriptCues = collectFromTranscript({
		tracks,
		transcriptSegments,
		mediaAssets,
	});
	return { cues: sortByStart(transcriptCues), source: "transcript" };
}

function sortByStart(cues: SubtitleCue[]): SubtitleCue[] {
	return [...cues].sort((a, b) => a.startTime - b.startTime);
}

// ── (a) Timeline text-element source ────────────────────────────────────────

function collectFromSubtitleTextTracks({
	tracks,
}: {
	tracks: TimelineTrack[];
}): SubtitleCue[] {
	const cues: SubtitleCue[] = [];

	for (const track of tracks) {
		if (track.type !== "text") continue;
		if (!track.name.startsWith(SUBTITLE_TRACK_NAME_PREFIX)) continue;

		for (const element of track.elements) {
			// Text elements are already in timeline time — no mapping needed.
			cues.push({
				text: element.content,
				startTime: element.startTime,
				duration: element.duration,
			});
		}
	}

	return cues;
}

// ── (b) Transcript-store fallback, mapped through a timeline element ───────

type ReferencableMediaElement = (VideoElement | AudioElement) & {
	mediaId: string;
};

function isMediaTrack(
	track: TimelineTrack,
): track is Extract<TimelineTrack, { type: "video" | "audio" }> {
	return track.type === "video" || track.type === "audio";
}

/** Video/audio elements with a mediaId, in track order — mirrors the search
 *  `handleGenerateTranscript` does in captions.tsx when finding a file to
 *  transcribe. */
function findMediaElementsInOrder({
	tracks,
}: {
	tracks: TimelineTrack[];
}): ReferencableMediaElement[] {
	const found: ReferencableMediaElement[] = [];
	for (const track of tracks) {
		if (!isMediaTrack(track)) continue;
		for (const element of track.elements) {
			// Narrow to video/audio first (a video track's elements can also be
			// ImageElement, which is excluded — images were never transcribed).
			if (element.type !== "video" && element.type !== "audio") continue;
			if (!hasMediaId(element)) continue; // e.g. LibraryAudioElement
			found.push(element);
		}
	}
	return found;
}

function clipSegmentToElement({
	segment,
	element,
}: {
	segment: TranscriptionSegment;
	element: ReferencableMediaElement;
}): SubtitleCue | null {
	// Asset-relative window this element exposes on the timeline.
	const windowStart = element.trimStart;
	const windowEnd = element.trimStart + element.duration;

	const clippedStart = Math.max(segment.start, windowStart);
	const clippedEnd = Math.min(segment.end, windowEnd);

	if (clippedEnd <= clippedStart) {
		// Wholly outside the element's trimmed window.
		return null;
	}

	const timelineStart = element.startTime + (clippedStart - element.trimStart);
	const timelineDuration = clippedEnd - clippedStart;

	return {
		text: segment.text,
		startTime: timelineStart,
		duration: timelineDuration,
	};
}

function collectFromTranscript({
	tracks,
	transcriptSegments,
	mediaAssets,
}: {
	tracks: TimelineTrack[];
	transcriptSegments: TranscriptionSegment[];
	mediaAssets: MediaAsset[];
}): SubtitleCue[] {
	if (transcriptSegments.length === 0) return [];

	const mediaElements = findMediaElementsInOrder({ tracks });
	if (mediaElements.length === 0) return [];

	// Defensive: ignore elements whose mediaId no longer resolves to a real
	// asset (e.g. the asset was deleted but the element wasn't cleaned up).
	const knownAssetIds = new Set(mediaAssets.map((asset) => asset.id));
	const resolvableElements = mediaElements.filter((el) =>
		knownAssetIds.has(el.mediaId),
	);
	const candidates =
		resolvableElements.length > 0 ? resolvableElements : mediaElements;

	// See the LIMITATION note at the top of this file: we cannot know which
	// asset the transcript actually belongs to, so we take the first
	// video/audio element as the reference and emit a cue set for every
	// on-timeline occurrence of that same asset.
	const referenceMediaId = candidates[0].mediaId;
	const occurrences = candidates.filter(
		(el) => el.mediaId === referenceMediaId,
	);

	const cues: SubtitleCue[] = [];
	for (const element of occurrences) {
		for (const segment of transcriptSegments) {
			const cue = clipSegmentToElement({ segment, element });
			if (cue) cues.push(cue);
		}
	}
	return cues;
}

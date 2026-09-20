"use client";

import { useCallback } from "react";
import { useEditor } from "@/hooks/use-editor";
import { useTranscriptStore } from "@/stores/transcript-store";
import { useTranscription } from "@/hooks/use-transcription";
import { useAIStatus } from "@/hooks/use-ai-status";
import { getElementsAtTime, hasMediaId } from "@/lib/timeline";
import type { TimeRange } from "@/lib/text-timeline-sync";
import {
	computeTranscriptSplitPoints,
	ingestOffsetForMedia,
	resolveTranscriptCuts,
	toTimelineSegments,
} from "@/lib/timeline/transcript-timebase";
import type { TranscriptWord } from "@/components/editor/ai/transcription-panel";
import type { TimelineElement } from "@/types/timeline";
import type { TranscriptionSegment } from "@/types/ai";
import {
	captureTranscriptSnapshot,
	hasTranscriptChanged,
	TranscriptSnapshotCommand,
} from "@/lib/commands/transcript";
import { toast } from "sonner";

/**
 * Developer-only pointer for a transcription backend that isn't reachable.
 * Returns "" in production so no customer ever sees infrastructure names —
 * mirrors `views/director.tsx`'s `relayDevHint`.
 */
function transcriptionSetupHint(): string {
	return process.env.NODE_ENV !== "production"
		? "Dev: no AI backend reachable — on-device Whisper needs a Chromium-based browser, or start the self-hosted backend."
		: "";
}

/**
 * Bridges text-based editing operations to the actual video timeline.
 *
 * When a user deletes text segments, marks words for removal, or reorders
 * paragraphs in the transcription panel, this hook translates those
 * operations into timeline splits and deletions via EditorCore.
 *
 * ── Timebase ──
 * Transcript segments live in `useTranscriptStore` in TIMELINE-ABSOLUTE
 * seconds (see that store's contract and `lib/timeline/transcript-timebase.ts`).
 * The panel derives cut ranges straight from those stored times, so they are
 * only as fresh as the clip layout at the moment of transcription. Before
 * touching the timeline we re-project every cut through the owning element's
 * `startTime - trimStart` offset — the same conversion the Director does in
 * `gatherSpeechIntervals` — so cuts stay correct on clips that were trimmed,
 * moved, or split afterwards.
 *
 * ── When a cut has nowhere to land ──
 * One asset can back several timeline elements, so a sentence may map to
 * several timeline ranges — or to none, if that stretch of footage has since
 * been trimmed away or deleted. The policy:
 *  - Some of the request resolves → cut exactly the parts that exist, and tell
 *    the user the rest was already gone.
 *  - None of it resolves → change NOTHING (timeline or transcript) and say so.
 *    Deleting the transcript line while the video keeps playing that sentence
 *    would desync the two, and silently doing nothing would look like a broken
 *    button.
 */
export function useTextTimelineBridge() {
	const editor = useEditor();
	const { transcribeVideo, isTranscribing, progress, error } =
		useTranscription();
	const { isConnected } = useAIStatus();

	const segments = useTranscriptStore((s) => s.segments);

	/**
	 * Split the video timeline at each transcription segment boundary
	 * so every segment maps to its own clip on the timeline.
	 *
	 * Segment boundaries are ASSET-RELATIVE, so they are resolved through each
	 * clip's `startTime - trimStart` placement before being used as timeline
	 * split points — a boundary inside a trimmed or repositioned clip still
	 * lands on the right frame, and one that has been trimmed away produces no
	 * split at all.
	 */
	const splitTimelineAtSegmentBoundaries = useCallback(
		(segments: TranscriptionSegment[]) => {
			const splitPoints = computeTranscriptSplitPoints({
				tracks: editor.timeline.getTracks(),
				segments,
			});

			if (splitPoints.length === 0) return;

			// Split from latest to earliest so earlier indices stay valid
			const sorted = [...splitPoints].sort((a, b) => b - a);

			for (const time of sorted) {
				const elementsAtTime = getElementsAtTime({
					tracks: editor.timeline.getTracks(),
					time,
				});

				if (elementsAtTime.length > 0) {
					editor.timeline.splitElements({
						elements: elementsAtTime,
						splitTime: time,
					});
				}
			}
		},
		[editor],
	);

	/**
	 * Compact all tracks so elements are packed sequentially with no gaps.
	 * Each track is compacted independently — elements are shifted left
	 * to close any space between them.
	 */
	const compactTimeline = useCallback(() => {
		const tracks = editor.timeline.getTracks();
		const updates: Array<{
			trackId: string;
			elementId: string;
			updates: Partial<TimelineElement>;
		}> = [];

		for (const track of tracks) {
			const sorted = [...track.elements].sort(
				(a, b) => a.startTime - b.startTime,
			);
			let cursor = sorted[0]?.startTime ?? 0;
			// Start from 0 if the first element doesn't start there
			if (sorted.length > 0 && cursor > 0.01) {
				cursor = 0;
			}

			for (const element of sorted) {
				if (Math.abs(element.startTime - cursor) > 0.01) {
					updates.push({
						trackId: track.id,
						elementId: element.id,
						updates: { startTime: cursor },
					});
				}
				cursor += element.duration;
			}
		}

		if (updates.length > 0) {
			editor.timeline.updateElements({ updates });
		}
	}, [editor]);

	/**
	 * Resolve panel-supplied cut ranges (STORE time) against the live timeline.
	 *
	 * Returns `null` when the request maps to nothing at all — the caller must
	 * then abandon the whole operation, leaving timeline and transcript in
	 * step, and tell the user why.
	 */
	const resolveCuts = useCallback(
		(cuts: TimeRange[]): TimeRange[] | null => {
			const { ranges, dropped } = resolveTranscriptCuts({
				tracks: editor.timeline.getTracks(),
				segments: useTranscriptStore.getState().segments,
				cuts,
			});

			if (ranges.length === 0) {
				toast.info("Nothing to cut", {
					description:
						dropped.length > 0
							? "That part of the clip is no longer on the timeline."
							: "Those words aren't on the timeline any more.",
				});
				return null;
			}

			if (dropped.length > 0) {
				toast.info("Part of that was already gone", {
					description:
						"Some of the footage for that selection had been trimmed off the timeline, so only the rest was cut.",
				});
			}

			return ranges;
		},
		[editor],
	);

	/**
	 * Cut TIMELINE-absolute time ranges from the video timeline.
	 *
	 * For each range, splits elements at the start and end boundaries,
	 * then deletes the elements that fall within the range.
	 * After all cuts, compacts the timeline to close any gaps.
	 *
	 * Ranges must already be resolved against the live timeline (see
	 * `resolveCuts`) — this function does no timebase conversion of its own.
	 */
	const cutTimeRanges = useCallback(
		(cuts: TimeRange[]) => {
			if (cuts.length === 0) return;

			const tracks = editor.timeline.getTracks();
			if (tracks.length === 0) return;

			// Process cuts from latest to earliest so indices don't shift
			const sortedCuts = [...cuts].sort((a, b) => b.start - a.start);

			for (const cut of sortedCuts) {
				// Find all elements that overlap with this cut range
				const elementsAtStart = getElementsAtTime({
					tracks: editor.timeline.getTracks(),
					time: cut.start,
				});

				// Split at the start boundary
				if (elementsAtStart.length > 0) {
					editor.timeline.splitElements({
						elements: elementsAtStart,
						splitTime: cut.start,
					});
				}

				// Split at the end boundary
				const elementsAtEnd = getElementsAtTime({
					tracks: editor.timeline.getTracks(),
					time: cut.end,
				});

				if (elementsAtEnd.length > 0) {
					editor.timeline.splitElements({
						elements: elementsAtEnd,
						splitTime: cut.end,
					});
				}

				// Now delete all elements that fall entirely within the cut range
				const currentTracks = editor.timeline.getTracks();
				const elementsToDelete: { trackId: string; elementId: string }[] = [];

				for (const track of currentTracks) {
					for (const element of track.elements) {
						// Element falls within the cut range
						if (
							element.startTime >= cut.start - 0.01 &&
							element.startTime + element.duration <= cut.end + 0.01
						) {
							elementsToDelete.push({
								trackId: track.id,
								elementId: element.id,
							});
						}
					}
				}

				if (elementsToDelete.length > 0) {
					editor.timeline.deleteElements({
						elements: elementsToDelete,
						rippleEnabled: true,
					});
				}
			}

			// Close any remaining gaps between clips
			compactTimeline();

			toast.success(
				`Cut ${cuts.length} ${cuts.length === 1 ? "section" : "sections"} from timeline`,
			);
		},
		[editor, compactTimeline],
	);

	/**
	 * After cutting and compacting, sync the transcript store segment times
	 * to match the new video clip positions on the timeline.
	 *
	 * Uses the track with the most elements (video or audio) as the source
	 * of truth, then ensures all other media tracks are aligned to the same
	 * start times so video and audio stay in sync.
	 */
	const syncTranscriptTimesToTimeline = useCallback(() => {
		const segments = useTranscriptStore.getState().segments;
		if (segments.length === 0) return;

		// Find the primary media track — prefer the one with the most clips
		const tracks = editor.timeline.getTracks();
		const mediaTracks = tracks.filter(
			(t) =>
				(t.type === "video" || t.type === "audio") && t.elements.length > 0,
		);
		if (mediaTracks.length === 0) return;

		// Pick the track with the most elements as the reference
		const primaryTrack = mediaTracks.reduce((best, t) =>
			t.elements.length > best.elements.length ? t : best,
		);

		const sortedClips = [...primaryTrack.elements].sort(
			(a, b) => a.startTime - b.startTime,
		);

		// Update transcript segments to match clip positions
		// Match by index: segment[i] corresponds to clip[i]
		const updatedSegments = segments.map((seg, i) => {
			if (i < sortedClips.length) {
				const clip = sortedClips[i];
				const newStart = clip.startTime;
				const newEnd = clip.startTime + clip.duration;
				const segDuration = newEnd - newStart;
				const wordCount = seg.words.length;
				const wordDuration =
					wordCount > 0 ? segDuration / wordCount : segDuration;

				return {
					...seg,
					start: newStart,
					end: newEnd,
					words: seg.words.map((w, wi) => ({
						...w,
						start: newStart + wi * wordDuration,
						end: newStart + (wi + 1) * wordDuration,
					})),
				};
			}
			return seg;
		});

		useTranscriptStore.getState().setSegments(updatedSegments);

		// Sync other media tracks to match the primary track's start times
		// so video + audio elements remain aligned after compaction
		const updates: Array<{
			trackId: string;
			elementId: string;
			updates: Partial<TimelineElement>;
		}> = [];

		for (const track of mediaTracks) {
			if (track.id === primaryTrack.id) continue;
			const otherSorted = [...track.elements].sort(
				(a, b) => a.startTime - b.startTime,
			);
			for (let i = 0; i < otherSorted.length && i < sortedClips.length; i++) {
				const refClip = sortedClips[i];
				const otherEl = otherSorted[i];
				if (Math.abs(otherEl.startTime - refClip.startTime) > 0.01) {
					updates.push({
						trackId: track.id,
						elementId: otherEl.id,
						updates: { startTime: refClip.startTime },
					});
				}
			}
		}

		if (updates.length > 0) {
			editor.timeline.updateElements({ updates });
		}
	}, [editor]);

	/**
	 * Handle segment deletion from the transcription panel.
	 * Removes the corresponding time ranges from the video.
	 */
	const handleDeleteSegments = useCallback(
		(segmentIds: string[], cuts: TimeRange[]) => {
			// Resolve BEFORE opening the transaction: if none of the request is on
			// the timeline we leave transcript and timeline alone together.
			const resolved = resolveCuts(cuts);
			if (!resolved) return;

			const supportsTransaction =
				typeof editor.command.beginTransaction === "function";
			const transcriptBefore = captureTranscriptSnapshot();

			// Begin transaction so timeline + transcript undo together
			if (supportsTransaction) editor.command.beginTransaction();

			cutTimeRanges(resolved);

			// Remove from transcript store
			const numericIds = segmentIds
				.map(Number)
				.filter((id) => !Number.isNaN(id));
			if (numericIds.length > 0) {
				useTranscriptStore.getState().deleteSegments(numericIds);
			}

			// Sync remaining segment times to the compacted timeline
			syncTranscriptTimesToTimeline();

			// Include transcript restore in the transaction
			if (supportsTransaction) {
				const transcriptAfter = captureTranscriptSnapshot();
				if (hasTranscriptChanged(transcriptBefore, transcriptAfter)) {
					editor.command.push({
						command: new TranscriptSnapshotCommand(
							transcriptBefore,
							transcriptAfter,
						),
					});
				}
				editor.command.commitTransaction();
			}
		},
		[editor, resolveCuts, cutTimeRanges, syncTranscriptTimesToTimeline],
	);

	/**
	 * Handle word-level cuts from the transcription panel.
	 * When individual words are marked and removed, cut those
	 * tiny time ranges from the video.
	 */
	const handleCutWords = useCallback(
		(
			_segmentId: string,
			_remainingWords: TranscriptWord[],
			cuts: TimeRange[],
		) => {
			const resolved = resolveCuts(cuts);
			if (!resolved) return;

			const supportsTransaction =
				typeof editor.command.beginTransaction === "function";
			const transcriptBefore = captureTranscriptSnapshot();
			if (supportsTransaction) editor.command.beginTransaction();

			cutTimeRanges(resolved);

			// Sync remaining segment times to the compacted timeline
			syncTranscriptTimesToTimeline();

			if (supportsTransaction) {
				const transcriptAfter = captureTranscriptSnapshot();
				if (hasTranscriptChanged(transcriptBefore, transcriptAfter)) {
					editor.command.push({
						command: new TranscriptSnapshotCommand(
							transcriptBefore,
							transcriptAfter,
						),
					});
				}
				editor.command.commitTransaction();
			}
		},
		[editor, resolveCuts, cutTimeRanges, syncTranscriptTimesToTimeline],
	);

	/**
	 * Handle segment reordering from drag-and-drop.
	 * Rearranges the actual video AND audio clips on the timeline to match
	 * the new segment order, then updates the transcript store.
	 *
	 * After transcription the video track is muted and a matching audio track
	 * is created — both must be reordered together to stay in sync.
	 */
	const handleReorderSegments = useCallback(
		(
			fromIndex: number,
			toIndex: number,
			newTimings: {
				segmentId: number;
				newStart: number;
				newEnd: number;
			}[],
		) => {
			const currentSegments = useTranscriptStore.getState().segments;
			if (fromIndex === toIndex || currentSegments.length === 0) return;

			const supportsTransaction =
				typeof editor.command.beginTransaction === "function";
			const transcriptBefore = captureTranscriptSnapshot();
			if (supportsTransaction) editor.command.beginTransaction();

			const tracks = editor.timeline.getTracks();

			// Collect ALL media tracks (video + audio) — they must be reordered together
			const mediaTracks = tracks.filter(
				(t) =>
					(t.type === "video" || t.type === "audio") && t.elements.length >= 2,
			);

			if (mediaTracks.length === 0) {
				// No split clips to reorder — just update transcript
				useTranscriptStore.getState().reorderSegments(fromIndex, toIndex);
				if (supportsTransaction) {
					const transcriptAfter = captureTranscriptSnapshot();
					if (hasTranscriptChanged(transcriptBefore, transcriptAfter)) {
						editor.command.push({
							command: new TranscriptSnapshotCommand(
								transcriptBefore,
								transcriptAfter,
							),
						});
					}
					editor.command.commitTransaction();
				}
				toast.info("Segments reordered in transcript");
				return;
			}

			const updates: Array<{
				trackId: string;
				elementId: string;
				updates: Partial<TimelineElement>;
			}> = [];

			// Apply the same reorder to every media track so video + audio stay in sync
			for (const mediaTrack of mediaTracks) {
				const sortedElements = [...mediaTrack.elements].sort(
					(a, b) => a.startTime - b.startTime,
				);

				// Guard: if the track has fewer elements than the from/to indices, skip
				if (
					fromIndex >= sortedElements.length ||
					toIndex >= sortedElements.length
				) {
					continue;
				}

				// Build the reordered element list
				const reordered = [...sortedElements];
				const [moved] = reordered.splice(fromIndex, 1);
				reordered.splice(toIndex, 0, moved);

				// Assign new sequential start times preserving each clip's duration
				let cursor = sortedElements[0]?.startTime ?? 0;
				for (const element of reordered) {
					updates.push({
						trackId: mediaTrack.id,
						elementId: element.id,
						updates: { startTime: cursor },
					});
					cursor += element.duration;
				}
			}

			// Also reorder any subtitle/text tracks that match segment count
			const textTracks = tracks.filter(
				(t) => t.type === "text" && t.elements.length >= 2,
			);
			for (const textTrack of textTracks) {
				const sortedElements = [...textTrack.elements].sort(
					(a, b) => a.startTime - b.startTime,
				);
				if (
					fromIndex >= sortedElements.length ||
					toIndex >= sortedElements.length
				) {
					continue;
				}

				const reordered = [...sortedElements];
				const [moved] = reordered.splice(fromIndex, 1);
				reordered.splice(toIndex, 0, moved);

				let cursor = sortedElements[0]?.startTime ?? 0;
				for (const element of reordered) {
					updates.push({
						trackId: textTrack.id,
						elementId: element.id,
						updates: { startTime: cursor },
					});
					cursor += element.duration;
				}
			}

			if (updates.length > 0) {
				editor.timeline.updateElements({ updates });
			}

			// Reorder in the transcript store
			useTranscriptStore.getState().reorderSegments(fromIndex, toIndex);

			if (supportsTransaction) {
				const transcriptAfter = captureTranscriptSnapshot();
				if (hasTranscriptChanged(transcriptBefore, transcriptAfter)) {
					editor.command.push({
						command: new TranscriptSnapshotCommand(
							transcriptBefore,
							transcriptAfter,
						),
					});
				}
				editor.command.commitTransaction();
			}
			toast.success("Segments reordered");
		},
		[editor],
	);

	/**
	 * Seek the video playhead to a specific time.
	 */
	const handleSeekTo = useCallback(
		(time: number) => {
			editor.playback.seek({ time });
		},
		[editor],
	);

	/**
	 * Get the current playback time.
	 */
	const getCurrentTime = useCallback((): number => {
		return editor.playback.getCurrentTime();
	}, [editor]);

	/**
	 * Start transcription for a file.
	 */
	const handleTranscribe = useCallback(async () => {
		if (!isConnected) {
			// Customer-facing copy names no backend, service, or setup command —
			// the technical pointer is a developer hint only (see
			// `views/director.tsx`'s friendly-error pattern).
			toast.error("Transcription isn't available right now", {
				description:
					transcriptionSetupHint() ||
					"Please try again in a moment. If it keeps happening, reload the editor.",
			});
			return;
		}

		// Find a media element with a mediaId on the timeline
		const tracks = editor.timeline.getTracks();
		let foundMediaId: string | null = null;

		for (const track of tracks) {
			for (const element of track.elements) {
				if (
					(track.type === "video" || track.type === "audio") &&
					hasMediaId(element as TimelineElement)
				) {
					foundMediaId = (element as TimelineElement & { mediaId: string })
						.mediaId;
					break;
				}
			}
			if (foundMediaId) break;
		}

		if (!foundMediaId) {
			toast.error("No video or audio found", {
				description: "Import a video or audio file first, then transcribe it.",
			});
			return;
		}

		// Look up the media asset by ID
		const mediaAsset = editor.media
			.getAssets()
			.find((asset) => asset.id === foundMediaId);

		if (!mediaAsset?.file) {
			toast.error("Cannot access media file", {
				description: "The media file could not be read for transcription.",
			});
			return;
		}

		try {
			const result = await transcribeVideo(mediaAsset.file);

			// `transcribeVideo` writes the backend's raw ASSET-RELATIVE segments
			// into the store. Re-write them in the store's TIMELINE-ABSOLUTE
			// contract, stamped with provenance, using the asset's own placement —
			// otherwise every later cut is off by `startTime - trimStart` on any
			// clip that isn't sitting untrimmed at 0.
			const offset =
				ingestOffsetForMedia({
					tracks: editor.timeline.getTracks(),
					mediaId: foundMediaId,
				}) ?? 0;
			const normalized = toTimelineSegments({
				segments: result?.segments ?? [],
				offsetSeconds: offset,
				mediaId: foundMediaId,
			});
			useTranscriptStore.getState().setSegments(normalized);

			// Auto-split the video at segment boundaries so each
			// transcript segment maps to its own timeline clip
			if (normalized.length > 1) {
				splitTimelineAtSegmentBoundaries(normalized);
			}

			toast.success("Transcription complete", {
				description:
					"Your video has been split into segments. Delete or reorder segments to edit the video.",
			});
		} catch {
			// Error is already set in useTranscription hook
		}
	}, [editor, isConnected, transcribeVideo, splitTimelineAtSegmentBoundaries]);

	return {
		// Callbacks for TranscriptionPanel
		handleDeleteSegments,
		handleCutWords,
		handleReorderSegments,
		handleSeekTo,
		handleTranscribe,
		getCurrentTime,

		// State
		segments,
		isTranscribing,
		progress,
		error,
		isConnected,
	};
}

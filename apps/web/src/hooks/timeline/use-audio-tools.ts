"use client";

/**
 * Timeline audio tools (Sprint 1 Wave 2, task E):
 *  - useSilenceRemoval  — dead-air detection + ripple-delete on one clip
 *  - useBeatAnalysis    — beat grid for snap-to-beat (see beat-grid-store)
 *  - useMulticamSync    — align multiple clips by audio / timecode / auto
 *
 * Silence + beat detection call the Python AI backend and degrade to a toast
 * when it is down. Multicam audio sync runs fully client-side (Web Audio
 * envelope + cross-correlation) so it works without the backend.
 */

import { useCallback, useState } from "react";
import { toast } from "sonner";
import { useEditor } from "@/hooks/use-editor";
import type { EditorCore } from "@/core";
import { aiClient } from "@/lib/ai-client";
import { hasMediaId, getElementsAtTime } from "@/lib/timeline";
import {
	computeSilenceCutRanges,
	computeAlignedStartTime,
	crossCorrelateEnvelopes,
	normalizeStartTimes,
	type TimeRange,
} from "@/lib/timeline/audio-sync-utils";
import {
	extractEnvelopeFromFile,
	type AudioEnvelope,
} from "@/lib/timeline/audio-envelope";
import { useBeatGridStore } from "@/stores/beat-grid-store";
import { snapTimeToFrame } from "@/lib/time";
import { DEFAULT_FPS } from "@/constants/project-constants";
import type { UploadAudioElement, VideoElement } from "@/types/timeline";

const CUT_EPSILON = 0.01;
/** Below this normalized correlation an audio-sync match is untrustworthy. */
const MIN_SYNC_CORRELATION = 0.3;

const BACKEND_DOWN_HINT =
	"AI backend needed — start the Python service and try again";

interface SelectedMediaClip {
	trackId: string;
	element: UploadAudioElement | VideoElement;
	file: File;
	assetDuration?: number;
}

/** Selected timeline elements that are media-backed audio/video clips. */
function resolveSelectedMediaClips(editor: EditorCore): SelectedMediaClip[] {
	const selected = editor.selection.getSelectedElements();
	const tracks = editor.timeline.getTracks();
	const assets = editor.media.getAssets();
	const clips: SelectedMediaClip[] = [];

	for (const ref of selected) {
		const track = tracks.find((t) => t.id === ref.trackId);
		const element = track?.elements.find((e) => e.id === ref.elementId);
		if (!track || !element) continue;
		if (track.type !== "video" && track.type !== "audio") continue;
		if (!hasMediaId(element) || element.type === "image") continue;
		const asset = assets.find((a) => a.id === element.mediaId);
		if (!asset?.file) continue;
		clips.push({
			trackId: track.id,
			element,
			file: asset.file,
			assetDuration: asset.duration,
		});
	}
	return clips;
}

/**
 * Split at every cut boundary on one track, delete the silent pieces, and
 * ripple the following clips left to close the gaps. Cuts are applied in
 * descending start order so earlier ranges are never shifted by later
 * deletions; everything is wrapped in one undoable transaction.
 */
function applyRippleCutsToTrack({
	editor,
	trackId,
	cuts,
}: {
	editor: EditorCore;
	trackId: string;
	cuts: TimeRange[];
}): number {
	let removedCount = 0;
	const sortedCuts = [...cuts].sort((a, b) => b.start - a.start);

	editor.command.beginTransaction();
	try {
		for (const cut of sortedCuts) {
			for (const boundary of [cut.end, cut.start]) {
				const refs = getElementsAtTime({
					tracks: editor.timeline.getTracks(),
					time: boundary,
				}).filter((ref) => ref.trackId === trackId);
				if (refs.length > 0) {
					editor.timeline.splitElements({
						elements: refs,
						splitTime: boundary,
					});
				}
			}

			const track = editor.timeline.getTracks().find((t) => t.id === trackId);
			if (!track) continue;

			const elementsToDelete = track.elements
				.filter(
					(element) =>
						element.startTime >= cut.start - CUT_EPSILON &&
						element.startTime + element.duration <= cut.end + CUT_EPSILON,
				)
				.map((element) => ({ trackId, elementId: element.id }));

			if (elementsToDelete.length > 0) {
				editor.timeline.deleteElements({
					elements: elementsToDelete,
					rippleEnabled: true,
				});
				removedCount += elementsToDelete.length;
			}
		}
	} finally {
		editor.command.commitTransaction();
	}
	return removedCount;
}

// ── Silence / dead-air removal ───────────────────────────────────────────────

export function useSilenceRemoval() {
	const editor = useEditor();
	const [isRemovingSilences, setIsRemovingSilences] = useState(false);

	const removeSilences = useCallback(async () => {
		const clips = resolveSelectedMediaClips(editor);
		if (clips.length !== 1) {
			toast.error("Select a single audio or video clip first");
			return;
		}
		const { trackId, element, file } = clips[0];

		setIsRemovingSilences(true);
		try {
			const result = await aiClient.analyzeSilences(file);
			const cuts = computeSilenceCutRanges({
				element,
				silences: result.silences,
			});
			if (cuts.length === 0) {
				toast.info("No dead air found in this clip");
				return;
			}
			const timeSaved = cuts.reduce((sum, c) => sum + (c.end - c.start), 0);
			applyRippleCutsToTrack({ editor, trackId, cuts });
			toast.success(
				`Removed ${cuts.length} silent section${cuts.length === 1 ? "" : "s"} (${timeSaved.toFixed(1)}s saved)`,
			);
		} catch {
			toast.error(`Silence removal failed. ${BACKEND_DOWN_HINT}.`);
		} finally {
			setIsRemovingSilences(false);
		}
	}, [editor]);

	return { removeSilences, isRemovingSilences };
}

// ── Beat-grid analysis ───────────────────────────────────────────────────────

export function useBeatAnalysis() {
	const editor = useEditor();
	const isAnalyzingBeats = useBeatGridStore((s) => s.isAnalyzing);

	const analyzeSelectedClipBeats = useCallback(async () => {
		const clips = resolveSelectedMediaClips(editor);
		if (clips.length !== 1) {
			toast.error("Select the music/audio clip to analyze");
			return;
		}
		const { trackId, element, file } = clips[0];
		const store = useBeatGridStore.getState();

		store.setAnalyzing(true);
		try {
			const result = await aiClient.analyzeBeats(file);
			if (result.beats.length === 0) {
				toast.info("No beats detected in this clip");
				return;
			}
			store.setGrid({
				elementId: element.id,
				trackId,
				mediaId: element.mediaId,
				beats: result.beats.map((b) => b.timestamp),
				downbeats: result.beats
					.filter((b) => b.is_downbeat)
					.map((b) => b.timestamp),
				bpm: result.bpm?.bpm ?? null,
				energyClass: result.bpm?.energy_class ?? null,
				analyzedAt: Date.now(),
			});
			const bpmLabel = result.bpm?.bpm
				? ` @ ${Math.round(result.bpm.bpm)} BPM`
				: "";
			toast.success(`Beat grid ready: ${result.beats.length} beats${bpmLabel}`);
		} catch {
			toast.error(`Beat analysis failed. ${BACKEND_DOWN_HINT}.`);
		} finally {
			store.setAnalyzing(false);
		}
	}, [editor]);

	return { analyzeSelectedClipBeats, isAnalyzingBeats };
}

// ── Multicam clip sync ───────────────────────────────────────────────────────

export type MulticamSyncMode = "auto" | "audio" | "timecode";

/**
 * File-metadata approximation of when a recording started (epoch seconds):
 * mtime is ≈ when the recording STOPPED, so subtract the source duration.
 */
function estimateRecordingStart(clip: SelectedMediaClip): number {
	return clip.file.lastModified / 1000 - (clip.assetDuration ?? 0);
}

export function useMulticamSync() {
	const editor = useEditor();
	const [isSyncing, setIsSyncing] = useState(false);

	const syncSelectedClips = useCallback(
		async ({ mode }: { mode: MulticamSyncMode }) => {
			const clips = resolveSelectedMediaClips(editor);
			if (clips.length < 2) {
				toast.error("Select two or more audio/video clips to sync");
				return;
			}
			const trackIds = new Set(clips.map((c) => c.trackId));
			if (trackIds.size !== clips.length) {
				toast.error("Clips must be on different tracks to sync");
				return;
			}

			setIsSyncing(true);
			try {
				// Earliest clip anchors the alignment; the rest move to it.
				const reference = clips.reduce((earliest, clip) =>
					clip.element.startTime < earliest.element.startTime ? clip : earliest,
				);
				const others = clips.filter((clip) => clip !== reference);

				// Envelopes decoded at most once per media asset.
				const envelopeCache = new Map<string, Promise<AudioEnvelope>>();
				const getEnvelope = (clip: SelectedMediaClip) => {
					const cached = envelopeCache.get(clip.element.mediaId);
					if (cached) return cached;
					const promise = extractEnvelopeFromFile({ file: clip.file });
					envelopeCache.set(clip.element.mediaId, promise);
					return promise;
				};

				const plans: Array<{
					clip: SelectedMediaClip;
					contentOffset: number;
					method: "audio" | "timecode";
				}> = [];
				const skipped: string[] = [];

				for (const clip of others) {
					let contentOffset: number | null = null;
					let method: "audio" | "timecode" = "timecode";

					if (mode === "audio" || mode === "auto") {
						try {
							const [refEnvelope, targetEnvelope] = await Promise.all([
								getEnvelope(reference),
								getEnvelope(clip),
							]);
							const { lagSeconds, correlation } = crossCorrelateEnvelopes({
								reference: refEnvelope.envelope,
								target: targetEnvelope.envelope,
								resolutionHz: refEnvelope.resolutionHz,
							});
							if (correlation >= MIN_SYNC_CORRELATION) {
								contentOffset = lagSeconds;
								method = "audio";
							} else if (mode === "audio") {
								skipped.push(clip.element.name);
								continue;
							}
						} catch {
							// Decode failed (no audio track, unsupported codec).
							if (mode === "audio") {
								skipped.push(clip.element.name);
								continue;
							}
						}
					}

					if (contentOffset == null) {
						// Timecode mode / auto fallback: file-metadata recording
						// starts. Nonsense deltas (copied files, missing metadata)
						// collapse to source-zero alignment.
						const delta =
							estimateRecordingStart(clip) - estimateRecordingStart(reference);
						contentOffset =
							Number.isFinite(delta) && Math.abs(delta) < 86_400 ? delta : 0;
						method = "timecode";
					}

					plans.push({ clip, contentOffset, method });
				}

				if (plans.length === 0) {
					toast.error(
						"Could not sync any clip — no reliable audio match found",
					);
					return;
				}

				const fps = editor.project.getActive()?.settings.fps ?? DEFAULT_FPS;
				const alignedStarts = plans.map((plan) =>
					computeAlignedStartTime({
						reference: reference.element,
						target: plan.clip.element,
						contentOffset: plan.contentOffset,
					}),
				);
				// Keep relative alignment but never start before t=0. Index 0 is
				// the reference's own (possibly shifted) start.
				const normalized = normalizeStartTimes([
					reference.element.startTime,
					...alignedStarts,
				]);

				editor.command.beginTransaction();
				try {
					if (
						Math.abs(normalized[0] - reference.element.startTime) > CUT_EPSILON
					) {
						editor.timeline.updateElementStartTime({
							elements: [
								{
									trackId: reference.trackId,
									elementId: reference.element.id,
								},
							],
							startTime: snapTimeToFrame({ time: normalized[0], fps }),
						});
					}
					plans.forEach((plan, index) => {
						editor.timeline.updateElementStartTime({
							elements: [
								{
									trackId: plan.clip.trackId,
									elementId: plan.clip.element.id,
								},
							],
							startTime: snapTimeToFrame({
								time: Math.max(0, normalized[index + 1]),
								fps,
							}),
						});
					});
				} finally {
					editor.command.commitTransaction();
				}

				const audioCount = plans.filter((p) => p.method === "audio").length;
				const methodSummary =
					audioCount === plans.length
						? "audio waveform"
						: audioCount === 0
							? "timecode metadata"
							: `audio (${audioCount}) + timecode (${plans.length - audioCount})`;
				toast.success(`Synced ${plans.length + 1} clips by ${methodSummary}`);
				if (skipped.length > 0) {
					toast.warning(
						`Skipped (no reliable audio match): ${skipped.join(", ")}`,
					);
				}
			} finally {
				setIsSyncing(false);
			}
		},
		[editor],
	);

	return { syncSelectedClips, isSyncing };
}

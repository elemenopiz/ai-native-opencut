import { useCallback } from "react";
import { useEditor } from "@/hooks/use-editor";
import { useTranscriptStore } from "@/stores/transcript-store";
import type { AudioElement, TimelineTrack } from "@/types/timeline";
import type { TranscriptionSegment } from "@/types/transcription";
import { toast } from "sonner";

/**
 * Where duck spans (the "duck under this" intervals) come from:
 * - "voiceover-elements" (default): timeline-time spans of audio elements that
 *   are voiceover takes — no transcript required. This is what makes
 *   auto-duck usable on a project that was never transcribed.
 * - "transcript": the original behavior — spans from transcript speech
 *   segments (requires `useTranscriptStore` to be populated first).
 */
export type DuckSpanMode = "voiceover-elements" | "transcript";

interface AutoDuckOptions {
	duckAmountDb: number;
	fadeDurationSec: number;
	musicTrackId?: string;
	spanMode: DuckSpanMode;
}

const DEFAULT_OPTIONS: AutoDuckOptions = {
	duckAmountDb: -18,
	fadeDurationSec: 0.3,
	spanMode: "voiceover-elements",
};

/** A timeline-time interval (seconds, absolute on the timeline — NOT
 *  element-local) to duck music underneath. */
export interface DuckSpan {
	start: number;
	end: number;
}

/**
 * Name fallback for voiceover elements that predate provenance tracking (or
 * landed through a path that doesn't set `generation` — see
 * `landVoiceoverAudio` in `views/voiceover.tsx`, which names its clips
 * "Voiceover" / "Voice [xx]: ...·"). Only consulted when an element carries no
 * `generation` at all — an element WITH `generation` is trusted on
 * `generation.kind` alone, even if that kind is "video" (a real generative
 * slot should never be name-sniffed into a voiceover match).
 *
 * `\bvo\b` deliberately requires a word boundary so it doesn't false-match
 * "video" (no boundary between "vo" and "id").
 */
const VOICEOVER_NAME_PATTERN = /voiceover|voice[\s-]over|\bvoice\b|\bvo\b/i;

function isVoiceoverElement(element: AudioElement): boolean {
	if (element.generation) {
		return element.generation.kind === "voiceover";
	}
	return VOICEOVER_NAME_PATTERN.test(element.name);
}

/** Voiceover-element spans: every audio-track element that looks like a
 *  voiceover take, as timeline-time intervals. */
export function deriveVoiceoverSpans(tracks: TimelineTrack[]): DuckSpan[] {
	const spans: DuckSpan[] = [];
	for (const track of tracks) {
		if (track.type !== "audio") continue;
		for (const element of track.elements) {
			if (element.duration <= 0) continue;
			if (!isVoiceoverElement(element)) continue;
			spans.push({
				start: element.startTime,
				end: element.startTime + element.duration,
			});
		}
	}
	return spans.sort((a, b) => a.start - b.start);
}

/** Transcript-segment spans (original behavior): non-empty speech segments. */
export function deriveTranscriptSpans(
	segments: TranscriptionSegment[],
): DuckSpan[] {
	return segments
		.filter((s) => s.text.trim().length > 0)
		.map((s) => ({ start: s.start, end: s.end }));
}

interface DuckKeyframe {
	trackId: string;
	elementId: string;
	propertyPath: "volume";
	time: number;
	value: number;
	interpolation: "linear";
}

interface MusicElementLike {
	id: string;
	startTime: number;
	duration: number;
}

/**
 * Duck-in/duck-out volume keyframes for every (span, music element) overlap.
 * Keyframe `time` is element-relative (matches `UpsertKeyframeCommand`, which
 * bounds incoming keyframe time to `[0, element.duration]`), so every span
 * boundary is offset by the music element's own `startTime` before use.
 */
export function computeDuckKeyframes({
	spans,
	musicElements,
	targetTrackId,
	duckAmountDb,
	fadeDurationSec,
}: {
	spans: DuckSpan[];
	musicElements: MusicElementLike[];
	targetTrackId: string;
	duckAmountDb: number;
	fadeDurationSec: number;
}): DuckKeyframe[] {
	const keyframes: DuckKeyframe[] = [];
	const normalVolume = 1;
	const duckedVolume = 10 ** (duckAmountDb / 20);

	for (const span of spans) {
		for (const el of musicElements) {
			const elStart = el.startTime;
			const elEnd = el.startTime + el.duration;
			if (span.end <= elStart || span.start >= elEnd) continue;

			const fadeInTime =
				Math.max(span.start - fadeDurationSec, elStart) - elStart;
			const duckTime = span.start - elStart;
			const recoverTime = span.end - elStart;
			const fadeOutTime = Math.min(span.end + fadeDurationSec, elEnd) - elStart;

			if (fadeInTime >= 0) {
				keyframes.push({
					trackId: targetTrackId,
					elementId: el.id,
					propertyPath: "volume",
					time: Math.max(0, fadeInTime),
					value: normalVolume,
					interpolation: "linear",
				});
			}

			keyframes.push({
				trackId: targetTrackId,
				elementId: el.id,
				propertyPath: "volume",
				time: Math.max(0, duckTime),
				value: duckedVolume,
				interpolation: "linear",
			});

			keyframes.push({
				trackId: targetTrackId,
				elementId: el.id,
				propertyPath: "volume",
				time: Math.max(0, recoverTime),
				value: duckedVolume,
				interpolation: "linear",
			});

			if (fadeOutTime <= el.duration) {
				keyframes.push({
					trackId: targetTrackId,
					elementId: el.id,
					propertyPath: "volume",
					time: fadeOutTime,
					value: normalVolume,
					interpolation: "linear",
				});
			}
		}
	}

	return keyframes;
}

export function useAutoDuck() {
	const editor = useEditor();
	const segments = useTranscriptStore((s) => s.segments);

	const applyAutoDuck = useCallback(
		(options: Partial<AutoDuckOptions> = {}) => {
			const opts = { ...DEFAULT_OPTIONS, ...options };
			const tracks = editor.timeline.getTracks();

			let spans: DuckSpan[];
			if (opts.spanMode === "transcript") {
				spans = deriveTranscriptSpans(segments);
				if (spans.length === 0) {
					toast.error("No speech segments found. Transcribe your video first.");
					return;
				}
			} else {
				spans = deriveVoiceoverSpans(tracks);
				if (spans.length === 0) {
					toast.error(
						"No voiceover elements found on the timeline. Generate a voiceover, or switch to transcript-based ducking.",
					);
					return;
				}
			}

			const audioTracks = tracks.filter(
				(t) =>
					t.type === "audio" || (t.type === "video" && t.elements.length > 0),
			);

			if (audioTracks.length === 0) {
				toast.error("No audio/video tracks found for ducking.");
				return;
			}

			const targetTrackId =
				opts.musicTrackId ??
				audioTracks.find((t) => {
					const name = t.name.toLowerCase();
					return (
						name.includes("music") ||
						name.includes("bgm") ||
						name.includes("bg")
					);
				})?.id ??
				audioTracks[audioTracks.length - 1].id;

			const targetTrack = tracks.find((t) => t.id === targetTrackId);
			if (!targetTrack) return;

			const musicElements = targetTrack.elements;
			if (musicElements.length === 0) return;

			const keyframes = computeDuckKeyframes({
				spans,
				musicElements,
				targetTrackId,
				duckAmountDb: opts.duckAmountDb,
				fadeDurationSec: opts.fadeDurationSec,
			});

			if (keyframes.length === 0) {
				toast.info("No overlapping voiceover/music found for ducking.");
				return;
			}

			editor.timeline.upsertKeyframes({ keyframes });
			toast.success(
				`Applied auto-duck: ${keyframes.length} volume keyframes (${opts.duckAmountDb}dB duck)`,
			);
		},
		[editor, segments],
	);

	return { applyAutoDuck };
}

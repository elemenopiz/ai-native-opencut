/**
 * Pure windowing/direction math for the tape-scrub grain player
 * (hooks/audio/use-scrub-audio.ts / lib/audio/scrub-player.ts consume this).
 *
 * No Web Audio, no DOM — this file is independently unit-testable and holds
 * the numeric parameters cited by
 * apps/web/docs/poach/palmier-delta-refresh-2026-07-14.md §4.2: a 50ms grain,
 * built forward or reverse from the drag direction, with 3ms linear fades to
 * kill clicks, centered on a re-decoded ~2s PCM window around the playhead.
 */

/** Length of one audible grain, in seconds. */
export const GRAIN_DURATION_SECONDS = 0.05;

/** Linear gain ramp at each end of a grain, in seconds — kills clicks. */
export const GRAIN_FADE_SECONDS = 0.003;

/** Length of the decoded PCM window kept around the playhead, in seconds. */
export const SCRUB_WINDOW_DURATION_SECONDS = 2;

export type ScrubDirection = "forward" | "reverse";

/**
 * Direction is derived from consecutive playhead-time samples during a drag
 * (or from which arrow key was pressed for single-frame stepping). Equal
 * times (no movement) default to "forward" — there's nothing audible to
 * distinguish a held position from a forward step of zero length.
 */
export function directionFromDelta(deltaSeconds: number): ScrubDirection {
	return deltaSeconds < 0 ? "reverse" : "forward";
}

/**
 * Center a decode window on `time`, clamped so it never starts before 0.
 * The window is re-centered (not scrolled) — see `isOutsideWindow`.
 */
export function computeWindowStart({
	time,
	windowDuration = SCRUB_WINDOW_DURATION_SECONDS,
}: {
	time: number;
	windowDuration?: number;
}): number {
	return Math.max(0, time - windowDuration / 2);
}

/**
 * True once `time` has drifted outside the currently-decoded window, which
 * is the re-centering trigger: keep playing grains from the stale window
 * while a fresh one decodes in the background, rather than glitching.
 */
export function isOutsideWindow({
	time,
	windowStart,
	windowDuration,
}: {
	time: number;
	windowStart: number;
	windowDuration: number;
}): boolean {
	return time < windowStart || time >= windowStart + windowDuration;
}

/** Maps a timeline-relative time to source-file time for a clip, matching
 * the visual renderer's `trimStart + elapsed * playbackRate` convention
 * (see VisualNode.getSourceLocalTime / AudioManager.runClipIterator). */
export function sourceTimeForTimelineTime({
	time,
	clipStartTime,
	trimStart,
	playbackRate,
}: {
	time: number;
	clipStartTime: number;
	trimStart: number;
	playbackRate: number;
}): number {
	const rate = playbackRate > 0 ? playbackRate : 1;
	return trimStart + (time - clipStartTime) * rate;
}

export interface GrainSampleRange {
	/** Sample index (inclusive) within the source buffer the grain starts at. */
	startSample: number;
	/** Number of samples in the grain (may be shorter than requested near an edge). */
	length: number;
	/** True when the grain's sample order should be reversed before playback. */
	reversed: boolean;
}

/**
 * Resolve which samples make up one grain: `grainSamples` wide, centered on
 * `centerSample`, clamped to `[0, bufferLength)`. `direction === "reverse"`
 * flags the caller to play the extracted samples back-to-front — the window
 * of samples read is the same either way, only the playback order flips.
 * Returns null when the center falls entirely outside the buffer (nothing to play).
 */
export function computeGrainSampleRange({
	centerSample,
	grainSamples,
	bufferLength,
	direction,
}: {
	centerSample: number;
	grainSamples: number;
	bufferLength: number;
	direction: ScrubDirection;
}): GrainSampleRange | null {
	if (bufferLength <= 0 || grainSamples <= 0) return null;

	const half = Math.floor(grainSamples / 2);
	let startSample = Math.round(centerSample) - half;
	let length = grainSamples;

	if (startSample < 0) {
		length += startSample; // shrink from the front
		startSample = 0;
	}
	if (startSample >= bufferLength) return null;
	if (startSample + length > bufferLength) {
		length = bufferLength - startSample;
	}
	if (length <= 0) return null;

	return { startSample, length, reversed: direction === "reverse" };
}

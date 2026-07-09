/**
 * Pure timeline-time math for the audio tools: silence/dead-air removal,
 * beat-grid mapping, and multicam sync alignment.
 *
 * Conventions (see `types/timeline.ts`):
 * - All times are SECONDS.
 * - An element shows SOURCE range [trimStart, trimStart + duration] at
 *   TIMELINE range [startTime, startTime + duration] (`duration` is the
 *   visible duration; `trimStart`/`trimEnd` eat into the source media).
 */

import type { TimelineElement } from "@/types/timeline";

export interface TimeRange {
	start: number;
	end: number;
}

/** Minimum overlap (seconds) required for a cross-correlation lag to count. */
const MIN_CORRELATION_OVERLAP_SECONDS = 3;

// ── Source-time ↔ timeline-time mapping ─────────────────────────────────────

/** Source-media range currently visible through an element's trims. */
export function getVisibleSourceRange(element: TimelineElement): TimeRange {
	return {
		start: element.trimStart,
		end: element.trimStart + element.duration,
	};
}

/** Map a SOURCE-media time to TIMELINE time through an element's placement. */
export function sourceTimeToTimeline({
	element,
	sourceTime,
}: {
	element: TimelineElement;
	sourceTime: number;
}): number {
	return element.startTime + (sourceTime - element.trimStart);
}

/**
 * Map a SOURCE-media time range onto the TIMELINE through an element,
 * clamped to the element's visible span. Returns null when the range does
 * not intersect the visible portion of the clip.
 */
export function sourceRangeToTimelineRange({
	element,
	range,
}: {
	element: TimelineElement;
	range: TimeRange;
}): TimeRange | null {
	const visible = getVisibleSourceRange(element);
	const start = Math.max(range.start, visible.start);
	const end = Math.min(range.end, visible.end);
	if (end <= start) return null;
	return {
		start: sourceTimeToTimeline({ element, sourceTime: start }),
		end: sourceTimeToTimeline({ element, sourceTime: end }),
	};
}

// ── Silence / dead-air removal ───────────────────────────────────────────────

/** Merge overlapping/adjacent ranges into a minimal sorted set. */
export function mergeRanges(ranges: TimeRange[]): TimeRange[] {
	if (ranges.length === 0) return [];
	const sorted = [...ranges].sort((a, b) => a.start - b.start);
	const merged: TimeRange[] = [{ ...sorted[0] }];
	for (let i = 1; i < sorted.length; i += 1) {
		const last = merged[merged.length - 1];
		if (sorted[i].start <= last.end) {
			last.end = Math.max(last.end, sorted[i].end);
		} else {
			merged.push({ ...sorted[i] });
		}
	}
	return merged;
}

/**
 * Turn detected silence spans (SOURCE time, from
 * `aiClient.analyzeSilences`) into TIMELINE-time cut ranges for one element.
 *
 * - `padding` seconds are preserved at both edges of every silence so speech
 *   onsets/offsets are never clipped.
 * - Cuts shorter than `minCutDuration` after padding are dropped (removing
 *   them would create imperceptible micro-edits and needless splits).
 * - Ranges are clamped to the element's visible span, merged, and returned
 *   sorted by start time.
 */
export function computeSilenceCutRanges({
	element,
	silences,
	padding = 0.1,
	minCutDuration = 0.2,
}: {
	element: TimelineElement;
	silences: TimeRange[];
	padding?: number;
	minCutDuration?: number;
}): TimeRange[] {
	const cuts: TimeRange[] = [];
	for (const silence of silences) {
		const padded: TimeRange = {
			start: silence.start + padding,
			end: silence.end - padding,
		};
		if (padded.end - padded.start < minCutDuration) continue;
		const timelineRange = sourceRangeToTimelineRange({
			element,
			range: padded,
		});
		if (!timelineRange) continue;
		if (timelineRange.end - timelineRange.start < minCutDuration) continue;
		cuts.push(timelineRange);
	}
	return mergeRanges(cuts);
}

// ── Beat grid ────────────────────────────────────────────────────────────────

export interface BeatMarker {
	/** TIMELINE time of the beat. */
	time: number;
	isDownbeat: boolean;
}

/**
 * Map SOURCE-time beat timestamps onto the TIMELINE through the element they
 * were analyzed from. Beats trimmed out of view are dropped; the grid follows
 * the clip when it is moved or trimmed.
 */
export function mapBeatsToTimeline({
	element,
	beats,
	downbeats = [],
}: {
	element: TimelineElement;
	beats: number[];
	downbeats?: number[];
}): BeatMarker[] {
	const visible = getVisibleSourceRange(element);
	const downbeatSet = new Set(downbeats);
	const markers: BeatMarker[] = [];
	for (const beat of beats) {
		if (beat < visible.start || beat > visible.end) continue;
		markers.push({
			time: sourceTimeToTimeline({ element, sourceTime: beat }),
			isDownbeat: downbeatSet.has(beat),
		});
	}
	return markers;
}

// ── Audio envelopes + cross-correlation (multicam sync) ─────────────────────

/**
 * RMS energy envelope of a mono sample buffer at `resolutionHz` frames per
 * second. Pure — the Web Audio decode lives in `audio-envelope.ts`.
 */
export function computeRmsEnvelope({
	samples,
	sampleRate,
	resolutionHz,
}: {
	samples: Float32Array;
	sampleRate: number;
	resolutionHz: number;
}): number[] {
	const windowSize = Math.max(1, Math.round(sampleRate / resolutionHz));
	const frameCount = Math.ceil(samples.length / windowSize);
	const envelope: number[] = new Array(frameCount);
	for (let frame = 0; frame < frameCount; frame += 1) {
		const start = frame * windowSize;
		const end = Math.min(start + windowSize, samples.length);
		let sumSquares = 0;
		for (let i = start; i < end; i += 1) {
			sumSquares += samples[i] * samples[i];
		}
		envelope[frame] = Math.sqrt(sumSquares / Math.max(1, end - start));
	}
	return envelope;
}

export interface CrossCorrelationResult {
	/**
	 * Content offset in seconds: target source time `u` lines up with
	 * reference source time `u + lagSeconds`. Positive ⇒ the target recording
	 * started after the reference.
	 */
	lagSeconds: number;
	/** Peak normalized correlation, 0..1. Below ~0.3 the match is unreliable. */
	correlation: number;
}

/**
 * Find the time offset between two energy envelopes by normalized
 * cross-correlation (Pearson over the overlapping window, swept across all
 * lags). O(N × L) — envelopes are coarse (10–50 Hz), so this stays cheap even
 * for long takes.
 */
export function crossCorrelateEnvelopes({
	reference,
	target,
	resolutionHz,
	maxLagSeconds,
}: {
	reference: number[];
	target: number[];
	resolutionHz: number;
	maxLagSeconds?: number;
}): CrossCorrelationResult {
	const minOverlap = Math.max(
		2,
		Math.round(MIN_CORRELATION_OVERLAP_SECONDS * resolutionHz),
	);
	const maxLagFrames = Math.min(
		maxLagSeconds != null
			? Math.round(maxLagSeconds * resolutionHz)
			: Number.POSITIVE_INFINITY,
		Math.max(reference.length, target.length),
	);

	let bestLag = 0;
	let bestScore = Number.NEGATIVE_INFINITY;

	// Lag k aligns target[i] against reference[i + k].
	for (let k = -maxLagFrames; k <= maxLagFrames; k += 1) {
		const targetStart = Math.max(0, -k);
		const targetEnd = Math.min(target.length, reference.length - k);
		const overlap = targetEnd - targetStart;
		if (overlap < minOverlap) continue;

		let sumA = 0;
		let sumB = 0;
		for (let i = targetStart; i < targetEnd; i += 1) {
			sumA += reference[i + k];
			sumB += target[i];
		}
		const meanA = sumA / overlap;
		const meanB = sumB / overlap;

		let numerator = 0;
		let varA = 0;
		let varB = 0;
		for (let i = targetStart; i < targetEnd; i += 1) {
			const a = reference[i + k] - meanA;
			const b = target[i] - meanB;
			numerator += a * b;
			varA += a * a;
			varB += b * b;
		}
		const denominator = Math.sqrt(varA * varB);
		if (denominator === 0) continue;

		// Slight preference for longer overlaps breaks ties between
		// equally-correlated lags at the sweep edges.
		const score =
			(numerator / denominator) * (0.9 + 0.1 * (overlap / target.length));
		if (score > bestScore) {
			bestScore = score;
			bestLag = k;
		}
	}

	if (bestScore === Number.NEGATIVE_INFINITY) {
		return { lagSeconds: 0, correlation: 0 };
	}
	return {
		lagSeconds: bestLag / resolutionHz,
		correlation: Math.max(0, Math.min(1, bestScore)),
	};
}

// ── Multicam alignment ───────────────────────────────────────────────────────

/**
 * Timeline start time that aligns `target` with `reference` given a content
 * offset (target source `u` ↔ reference source `u + contentOffset`).
 *
 * Derivation: the target's first visible source frame is `target.trimStart`,
 * which corresponds to reference source time `target.trimStart +
 * contentOffset`, which the reference shows at timeline time
 * `reference.startTime + (that − reference.trimStart)`.
 */
export function computeAlignedStartTime({
	reference,
	target,
	contentOffset,
}: {
	reference: Pick<TimelineElement, "startTime" | "trimStart">;
	target: Pick<TimelineElement, "trimStart">;
	contentOffset: number;
}): number {
	return (
		reference.startTime +
		(target.trimStart + contentOffset - reference.trimStart)
	);
}

/**
 * If any aligned start would land before t=0, shift ALL starts right by the
 * same amount so relative alignment is preserved and nothing is clipped.
 */
export function normalizeStartTimes(startTimes: number[]): number[] {
	const min = Math.min(...startTimes);
	if (min >= 0) return startTimes;
	return startTimes.map((t) => t - min);
}

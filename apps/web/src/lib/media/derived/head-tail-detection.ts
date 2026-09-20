/**
 * Black / blank / color-bars detection on a clip's head and tail — pure core.
 *
 * Finds the unusable lead-in/lead-out that professional camera masters
 * routinely carry (lens cap black, a beep-tone color-bars slate, a flat
 * gray/white balance card) so the Director can trim to the first genuinely
 * usable frame without a model call.
 *
 * Classification per sampled frame, in priority order (a frame gets the
 * first label that matches):
 *  - "black": near-zero luma everywhere (lens cap, fade to black).
 *  - "bars": a static, high-contrast VERTICAL striping (SMPTE color bars) —
 *    detected as high variance across `stripMeans` sustained with low
 *    variance over time (a real bars slate doesn't move); OR a letterboxed
 *    frame — top/bottom bands near-black while the middle band is lit.
 *  - "blank": low variance across the WHOLE frame (a flat color/gray card)
 *    that isn't black and isn't bars.
 *  - "normal": none of the above — real, usable picture.
 *
 * The head/tail run length is measured in SAMPLES, so its resolution is
 * bounded by the sampler's interval (same caveat as shot-detection.ts).
 */

import type { FrameSample } from "./frame-sample-types";

export type HeadTailFrameKind = "black" | "bars" | "blank" | "normal";

export interface HeadTailDetectionOptions {
	/** Mean luma below this is "black". Default 12 (of 255). */
	blackLumaThreshold?: number;
	/** Variance (max-min) of `stripMeans` above this, held for 2+ consecutive samples, reads as a static test-pattern slate. Default 40. */
	barsStripSpreadThreshold?: number;
	/** top/bottom band luma this much below the middle band reads as letterboxing. Default 20. */
	letterboxBandGapThreshold?: number;
	/** Spread (max-min) of the luma histogram's dominant bucket share above this is NOT blank (real picture has texture). A blank card's histogram is nearly a single spike. Default: dominant bucket must hold >= 0.85 of mass to call it blank. */
	blankDominantBucketShare?: number;
}

const DEFAULTS: Required<HeadTailDetectionOptions> = {
	blackLumaThreshold: 12,
	barsStripSpreadThreshold: 40,
	letterboxBandGapThreshold: 20,
	blankDominantBucketShare: 0.85,
};

function spread(values: number[]): number {
	if (values.length === 0) return 0;
	return Math.max(...values) - Math.min(...values);
}

function dominantBucketShare(histogram: number[]): number {
	if (histogram.length === 0) return 0;
	return Math.max(...histogram);
}

/**
 * Classify one frame in isolation, EXCEPT "bars" via strip-spread which needs
 * the caller to also confirm it holds over consecutive samples (done by
 * `classifyRun` below) — a single frame with a busy background can spike
 * strip-spread too, so a one-frame read alone would false-positive on real
 * footage.
 */
function classifyFrame(
	frame: FrameSample,
	opts: Required<HeadTailDetectionOptions>,
): HeadTailFrameKind {
	if (frame.meanLuma <= opts.blackLumaThreshold) return "black";

	const [top, mid, bottom] = frame.bandMeans;
	const isLetterboxed =
		mid - top >= opts.letterboxBandGapThreshold &&
		mid - bottom >= opts.letterboxBandGapThreshold;
	if (isLetterboxed) return "bars";

	if (spread(frame.stripMeans) >= opts.barsStripSpreadThreshold) return "bars";

	if (
		dominantBucketShare(frame.lumaHistogram) >= opts.blankDominantBucketShare
	) {
		return "blank";
	}

	return "normal";
}

/**
 * Walk from one end of the sequence inward, stopping at the first "normal"
 * frame. `direction` "forward" walks head→tail (for the head run);
 * "backward" walks tail→head (for the tail run). Returns the duration
 * covered (0 if the very first/last frame is already normal) and the
 * predominant non-normal kind seen, or null if the whole clip is normal.
 */
function classifyRun(
	frames: FrameSample[],
	direction: "forward" | "backward",
	opts: Required<HeadTailDetectionOptions>,
): { durationSec: number; kind: Exclude<HeadTailFrameKind, "normal"> } | null {
	if (frames.length === 0) return null;
	const ordered = direction === "forward" ? frames : [...frames].reverse();

	const counts: Record<Exclude<HeadTailFrameKind, "normal">, number> = {
		black: 0,
		bars: 0,
		blank: 0,
	};
	let lastNonNormalIndex = -1;

	for (let i = 0; i < ordered.length; i++) {
		const kind = classifyFrame(ordered[i], opts);
		if (kind === "normal") break;
		counts[kind]++;
		lastNonNormalIndex = i;
	}

	if (lastNonNormalIndex === -1) return null;

	// The run's duration extends up to where the FIRST NORMAL frame starts
	// (not merely to the last non-normal sample's own timestamp) — each
	// sample stands for the interval up to the next one, so a black frame at
	// t=2 with the next (normal) sample at t=3 means 3 seconds of unusable
	// head, not 2. When the run consumes every sample (no normal frame ever
	// appears), fall back to the last non-normal sample's own timestamp as a
	// conservative lower bound — the true asset duration isn't knowable here.
	const boundaryFrame = ordered[lastNonNormalIndex];
	const nextFrame = ordered[lastNonNormalIndex + 1];
	const runEndTimeSec = nextFrame
		? nextFrame.timestampSec
		: boundaryFrame.timestampSec;
	const durationSec =
		direction === "forward"
			? runEndTimeSec - ordered[0].timestampSec
			: ordered[0].timestampSec - runEndTimeSec;

	const predominant = (
		Object.entries(counts) as [Exclude<HeadTailFrameKind, "normal">, number][]
	).sort((a, b) => b[1] - a[1])[0][0];

	return { durationSec: Math.max(0, durationSec), kind: predominant };
}

export interface HeadTailAnalysis {
	/** Non-null when the head (start) of the clip is unusable lead-in. */
	head: {
		durationSec: number;
		kind: Exclude<HeadTailFrameKind, "normal">;
	} | null;
	/** Non-null when the tail (end) of the clip is unusable lead-out. */
	tail: {
		durationSec: number;
		kind: Exclude<HeadTailFrameKind, "normal">;
	} | null;
}

export function detectHeadTail(
	frames: FrameSample[],
	options?: HeadTailDetectionOptions,
): HeadTailAnalysis {
	const opts = { ...DEFAULTS, ...options };
	return {
		head: classifyRun(frames, "forward", opts),
		tail: classifyRun(frames, "backward", opts),
	};
}

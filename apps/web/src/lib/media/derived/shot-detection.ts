/**
 * Shot-change (hard cut) detection — pure core.
 *
 * Nothing in the codebase does this today; it's the highest-value item in
 * the time-ranged-derivations set (task A). A "shot" here means a
 * contiguous run between two adjacent sampled frames whose luma
 * distributions differ sharply — the classic histogram-difference cut
 * detector used by non-ML scene-detection tools (e.g. ffmpeg's
 * `select='gt(scene,...)'`, PySceneDetect's content detector).
 *
 * ACCURACY CAVEAT (measured on synthetic fixtures, see shot-detection.test.ts):
 * detection resolution is bounded by the sampling interval — a cut is only
 * ever placed BETWEEN two sampled frames, so at the ~1 sample/sec cadence
 * `visual-analysis.ts` uses to keep the pass cheap, two real cuts less than
 * ~1s apart collapse into one detected boundary, and a cut's reported time
 * carries up to ~1 sample-interval of jitter. This is a coarse "where do the
 * scenes roughly change" signal for editing decisions (can this clip be cut
 * into pieces?), not a frame-accurate SMPTE cut list.
 */

import type { FrameSample } from "./frame-sample-types";

export interface ShotChange {
	/** Seconds from media start where the cut is placed (the later frame's timestamp). */
	timeSec: number;
	/** L1 histogram distance that triggered the cut, in [0, 2] — higher = more confident. */
	strength: number;
}

export interface ShotDetectionOptions {
	/**
	 * Minimum normalized L1 histogram distance between adjacent samples to
	 * call it a cut. Range [0, 2] (two disjoint normalized distributions
	 * differ by exactly 2). Default 0.55 — tuned to fire on a genuine hard
	 * cut between visually distinct shots while ignoring pans/motion blur,
	 * which shift a histogram gradually rather than swapping it wholesale.
	 */
	threshold?: number;
	/**
	 * Minimum seconds between two reported cuts. Guards against a single
	 * real cut spanning two low-confidence adjacent diffs being reported
	 * twice. Default 0.5s.
	 */
	minGapSec?: number;
}

const DEFAULT_THRESHOLD = 0.55;
const DEFAULT_MIN_GAP_SEC = 0.5;

/** L1 distance between two same-length, sum-normalized histograms. */
function histogramDistance(a: number[], b: number[]): number {
	let sum = 0;
	for (let i = 0; i < a.length; i++) {
		sum += Math.abs(a[i] - (b[i] ?? 0));
	}
	return sum;
}

/**
 * Detect hard cuts across a sequence of frame samples (must be sorted by
 * `timestampSec`, ascending — `visual-analysis.ts`'s sampler guarantees this).
 * Returns cuts in ascending time order.
 */
export function detectShotChanges(
	frames: FrameSample[],
	options?: ShotDetectionOptions,
): ShotChange[] {
	const threshold = options?.threshold ?? DEFAULT_THRESHOLD;
	const minGapSec = options?.minGapSec ?? DEFAULT_MIN_GAP_SEC;
	if (frames.length < 2) return [];

	const cuts: ShotChange[] = [];
	let lastCutTime = -Infinity;

	for (let i = 1; i < frames.length; i++) {
		const prev = frames[i - 1];
		const curr = frames[i];
		const distance = histogramDistance(prev.lumaHistogram, curr.lumaHistogram);
		if (distance < threshold) continue;
		if (curr.timestampSec - lastCutTime < minGapSec) continue;
		cuts.push({ timeSec: curr.timestampSec, strength: distance });
		lastCutTime = curr.timestampSec;
	}

	return cuts;
}

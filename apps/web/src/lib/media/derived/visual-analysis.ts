/**
 * Orchestrates the visual derivations from ONE frame-sampling pass (task A):
 * shot changes, motion energy, and head/tail black/blank/bars — all computed
 * from the same `FrameSample[]` so a long video is only decoded/seeked once.
 */

import { sampleVideoFrameStats, SAMPLE_INTERVAL_SEC } from "./frame-sampling";
import { detectShotChanges, type ShotChange } from "./shot-detection";
import {
	computeMotionEnergy,
	encodeMotionEnergy,
	type EncodedMotionEnergy,
} from "./motion-energy";
import { detectHeadTail, type HeadTailAnalysis } from "./head-tail-detection";

export interface VisualAnalysisResult {
	shots: ShotChange[];
	motionEnergy: EncodedMotionEnergy;
	headTail: HeadTailAnalysis;
	/** How many frames were actually sampled — 0 means the pass produced nothing usable. */
	sampleCount: number;
}

/**
 * Run the one sampling pass and derive all three results from it. Throws if
 * the video can't be sampled at all (caller maps that to a `failed` status);
 * an empty-but-successful pass (e.g. a 0-length asset) returns
 * `sampleCount: 0` with empty results, which callers should treat as `empty`
 * rather than `failed`.
 */
export async function analyzeVisualDerivations(
	url: string,
): Promise<VisualAnalysisResult> {
	const frames = await sampleVideoFrameStats(url);

	if (frames.length === 0) {
		return {
			shots: [],
			motionEnergy: { startSec: 0, stepSec: SAMPLE_INTERVAL_SEC, values: [] },
			headTail: { head: null, tail: null },
			sampleCount: 0,
		};
	}

	const shots = detectShotChanges(frames);
	const motion = computeMotionEnergy(frames);
	const headTail = detectHeadTail(frames);

	return {
		shots,
		motionEnergy: encodeMotionEnergy(motion, SAMPLE_INTERVAL_SEC),
		headTail,
		sampleCount: frames.length,
	};
}

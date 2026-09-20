/**
 * Shared descriptor for one sampled video frame, produced once per asset by
 * `frame-sampling.ts` and consumed by all three visual derivations
 * (shot-detection, motion-energy, head-tail-detection) — see
 * `visual-analysis.ts` for the "one pass, three derivations" orchestration
 * task A calls for.
 *
 * Deliberately NOT a JPEG blob (unlike the CLIP embedding indexer's frame
 * sampler in `services/search/embedding-service.ts`, which needs real pixel
 * data for the vision model): everything below is derivable from a tiny
 * downscaled canvas read and is cheap enough to keep every sample in memory
 * for a hard-cut/motion/black scan without re-decoding.
 */

export interface FrameSample {
	/** Seconds from the start of the media. */
	timestampSec: number;
	/** Mean luma over the whole downscaled frame, 0-255. */
	meanLuma: number;
	/** 16-bucket luma histogram, normalized to sum to 1. */
	lumaHistogram: number[];
	/**
	 * Mean luma of N equal-width vertical strips (left→right), 0-255 each.
	 * High variance across strips + low variance over time is the signature
	 * of a static vertical test pattern (SMPTE color bars).
	 */
	stripMeans: number[];
	/**
	 * Mean luma of [top, middle, bottom] equal-height horizontal bands, 0-255
	 * each. Top/bottom << middle is the signature of letterboxing.
	 */
	bandMeans: [number, number, number];
}

export const LUMA_HISTOGRAM_BUCKETS = 16;
export const STRIP_COUNT = 7;

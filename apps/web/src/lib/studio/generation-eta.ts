import type { VideoResolution } from "@/lib/studio/provider-adapter";

/**
 * Heuristic ETA (seconds) for a single video generation — paces the
 * composer's progress strip (see generation-form.tsx). This is deliberately
 * NOT a measured per-backend model: it's a rough shared curve so the strip
 * has something reasonable to animate toward. A wrong estimate only changes
 * how the strip paces itself; it never affects the real poll/complete logic
 * (`useStudioGeneration` decides "done" independently).
 *
 * Exported as tunable `const`s rather than baked into the function so a
 * future pass can recalibrate against real BytePlus/Kling/Veo timings
 * without touching call sites.
 */
export const GENERATION_ETA_BASE_SECONDS = 22;
export const GENERATION_ETA_SECONDS_PER_CLIP_SECOND = 3.5;
/** Multiplier applied to the whole estimate at 1080p and above — rendering
 *  scales up noticeably faster than linearly with resolution. */
export const GENERATION_ETA_1080P_MULTIPLIER = 1.75;
/** Fallback clip length (seconds) used when `durationSec` isn't known yet. */
export const GENERATION_ETA_DEFAULT_DURATION_SEC = 5;

export interface EstimateGenerationSecondsInput {
	/** Selected backend id — accepted for future per-backend tuning; the
	 *  current heuristic is backend-agnostic. */
	backendId?: string;
	resolution?: VideoResolution | string;
	durationSec?: number;
}

/**
 * `base 22s + 3.5s × durationSec` at ≤720p; the total is multiplied ×1.75
 * once resolution reaches 1080p (or higher, for future-proofing against a
 * 4K/2K tier). Always returns a positive, finite number of seconds.
 */
export function estimateGenerationSeconds({
	resolution,
	durationSec,
}: EstimateGenerationSecondsInput): number {
	const clipSeconds =
		durationSec && durationSec > 0
			? durationSec
			: GENERATION_ETA_DEFAULT_DURATION_SEC;

	const base =
		GENERATION_ETA_BASE_SECONDS +
		GENERATION_ETA_SECONDS_PER_CLIP_SECOND * clipSeconds;

	const isHighRes = resolution ? /1080|2k|4k/i.test(String(resolution)) : false;

	return isHighRes ? base * GENERATION_ETA_1080P_MULTIPLIER : base;
}

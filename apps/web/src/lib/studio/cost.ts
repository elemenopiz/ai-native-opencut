import type { VideoResolution } from "@/lib/studio/provider-adapter";

/** Per-second video render cost range, by resolution (USD). */
export const RATE_PER_SEC: Record<VideoResolution, [number, number]> = {
	"480p": [0.03, 0.05],
	"720p": [0.07, 0.1],
	"1080p": [0.23, 0.37],
};

/** GPT Image still cost when high-consistency renders a fresh per-shot frame (USD). */
export const PER_SHOT_STILL_COST = 0.04;

export function formatUsd(n: number): string {
	return n < 1 ? `${(n * 100).toFixed(0)}¢` : `$${n.toFixed(2)}`;
}

/** Live, dynamic cost estimate for the current settings. */
export function estimateCost(
	resolution: VideoResolution,
	duration: number,
	addsPerShotStill: boolean,
): { low: number; high: number } {
	const [lo, hi] = RATE_PER_SEC[resolution];
	const still = addsPerShotStill ? PER_SHOT_STILL_COST : 0;
	return { low: lo * duration + still, high: hi * duration + still };
}

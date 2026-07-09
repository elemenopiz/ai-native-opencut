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

/**
 * Whether a generation renders a fresh per-shot still (the +1 GPT Image cost).
 * Single source of truth so the three cost-estimate call sites can't drift on
 * what counts toward cost.
 */
export function addsPerShotStill(
	hasPersona: boolean,
	consistencyMode: "high" | "fast" | undefined,
): boolean {
	return hasPersona && consistencyMode === "high";
}

/**
 * Live, dynamic cost estimate for the current settings. `count` variations share
 * a single per-shot still (it's rendered once for the whole batch), so the still
 * cost is added ONCE while the per-second video cost scales with count.
 */
export function estimateCost(
	resolution: VideoResolution,
	duration: number,
	rendersStill: boolean,
	count = 1,
): { low: number; high: number } {
	const [lo, hi] = RATE_PER_SEC[resolution];
	const still = rendersStill ? PER_SHOT_STILL_COST : 0;
	return {
		low: lo * duration * count + still,
		high: hi * duration * count + still,
	};
}

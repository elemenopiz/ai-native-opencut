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
 * Whether a generation renders a fresh per-shot still that adds API cost (the +1
 * GPT Image charge). Single source of truth so the cost-estimate call sites can't
 * drift on what counts toward cost.
 *
 * Only "high" (Balanced) bills for the still — it goes through gpt-image-2.
 * "fast" reuses the anchor (no still) and "durable" renders the still locally on
 * the PhotoMaker image service ($0 API cost), so neither adds to the estimate.
 */
export function addsPerShotStill(
	hasPersona: boolean,
	consistencyMode: "high" | "fast" | "durable" | undefined,
): boolean {
	switch (consistencyMode) {
		case "high":
			return hasPersona;
		case "fast":
		case "durable":
		case undefined:
			return false;
	}
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

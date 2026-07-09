import type { VideoResolution } from "@/lib/studio/provider-adapter";

/** A low/high USD cost range. */
export interface CostRange {
	low: number;
	high: number;
}

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
): CostRange {
	const [lo, hi] = RATE_PER_SEC[resolution];
	const still = rendersStill ? PER_SHOT_STILL_COST : 0;
	return {
		low: lo * duration * count + still,
		high: hi * duration * count + still,
	};
}

/**
 * The subset of a `GenerationSpec` a cost estimate depends on. Kept structural
 * (rather than importing the full `GenerationSpec`) so this stays a leaf module
 * with no timeline dependency — every `GenerationSpec` is assignable to it.
 */
export interface CostSpec {
	resolution: VideoResolution;
	duration: number;
	personaId?: string;
	consistencyMode?: "high" | "fast" | "durable";
}

/** Cost of generating `count` takes of a single shot from its spec. */
export function estimateSpecCost(spec: CostSpec, count = 1): CostRange {
	const rendersStill = addsPerShotStill(!!spec.personaId, spec.consistencyMode);
	return estimateCost(spec.resolution, spec.duration, rendersStill, count);
}

/**
 * Cost of a whole batch: `count` takes for each of `specs`. `clips` is the total
 * number of takes that will actually be rendered (the batch's "size"), so a
 * caller can show "generate N clips (~$low–$high)" from one call.
 */
export function estimateBatchCost(
	specs: CostSpec[],
	count = 1,
): CostRange & { clips: number } {
	const total = specs.reduce(
		(acc, spec) => {
			const c = estimateSpecCost(spec, count);
			return { low: acc.low + c.low, high: acc.high + c.high };
		},
		{ low: 0, high: 0 },
	);
	return { ...total, clips: specs.length * count };
}

// ─── Approval gate (concept: cost-preview gate) ──────────────────────────────
// Before a batch of generations spends real API credits, we surface the
// estimate and require explicit approval. Trivial single re-rolls fall under the
// threshold and run without a prompt; anything pricier confirms first.

/**
 * Default USD ceiling above which a generation should be confirmed before it
 * runs. Sensible middle ground: a single short 480p re-roll stays under it, but
 * a multi-shot "generate all" (or a few 1080p takes) crosses it. User-overridable
 * via `studio-settings-store`'s `approvalThresholdUsd`.
 */
export const DEFAULT_APPROVAL_THRESHOLD_USD = 0.5;

/**
 * Whether an estimate warrants explicit approval. Gates on the HIGH end of the
 * range (fail toward asking) against a configurable threshold.
 */
export function needsApproval(
	estimate: CostRange,
	threshold: number = DEFAULT_APPROVAL_THRESHOLD_USD,
): boolean {
	return estimate.high >= threshold;
}

/** Render an estimate as a compact "$low–$high" string. */
export function formatCostRange(estimate: CostRange): string {
	return `${formatUsd(estimate.low)}–${formatUsd(estimate.high)}`;
}

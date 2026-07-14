/**
 * Cost helpers — normalize every backend's estimate into one Byorn credit unit
 * and convert to the `TakeCost` we stamp on takes. The point is the inverse of
 * Firefly's opacity: an honest number BEFORE you generate, per model, on the slot.
 */

import type { CostEstimate } from "@/lib/studio/backends/types";
import type { TakeCost } from "@/types/timeline";

/**
 * Shared video credit model, normalized to Byorn credits. Adapters may override
 * with a provider-specific rate, but reusing this keeps cross-backend numbers
 * comparable (the whole reason to normalize). Roughly resolution-linear.
 */
export const VIDEO_CREDITS_PER_SEC: Record<string, number> = {
	"480p": 20,
	"720p": 50,
	"1080p": 100,
};

export function estimateVideoCredits(
	resolution: string | undefined,
	durationSec: number | undefined,
): number {
	const rate = VIDEO_CREDITS_PER_SEC[resolution ?? "720p"] ?? 50;
	const dur = durationSec ?? 5;
	return Math.round(rate * dur);
}

/** Convert a backend estimate into a take-stamped cost. */
export function toTakeCost(
	estimate: CostEstimate,
	opts: { estimated: boolean },
): TakeCost {
	return {
		credits: estimate.credits,
		usd: estimate.usd,
		basis: estimate.basis,
		estimated: opts.estimated,
	};
}

/** Sum a set of take costs — for a slot's "spend on this slot" tally. */
export function sumCredits(costs: (TakeCost | undefined)[]): number {
	return costs.reduce((acc, c) => acc + (c?.credits ?? 0), 0);
}

/** Format credits for compact UI (e.g. "1.2k"). */
export function formatCredits(credits: number): string {
	if (credits >= 1000) return `${(credits / 1000).toFixed(1)}k`;
	return String(credits);
}

/**
 * Bucket a backend's normalized credit estimate into a RELATIVE cost tier, judged
 * against the cheapest available backend in the same modality (`minCredits`). This
 * is the signal the Director reasons over — "draft on cheap, hero on premium" —
 * without hard-coding provider names: a backend within ~⅓ of the floor is `cheap`,
 * up to ~2.5× is `standard`, pricier than that is `premium`. Relative (not
 * absolute) so the buckets stay meaningful as providers come and go.
 */
export function relativeCostTier(
	credits: number,
	minCredits: number,
): "cheap" | "standard" | "premium" {
	const ratio = minCredits > 0 ? credits / minCredits : 1;
	if (ratio <= 1.34) return "cheap";
	if (ratio <= 2.5) return "standard";
	return "premium";
}

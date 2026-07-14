/**
 * Cost helpers — convert a backend's estimate to the `TakeCost` we stamp on
 * takes, plus routing-tier helpers. The point is the inverse of Firefly's
 * opacity: an honest number BEFORE you generate, per model, on the slot.
 *
 * Video backends' own `estimateCost().credits` (in `backends/video/*.ts`) are
 * sourced directly from `lib/credits/cost-table.ts`'s `costFor()` — the same
 * server-authoritative billing table the credit-preview UI mirrors — so there
 * is exactly one number for "what will this cost," not a separate normalized
 * routing unit that can drift from real billing.
 */

import type { CostEstimate } from "@/lib/studio/backends/types";
import type { TakeCost } from "@/types/timeline";

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

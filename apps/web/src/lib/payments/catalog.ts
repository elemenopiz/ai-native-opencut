/**
 * Product catalog — the single mapping of Polar products → credit amounts, for
 * BOTH one-time top-up packs and recurring subscription tiers.
 *
 * This is the source of truth in two directions:
 *   • checkout: packKey/tierKey → productId (what to check out)
 *   • webhook:  productId → { credits, kind } (what to grant on payment)
 *
 * The credit↔$ anchor is ~1 credit = US$0.01 of real provider cost; prices in $
 * are the owner's call and live in the Polar dashboard, NOT here — this file
 * only maps a purchased product to the credits it grants.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TODO(owner): replace every `productId` below with the REAL Polar product id
 * from your dashboard (Sandbox and Production have DIFFERENT ids), and confirm
 * the credit amounts + the $ prices you set on each Polar product. Until these
 * are real ids, checkout will 4xx from Polar and the webhook won't match a
 * product (so it safely grants nothing).
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type PackKey = "pack_500" | "pack_2000" | "pack_5000";
export type TierKey = "starter" | "pro" | "studio";

export interface TopUpPack {
	kind: "topup";
	key: PackKey;
	/** Polar product id for this one-time pack. TODO: set real id. */
	productId: string;
	/** Credits granted once when the order is paid. */
	credits: number;
	label: string;
	description: string;
}

export interface SubscriptionTier {
	kind: "subscription";
	key: TierKey;
	/** Polar product id for this recurring plan. TODO: set real id. */
	productId: string;
	/** Credits granted per billing period (each renewal grants once). */
	creditsPerPeriod: number;
	label: string;
	description: string;
}

export type CatalogEntry = TopUpPack | SubscriptionTier;

// One-time top-up packs (buy credits outright).
export const TOP_UP_PACKS: TopUpPack[] = [
	{
		kind: "topup",
		key: "pack_500",
		productId: "TODO_POLAR_PRODUCT_PACK_500", // TODO: set real Polar product id
		credits: 500,
		label: "500 credits",
		description: "Starter top-up",
	},
	{
		kind: "topup",
		key: "pack_2000",
		productId: "TODO_POLAR_PRODUCT_PACK_2000", // TODO: set real Polar product id
		credits: 2000,
		label: "2,000 credits",
		description: "Most popular",
	},
	{
		kind: "topup",
		key: "pack_5000",
		productId: "TODO_POLAR_PRODUCT_PACK_5000", // TODO: set real Polar product id
		credits: 5000,
		label: "5,000 credits",
		description: "Best value",
	},
];

// Recurring subscription tiers (credits refill each billing period).
export const SUBSCRIPTION_TIERS: SubscriptionTier[] = [
	{
		kind: "subscription",
		key: "starter",
		productId: "TODO_POLAR_PRODUCT_TIER_STARTER", // TODO: set real Polar product id
		creditsPerPeriod: 1000,
		label: "Starter",
		description: "1,000 credits / month",
	},
	{
		kind: "subscription",
		key: "pro",
		productId: "TODO_POLAR_PRODUCT_TIER_PRO", // TODO: set real Polar product id
		creditsPerPeriod: 5000,
		label: "Pro",
		description: "5,000 credits / month",
	},
	{
		kind: "subscription",
		key: "studio",
		productId: "TODO_POLAR_PRODUCT_TIER_STUDIO", // TODO: set real Polar product id
		creditsPerPeriod: 15000,
		label: "Studio",
		description: "15,000 credits / month",
	},
];

const ALL_ENTRIES: CatalogEntry[] = [...TOP_UP_PACKS, ...SUBSCRIPTION_TIERS];

/** Look up a top-up pack by its packKey. */
export function packByKey(key: string): TopUpPack | undefined {
	return TOP_UP_PACKS.find((p) => p.key === key);
}

/** Look up a subscription tier by its tierKey. */
export function tierByKey(key: string): SubscriptionTier | undefined {
	return SUBSCRIPTION_TIERS.find((t) => t.key === key);
}

/**
 * Resolve a checkout request — accepts an explicit productId, a packKey, or a
 * tierKey (in that order) — to the concrete productId to check out, or null if
 * none match. `productId` is validated against the catalog so a client can only
 * ever check out a product we actually sell.
 */
export function resolveProductId(input: {
	productId?: string;
	packKey?: string;
	tierKey?: string;
}): string | null {
	if (input.productId) {
		return ALL_ENTRIES.some((e) => e.productId === input.productId)
			? input.productId
			: null;
	}
	if (input.packKey) return packByKey(input.packKey)?.productId ?? null;
	if (input.tierKey) return tierByKey(input.tierKey)?.productId ?? null;
	return null;
}

export interface ProductCredits {
	credits: number;
	kind: "topup" | "subscription";
	label: string;
}

/**
 * The credits (and kind) a given Polar productId grants when paid, or null if
 * the product isn't in our catalog (webhook then grants nothing). This is the
 * reverse map the webhook uses to turn an order's product into a grant amount.
 */
export function creditsForProduct(
	productId: string | null | undefined,
): ProductCredits | null {
	if (!productId) return null;
	const pack = TOP_UP_PACKS.find((p) => p.productId === productId);
	if (pack) {
		return { credits: pack.credits, kind: "topup", label: pack.label };
	}
	const tier = SUBSCRIPTION_TIERS.find((t) => t.productId === productId);
	if (tier) {
		return {
			credits: tier.creditsPerPeriod,
			kind: "subscription",
			label: tier.label,
		};
	}
	return null;
}

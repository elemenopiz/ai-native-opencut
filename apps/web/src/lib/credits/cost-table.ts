/**
 * Credit cost table — the single, SERVER-AUTHORITATIVE source of what a paid
 * action costs. The client never supplies a price; the server derives
 * backendId + action + params and looks the cost up here.
 *
 * 1 credit = US$0.01 of real provider cost, rounded UP. This table holds the
 * COST (what we pay the provider), NOT the sale price — margin lives in the
 * future price of a credit, not here. Numbers below are researched real
 * provider rates (video priced per generated second, images flat per image).
 *
 * These credit values are distinct from the backends' `estimateCost().credits`
 * (a relative routing/normalization unit); this table is the billing unit.
 *
 * The `backendId` keys MUST match the ids registered in `lib/studio/backends/*`
 * (verified against video/ and image/ adapters).
 */

export type CreditAction = "video" | "image" | "enhance-prompt" | "infographic";

/** Credits charged per generated SECOND of video, per backend. */
const VIDEO_CREDITS_PER_SEC: Record<string, number> = {
	"byteplus-seedance": 10,
	kling: 10,
	luma: 10,
	"google-veo": 20,
	runway: 35,
	pika: 5,
};

/** Flat credits per generated image, per backend. */
const IMAGE_CREDITS_FLAT: Record<string, number> = {
	"openai-gpt-image": 4,
	"bfl-flux": 4,
	"google-imagen": 4,
	"google-nano-banana": 4,
	ideogram: 3,
};

/**
 * Actions that are always FREE (cost 0) regardless of backend. These are local
 * / cheap helper actions we deliberately don't meter. Local features are NEVER
 * metered — this set is only for the free CLOUD helpers.
 */
const FREE_ACTIONS = new Set<string>(["enhance-prompt", "infographic"]);

/** Default clip length (seconds) when a caller doesn't specify one. */
export const DEFAULT_CLIP_SECONDS = 5;

export interface CostParams {
	/** Video clip length in seconds. Defaults to {@link DEFAULT_CLIP_SECONDS}. */
	seconds?: number;
	/** How many images to generate (flat cost × count). Defaults to 1. */
	count?: number;
}

/**
 * Whole-credit cost of one paid action, computed server-side.
 *
 *   video → ceil(perSecRate × seconds)
 *   image → flatRate × count
 *   free  → 0
 *
 * Any paid (non-free) action costs at least 1 credit — we never dispatch a
 * billable provider call for 0 credits. Unknown backend/action for a paid
 * modality throws, so a mispriced route fails loudly instead of billing $0.
 */
export function costFor(
	backendId: string,
	action: CreditAction,
	params: CostParams = {},
): number {
	if (FREE_ACTIONS.has(action)) return 0;

	const { seconds = DEFAULT_CLIP_SECONDS, count = 1 } = params;

	if (action === "video") {
		const rate = VIDEO_CREDITS_PER_SEC[backendId];
		if (rate == null) {
			throw new Error(`No video credit rate for backend "${backendId}"`);
		}
		const credits = Math.ceil(rate * seconds);
		return Math.max(1, credits);
	}

	if (action === "image") {
		const rate = IMAGE_CREDITS_FLAT[backendId];
		if (rate == null) {
			throw new Error(`No image credit rate for backend "${backendId}"`);
		}
		const credits = Math.ceil(rate * Math.max(1, count));
		return Math.max(1, credits);
	}

	// Only reachable if a free action escaped the FREE_ACTIONS set above — treat
	// as free rather than billing an unpriced action.
	return 0;
}

/** Whether an action is free (never metered). */
export function isFreeAction(action: CreditAction): boolean {
	return FREE_ACTIONS.has(action);
}

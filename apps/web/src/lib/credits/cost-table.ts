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

export type CreditAction =
	| "video"
	| "image"
	| "audio"
	| "enhance-prompt"
	| "infographic";

/** Credits charged per generated SECOND of video, per backend. */
const VIDEO_CREDITS_PER_SEC: Record<string, number> = {
	"byteplus-seedance": 10,
	kling: 10,
	// Registered backend id is "luma-ray" (see `backends/video/luma.ts`), not
	// "luma" — this key must match `GenerationBackend.id` exactly or costFor()
	// throws for every Luma generation.
	"luma-ray": 10,
	runway: 35,
	pika: 5,
	// Google Veo 3.1 (native synced audio). ai.google.dev/gemini-api/docs/pricing
	// (2026-07): Standard is $0.40/s flat across 720p+1080p → 40 credits/sec —
	// the flat per-backend-id shape here doesn't vary by resolution (same
	// simplification every other row uses), so this is the one real rate.
	"google-veo": 40,
	// Fast tier: $0.10/s @720p, $0.12/s @1080p — priced at the higher (1080p)
	// rate so a single flat credits/sec never underbills a 1080p render.
	"google-veo-fast": 12,
};

/** Flat credits per generated image, per backend. */
const IMAGE_CREDITS_FLAT: Record<string, number> = {
	"openai-gpt-image": 4,
	"bfl-flux": 4,
	"google-imagen": 4,
	// Nano Banana Pro (Gemini 3 Pro Image): ~$0.134/image at 1K/2K → ceil to 14.
	// 4K (~$0.24) is not exposed in the beta UI (cost control).
	"google-nano-banana": 14,
	ideogram: 3,
};

/**
 * Credits charged per generated SECOND of audio, per backend.
 *   fal-mmaudio      — video-to-audio "score": fal.ai lists MMAudio V2 at
 *                       ~$0.001/generated-second → 0.1 credit/sec.
 *   elevenlabs-music — text-to-music: ElevenLabs Music is $0.15/minute →
 *                       $0.0025/sec → 0.25 credit/sec (≈15 credits/min).
 * Both round UP to the nearest whole credit with a 1-credit floor (below),
 * same convention as video/image.
 */
const AUDIO_CREDITS_PER_SEC: Record<string, number> = {
	"fal-mmaudio": 0.1,
	"elevenlabs-music": 0.25,
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

	if (action === "audio") {
		const rate = AUDIO_CREDITS_PER_SEC[backendId];
		if (rate == null) {
			throw new Error(`No audio credit rate for backend "${backendId}"`);
		}
		const credits = Math.ceil(rate * seconds);
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

/**
 * Cheapest/priciest registered video backend's credit cost for `seconds` —
 * used by the client-safe estimator (`lib/credits/estimate.ts`) when the UI
 * doesn't yet know which backend will actually run (e.g. a not-yet-routed
 * batch). An honest "could cost this much" pre-routing range, derived from
 * this SAME table so it never drifts from the real per-backend rates above.
 */
export function videoCreditsRange(seconds: number = DEFAULT_CLIP_SECONDS): {
	low: number;
	high: number;
} {
	const rates = Object.values(VIDEO_CREDITS_PER_SEC);
	return {
		low: Math.max(1, Math.ceil(Math.min(...rates) * seconds)),
		high: Math.max(1, Math.ceil(Math.max(...rates) * seconds)),
	};
}

/** Cheapest/priciest registered image backend's flat credit cost for `count`
 *  images — same pre-routing-estimate purpose as {@link videoCreditsRange}. */
export function imageCreditsRange(count = 1): { low: number; high: number } {
	const rates = Object.values(IMAGE_CREDITS_FLAT);
	const n = Math.max(1, count);
	return {
		low: Math.max(1, Math.ceil(Math.min(...rates) * n)),
		high: Math.max(1, Math.ceil(Math.max(...rates) * n)),
	};
}

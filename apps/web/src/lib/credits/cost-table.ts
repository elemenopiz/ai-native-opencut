/**
 * Credit cost table — the single, SERVER-AUTHORITATIVE source of what a paid
 * action costs. The client never supplies a price; the server derives
 * backendId + action + params and looks the cost up here.
 *
 * 1 credit = US$0.01. This table's OUTPUT — what `costFor()` returns — is the
 * SALE price charged to the user, NOT raw provider cost. Real provider cost
 * (COGS) and the markup applied over it are kept as two separate, explicit
 * layers below (COGS table → markup table → derived SALE table) so the margin
 * on every priced op is auditable at a glance instead of living inside one
 * hand-picked "credits per unit" constant. Before this pass the table held raw
 * COGS with ZERO markup (we billed exactly what we paid the provider) and
 * priced Seedance flat regardless of resolution — both fixed here.
 *
 * These credit values are distinct from the backends' `estimateCost().credits`
 * (a relative routing/normalization unit for the router's cheap/standard/
 * premium tiering); this table is the billing unit, and adapters' own
 * `estimateCost()` should call `costFor()` rather than hand-rolling a second
 * price (see `allPricedOps()` below for the audit surface that keeps them in
 * sync).
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

/**
 * Video resolutions `costFor` prices. Declared locally rather than imported
 * from `provider-adapter.ts` (a server module that reads `webEnv`) so this
 * file stays a pure, client-safe leaf with zero transitive server imports —
 * `lib/credits/estimate.ts` re-exports it for UI callers.
 */
export type VideoResolution = "480p" | "720p" | "1080p";

// ─── COGS — what we actually pay the provider, per generated SECOND ────────

/**
 * BytePlus ModelArk / Seedance 2.0 (`dreamina-seedance-2-0-260128`) is the
 * only video backend whose real per-second rate is resolution-degressive, so
 * it gets its own per-resolution COGS table rather than one flat number.
 * Source: BytePlus official rate card,
 * https://docs.byteplus.com/en/docs/ModelArk/1099320 (fetched 2026-07-14).
 * 4K ($0.778/sec) is intentionally excluded — not offered in the UI, so
 * `costFor` never has to price it.
 */
const SEEDANCE_COGS_PER_SEC: Record<VideoResolution, number> = {
	"480p": 7, // $0.07/sec
	"720p": 15.2, // $0.152/sec
	"1080p": 37.4, // $0.374/sec
};
/** @see SEEDANCE_COGS_PER_SEC */
const SEEDANCE_COGS_LAST_VERIFIED = "2026-07-14";

/**
 * COGS per generated SECOND for backends whose provider rate does NOT vary by
 * resolution (or for which we don't yet have a resolution-tiered rate card).
 * kling/luma-ray/pika/runway are the exact numbers this table charged flat, at
 * zero markup, before this pass — carried forward as "what we pay," not
 * re-researched here (UNVERIFIED against a fresh rate card, no published
 * $/sec figure found for any of the four — flag for follow-up).
 *
 * google-veo / google-veo-fast landed concurrently (feat/openai-google-models)
 * at this table's prior zero-markup convention — Standard is $0.40/s flat
 * across 720p+1080p → 40 credits/sec; Fast is priced at the higher 1080p rate
 * ($0.12/s) so one flat credits/sec never underbills a 1080p render → 12
 * credits/sec. Source: ai.google.dev/gemini-api/docs/pricing (2026-07).
 */
const VIDEO_COGS_PER_SEC_FLAT: Record<string, number> = {
	kling: 10,
	"luma-ray": 10,
	pika: 5,
	runway: 35,
	"google-veo": 40,
	"google-veo-fast": 12,
};
/** @see VIDEO_COGS_PER_SEC_FLAT */
const VIDEO_COGS_FLAT_LAST_VERIFIED = "2026-07-14";

/**
 * COGS per generated image, per backend. Carried forward unchanged from the
 * pre-markup table (these WERE the billed flat rates).
 *   google-nano-banana — Gemini 3 Pro Image: ~$0.134/image at 1K/2K → ceil to
 *                         14 (Google's Gemini 3 Pro Image pricing page).
 *   openai-gpt-image / bfl-flux / google-imagen / ideogram — UNVERIFIED
 *                         order-of-magnitude estimates (no fresh rate-card
 *                         pull this pass); see each adapter file's own header
 *                         comment for the per-backend research trail.
 */
const IMAGE_COGS_FLAT: Record<string, number> = {
	"openai-gpt-image": 4,
	"bfl-flux": 4,
	"google-imagen": 4,
	"google-nano-banana": 14,
	ideogram: 3,
};
/** @see IMAGE_COGS_FLAT */
const IMAGE_COGS_LAST_VERIFIED = "2026-07-14";

// ─── Markup — founder-approved, resolution-degressive for Seedance ─────────

/**
 * Seedance's markup shrinks as resolution climbs (thinner margin at the top
 * end, since 1080p COGS is already steep) — founder-approved figures.
 */
const SEEDANCE_MARKUP: Record<VideoResolution, number> = {
	"480p": 3.0,
	"720p": 2.2,
	"1080p": 1.6,
};

/**
 * Flat markup for the other video backends (their COGS doesn't vary by
 * resolution, so neither does the markup). Runway's is expressed as the exact
 * fraction that lands on the founder-approved clean 80 cr/sec sale price
 * (35 × 80/35 = 80 precisely — avoids float drift from writing "≈2.29").
 *
 * google-veo/google-veo-fast landed after the initial founder-approved list —
 * founder-approved degressive markup (same principle as Seedance: thinner
 * margin on the pricier tier): Standard (COGS 40, expensive) → 1.6x = 64
 * cr/sec; Fast (COGS 12, cheap) → 2.0x = 24 cr/sec.
 */
const VIDEO_MARKUP_FLAT: Record<string, number> = {
	kling: 2.2,
	"luma-ray": 2.2,
	pika: 2.2,
	runway: 80 / 35,
	"google-veo": 1.6,
	"google-veo-fast": 2.0,
};

/** Flat markup applied to every image backend's COGS. */
const IMAGE_MARKUP = 2.5;

/** Sale rate = ceil(COGS × markup) — never round DOWN a sale price. */
function saleRate(cogs: number, markup: number): number {
	return Math.ceil(cogs * markup);
}

// ─── Sale price — this is what costFor() actually charges ─────────────────

/** Credits charged per generated SECOND of Seedance video, by resolution.
 *  480p=21 (7×3.0), 720p=34 (15.2×2.2), 1080p=60 (37.4×1.6). */
const SEEDANCE_SALE_PER_SEC: Record<VideoResolution, number> = {
	"480p": saleRate(SEEDANCE_COGS_PER_SEC["480p"], SEEDANCE_MARKUP["480p"]),
	"720p": saleRate(SEEDANCE_COGS_PER_SEC["720p"], SEEDANCE_MARKUP["720p"]),
	"1080p": saleRate(SEEDANCE_COGS_PER_SEC["1080p"], SEEDANCE_MARKUP["1080p"]),
};

/** Credits charged per generated SECOND of video, for the flat-rate backends.
 *  kling=22, luma-ray=22, pika=11, runway=80, google-veo=64, google-veo-fast=24. */
const VIDEO_SALE_PER_SEC_FLAT: Record<string, number> = Object.fromEntries(
	Object.entries(VIDEO_COGS_PER_SEC_FLAT).map(([id, cogs]) => [
		id,
		saleRate(cogs, VIDEO_MARKUP_FLAT[id]),
	]),
);

/** Flat credits per generated image, per backend.
 *  google-nano-banana=35, openai-gpt-image=10, bfl-flux=10, google-imagen=10,
 *  ideogram=8 (3×2.5=7.5, rounded up). */
const IMAGE_SALE_FLAT: Record<string, number> = Object.fromEntries(
	Object.entries(IMAGE_COGS_FLAT).map(([id, cogs]) => [
		id,
		saleRate(cogs, IMAGE_MARKUP),
	]),
);

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

/** Default video resolution when a caller doesn't specify one — mirrors every
 *  video adapter's own `req.resolution ?? "720p"` submit-time default, so an
 *  omitted resolution here prices the same tier that will actually be
 *  submitted. */
const DEFAULT_RESOLUTION: VideoResolution = "720p";

export interface CostParams {
	/** Video clip length in seconds. Defaults to {@link DEFAULT_CLIP_SECONDS}. */
	seconds?: number;
	/** How many images to generate (flat cost × count). Defaults to 1. */
	count?: number;
	/** Video resolution — required to price BytePlus Seedance correctly (its
	 *  sale rate is resolution-degressive); ignored by the flat-rate video
	 *  backends and by images. Defaults to {@link DEFAULT_RESOLUTION}. */
	resolution?: VideoResolution;
}

/**
 * Whole-credit SALE price of one paid action, computed server-side.
 *
 *   video → ceil(saleRatePerSec(backend[, resolution]) × seconds)
 *   image → flatSaleRate × count
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

	const {
		seconds = DEFAULT_CLIP_SECONDS,
		count = 1,
		resolution = DEFAULT_RESOLUTION,
	} = params;

	if (action === "video") {
		const rate =
			backendId === "byteplus-seedance"
				? SEEDANCE_SALE_PER_SEC[resolution]
				: VIDEO_SALE_PER_SEC_FLAT[backendId];
		if (rate == null) {
			throw new Error(`No video credit rate for backend "${backendId}"`);
		}
		const credits = Math.ceil(rate * seconds);
		return Math.max(1, credits);
	}

	if (action === "image") {
		const rate = IMAGE_SALE_FLAT[backendId];
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
 *
 * Pass `resolution` when it's known even without a backend (e.g. the form's
 * selected resolution) to narrow Seedance's contribution to that one tier
 * instead of spanning all three.
 */
export function videoCreditsRange(
	seconds: number = DEFAULT_CLIP_SECONDS,
	resolution?: VideoResolution,
): {
	low: number;
	high: number;
} {
	const seedanceRates = resolution
		? [SEEDANCE_SALE_PER_SEC[resolution]]
		: Object.values(SEEDANCE_SALE_PER_SEC);
	const rates = [...seedanceRates, ...Object.values(VIDEO_SALE_PER_SEC_FLAT)];
	return {
		low: Math.max(1, Math.ceil(Math.min(...rates) * seconds)),
		high: Math.max(1, Math.ceil(Math.max(...rates) * seconds)),
	};
}

/** Cheapest/priciest registered image backend's flat credit cost for `count`
 *  images — same pre-routing-estimate purpose as {@link videoCreditsRange}. */
export function imageCreditsRange(count = 1): { low: number; high: number } {
	const rates = Object.values(IMAGE_SALE_FLAT);
	const n = Math.max(1, count);
	return {
		low: Math.max(1, Math.ceil(Math.min(...rates) * n)),
		high: Math.max(1, Math.ceil(Math.max(...rates) * n)),
	};
}

/** One priced op's COGS vs. SALE — the audit row `allPricedOps()` returns. */
export interface PricedOp {
	backendId: string;
	action: "video" | "image";
	/** Only set for the per-resolution Seedance rows. */
	resolution?: VideoResolution;
	/** Provider cost, credits per second (video) or per image (image). */
	cogs: number;
	/** What `costFor` actually charges, same unit as `cogs`. */
	sale: number;
	lastVerified: string;
}

/**
 * Every priced backend/action(/resolution) combo this table knows about, COGS
 * next to SALE — the source of truth for a no-negative-margin sanity check
 * (see `cost-table.test.ts`) and any future pricing-audit surface. Walking
 * this instead of the raw tables means a newly added backend is audited for
 * free the moment it's wired into the COGS/markup tables above.
 */
export function allPricedOps(): PricedOp[] {
	const rows: PricedOp[] = [];

	for (const resolution of Object.keys(
		SEEDANCE_COGS_PER_SEC,
	) as VideoResolution[]) {
		rows.push({
			backendId: "byteplus-seedance",
			action: "video",
			resolution,
			cogs: SEEDANCE_COGS_PER_SEC[resolution],
			sale: SEEDANCE_SALE_PER_SEC[resolution],
			lastVerified: SEEDANCE_COGS_LAST_VERIFIED,
		});
	}

	for (const [backendId, cogs] of Object.entries(VIDEO_COGS_PER_SEC_FLAT)) {
		rows.push({
			backendId,
			action: "video",
			cogs,
			sale: VIDEO_SALE_PER_SEC_FLAT[backendId],
			lastVerified: VIDEO_COGS_FLAT_LAST_VERIFIED,
		});
	}

	for (const [backendId, cogs] of Object.entries(IMAGE_COGS_FLAT)) {
		rows.push({
			backendId,
			action: "image",
			cogs,
			sale: IMAGE_SALE_FLAT[backendId],
			lastVerified: IMAGE_COGS_LAST_VERIFIED,
		});
	}

	return rows;
}

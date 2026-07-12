/**
 * Private-beta welcome grant, applied once per account by the better-auth
 * `user.create.after` hook (see lib/auth/server.ts).
 *
 * PURE MODULE — no ledger/db imports, so client components (onboarding, auth
 * form) can show the number without pulling server code into the bundle.
 *
 * Sizing (2026-07 beta): 650 credits ≈ US$5 of Seedance video (10 five-second
 * clips) + US$1.50 of Nano Banana Pro stills (~10 images). The split is a
 * HARD earmark, not just pricing — `MODALITY_SPLIT` below is enforced by the
 * ledger at reserve time. Director chat / enhance-prompt are free actions
 * (rate-limited, not metered). Top up engaged users via
 * POST /api/admin/credits/grant.
 */
export const SIGNUP_GRANT_CREDITS = 650;

/**
 * Owner accounts get an effectively-unlimited balance at signup instead of
 * the standard grant. Matched case-insensitively against the signup email.
 */
export const OWNER_EMAILS = ["zsrumishaikh@gmail.com"];

/** 1,000,000 credits ≈ $10k of provider cost — never runs out in a beta. */
export const OWNER_GRANT_CREDITS = 1_000_000;

/** The welcome grant for a given signup email. */
export function signupGrantFor(email: string | null | undefined): number {
	const normalized = email?.trim().toLowerCase();
	return normalized && OWNER_EMAILS.includes(normalized)
		? OWNER_GRANT_CREDITS
		: SIGNUP_GRANT_CREDITS;
}

/**
 * Per-modality earmarks of the welcome grant: 650 credits redeem as EXACTLY
 * ≈$5 of Seedance video (500) + ≈$1.50 of Nano Banana Pro stills (150) — the
 * balance is deliberately NOT fungible across modalities. Enforced by the
 * ledger at reserve time (see `reserve`'s `modality` option).
 */
export const MODALITY_SPLIT = { video: 500, image: 150 } as const;

export type BudgetModality = keyof typeof MODALITY_SPLIT;

/**
 * A user's lifetime budget for one modality, derived from everything they've
 * ever been granted so the split scales with top-ups and the owner grant:
 * video gets the 500/650 share (floored), image gets the remainder — the two
 * always sum to the total, so no credit is unspendable.
 */
export function modalityBudgetFor(
	totalGranted: number,
	modality: BudgetModality,
): number {
	const total = MODALITY_SPLIT.video + MODALITY_SPLIT.image;
	const video = Math.floor((totalGranted * MODALITY_SPLIT.video) / total);
	return modality === "video" ? video : Math.max(0, totalGranted - video);
}

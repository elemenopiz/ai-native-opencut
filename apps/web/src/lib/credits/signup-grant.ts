/**
 * Private-beta welcome grant, applied once per account by the better-auth
 * `user.create.after` hook (see lib/auth/server.ts).
 *
 * PURE MODULE — no ledger/db imports, so client components (onboarding, auth
 * form) can show the number without pulling server code into the bundle.
 *
 * Sizing (2026-07 beta): 650 credits ≈ US$5 of Seedance video (10 five-second
 * clips) + US$1.50 of Nano Banana Pro stills (~10 images). The balance is
 * fungible — the per-model split is enforced by pricing (cost-table.ts), not
 * by separate wallets. Director chat / enhance-prompt are free actions
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

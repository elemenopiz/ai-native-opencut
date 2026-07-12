import { NextResponse } from "next/server";
import { webEnv } from "@byorn/env/web";
import {
	type AccountState,
	grant,
	InsufficientCredits,
	lifetimeGranted,
	release,
	type ReleaseOptions,
	reserve,
	type ReserveOptions,
	settle,
	type SettleOptions,
} from "@/lib/credits/ledger";
import {
	BETA_COURTESY_BACKSTOP_CREDITS,
	SIGNUP_GRANT_CREDITS,
} from "@/lib/credits/signup-grant";

/** Shared ref type for every studio generation charge. */
export const STUDIO_REF_TYPE = "studio_job";

/**
 * Global metering kill-switch (env `CREDITS_ENFORCED`, default true). When off,
 * paid generation runs free: the metered wrappers below become no-ops — no hold,
 * no charge, no `InsufficientCredits`. Read once per call (env is process-stable),
 * so reserve/settle/release within one request always agree.
 */
export function creditsEnforced(): boolean {
	return webEnv.CREDITS_ENFORCED;
}

/**
 * Metered wrappers around the pure ledger. Synchronous paid routes should call
 * THESE (not the raw ledger) so the `CREDITS_ENFORCED` switch gates the whole
 * reserve→settle/release cycle in one place. NOTE: the async video-completion
 * route settles/releases off `holdFor` (a hold only exists if reserve ran while
 * enforced), so it stays correct without a flag check and must NOT be gated here.
 */
export async function meteredReserve(
	userId: string,
	credits: number,
	opts: ReserveOptions,
): Promise<AccountState | null> {
	if (!creditsEnforced()) return null;
	try {
		return await reserve(userId, credits, opts);
	} catch (err) {
		if (!(err instanceof InsufficientCredits)) throw err;

		// ── Beta courtesy extension ─────────────────────────────────────────
		// The 650-credit allowance is a SOFT limit: instead of blocking, extend
		// the balance in further allowance-sized chunks and let the client nag
		// the user to pace themselves (the pool is shared). The extension is
		// idempotent on the lifetime-granted watermark, so a raced retry can't
		// double-grant; the lifetime backstop (~$100) only exists to stop a
		// runaway script, never a human.
		const granted = await lifetimeGranted(userId);
		if (granted >= BETA_COURTESY_BACKSTOP_CREDITS) throw err;

		const shortfall = credits - err.spendable;
		const chunks = Math.max(1, Math.ceil(shortfall / SIGNUP_GRANT_CREDITS));
		await grant(userId, chunks * SIGNUP_GRANT_CREDITS, {
			reason: "beta_courtesy",
			refType: "courtesy",
			// Derived key `grant:courtesy:${userId}:${granted}`: one extension
			// per watermark — concurrent losers re-reserve against the same
			// single grant instead of stacking extensions.
			refId: `${userId}:${granted}`,
			note: "Beta courtesy extension — allowance exceeded, pool is shared",
		});

		// One retry; a second failure (e.g. two big concurrent asks raced for
		// one extension) surfaces as the normal 402 and succeeds on next click.
		return await reserve(userId, credits, opts);
	}
}

export async function meteredSettle(
	userId: string,
	credits: number,
	opts: SettleOptions,
): Promise<AccountState | null> {
	if (!creditsEnforced()) return null;
	return settle(userId, credits, opts);
}

export async function meteredRelease(
	userId: string,
	credits: number,
	opts: ReleaseOptions,
): Promise<AccountState | null> {
	if (!creditsEnforced()) return null;
	return release(userId, credits, opts);
}

/**
 * The HTTP 402 body returned when a paid studio action can't be afforded. The
 * frontend interceptor keys off `error === "insufficient_credits"` to open the
 * "Out of credits" modal.
 */
export function insufficientCreditsResponse(
	err: InsufficientCredits,
): NextResponse {
	return NextResponse.json(
		{
			error: "insufficient_credits",
			needed: err.needed,
			spendable: err.spendable,
		},
		{ status: 402 },
	);
}

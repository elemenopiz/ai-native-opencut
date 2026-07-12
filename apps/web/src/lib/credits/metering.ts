import { NextResponse } from "next/server";
import { webEnv } from "@byorn/env/web";
import {
	type AccountState,
	InsufficientCredits,
	release,
	type ReleaseOptions,
	reserve,
	type ReserveOptions,
	settle,
	type SettleOptions,
} from "@/lib/credits/ledger";

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
	return reserve(userId, credits, opts);
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

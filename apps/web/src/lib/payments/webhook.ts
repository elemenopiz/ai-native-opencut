/**
 * Server-only glue between a VERIFIED payment event and the credit ledger.
 *
 * Kept out of `lib/payments/index.ts`'s re-exports on purpose: this module
 * imports the ledger (DB), so only server code (the webhook route + tests)
 * should pull it in — never the client bundle that imports the catalog.
 *
 * The route calls {@link applyVerifiedEvent} AFTER signature verification. Both
 * the route and the tests share this one path so the idempotency key that makes
 * a retried webhook grant once is exercised exactly as it runs in production.
 */

import { grant } from "@/lib/credits/ledger";
import { getPaymentsProvider } from "@/lib/payments";
import type { CreditGrant } from "@/lib/payments/provider";

/**
 * The ledger idempotency key for a grant. Derived from the payment/renewal id,
 * so redeliveries of the same order (and every distinct renewal) map to their
 * own single grant.
 */
export function idempotencyKeyFor(g: CreditGrant): string {
	return `${g.refType}:${g.refId}`;
}

export interface ApplyResult {
	status: "ok" | "ignored";
	grant?: CreditGrant;
}

/**
 * Turn a verified provider event into at most one idempotent credit grant.
 * Returns `{ status: "ignored" }` for events we don't grant on (still a 200 to
 * the provider). Throws only on a real ledger/DB failure so the caller can
 * surface a 5xx and let the provider retry.
 */
export async function applyVerifiedEvent(event: unknown): Promise<ApplyResult> {
	const creditGrant = getPaymentsProvider().toGrant(event);
	if (!creditGrant) return { status: "ignored" };

	await grant(creditGrant.userId, creditGrant.credits, {
		reason: creditGrant.reason,
		refType: creditGrant.refType,
		refId: creditGrant.refId,
		note: creditGrant.note,
		idempotencyKey: idempotencyKeyFor(creditGrant),
	});

	return { status: "ok", grant: creditGrant };
}

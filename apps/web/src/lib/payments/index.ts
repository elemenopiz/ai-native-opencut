/**
 * Payments registry — the single entry point the routes and UI import.
 *
 * Today there is exactly one provider (Polar). Keeping the lookup behind
 * `getPaymentsProvider()` means swapping in another merchant-of-record later is
 * a one-line change here, not a change across every call site — the same shape
 * as the Studio backend registry.
 */

import { polarProvider } from "@/lib/payments/polar";
import type { PaymentsProvider } from "@/lib/payments/provider";

/** The active payments provider. */
export function getPaymentsProvider(): PaymentsProvider {
	return polarProvider;
}

/** True once the active provider's env is configured (inert until then). */
export function isPaymentsConfigured(): boolean {
	return getPaymentsProvider().isConfigured();
}

export * from "@/lib/payments/provider";
export * from "@/lib/payments/catalog";

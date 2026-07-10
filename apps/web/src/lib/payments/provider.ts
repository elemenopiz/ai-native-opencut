/**
 * Payments provider abstraction (Phase 2 of the credit system).
 *
 * A THIN seam over a merchant-of-record so the concrete provider (Polar today,
 * Stripe conceivably later) can be swapped without touching the checkout route,
 * the webhook route, or the buy-credits UI. Mirrors the Studio backend adapters
 * (`lib/studio/backends/*`): a provider is inert until its env is configured
 * (`isConfigured()`), and callers ask the registry for "the active provider"
 * rather than importing a vendor SDK directly.
 *
 * Two responsibilities only:
 *   1. `createCheckout` — mint a hosted checkout session for a product, carrying
 *      the trusted userId link (never trust a client-supplied userId later).
 *   2. `verifyWebhook` + `toGrant` — verify an inbound webhook's signature and
 *      map a *paid* event to a single idempotent credit grant.
 */

/** Credits the webhook should grant for one verified, paid economic event. */
export interface CreditGrant {
	/** Trusted app user id, resolved from checkout metadata / external customer. */
	userId: string;
	/** Credits to add (always ≥ 0). */
	credits: number;
	/** Ledger reason, e.g. "topup" | "subscription". */
	reason: string;
	/** Ledger refType, e.g. "polar_order" | "polar_subscription". */
	refType: string;
	/**
	 * The PAYMENT event id (order/invoice id) — unique per payment AND per
	 * subscription renewal. Doubles as the ledger idempotency key so a retried
	 * webhook (and each renewal) grants exactly once.
	 */
	refId: string;
	/** Human-readable note for the ledger metadata. */
	note?: string;
}

export interface CreateCheckoutParams {
	/** Concrete provider product id to check out. */
	productId: string;
	/** Authenticated app user id — the trusted link back from the webhook. */
	userId: string;
	/** Customer email, when known, to pre-fill the checkout. */
	userEmail?: string;
	/** Absolute URL the customer is sent to after a successful payment. */
	successUrl: string;
}

export interface CreateCheckoutResult {
	/** Hosted checkout URL to redirect the customer to. */
	url: string;
	/** Provider checkout session id (for logging / correlation). */
	id: string;
}

/** Thrown by {@link PaymentsProvider.verifyWebhook} on a bad/absent signature. */
export class WebhookSignatureError extends Error {
	constructor(message = "Invalid webhook signature") {
		super(message);
		this.name = "WebhookSignatureError";
	}
}

/** Thrown by provider methods invoked while the provider is not configured. */
export class PaymentsNotConfiguredError extends Error {
	constructor(message = "Payments are not configured") {
		super(message);
		this.name = "PaymentsNotConfiguredError";
	}
}

export interface PaymentsProvider {
	/** Stable provider id, e.g. "polar". */
	readonly id: string;

	/**
	 * True once the provider's required env is present. Everything payment-related
	 * stays inert until this returns true (mirrors Studio adapters' isAvailable).
	 */
	isConfigured(): boolean;

	/**
	 * Create a hosted checkout session. MUST attach `userId` to the provider's
	 * checkout/customer metadata so the webhook can resolve it from a TRUSTED
	 * source (never from client input). Rejects if the provider is not configured.
	 */
	createCheckout(params: CreateCheckoutParams): Promise<CreateCheckoutResult>;

	/**
	 * Verify the raw request body against `secret` using the provider's signing
	 * scheme and return the parsed event. Throws {@link WebhookSignatureError} on
	 * a signature mismatch. `rawBody` MUST be the exact bytes received (verify
	 * before JSON-parsing).
	 */
	verifyWebhook(rawBody: string, headers: Record<string, string>): unknown;

	/**
	 * Map a verified event to a single {@link CreditGrant}, or `null` for events
	 * we intentionally ignore (no-op → still acknowledged with 200). Pure: does
	 * NOT touch the DB — the caller performs the idempotent `grant()`.
	 */
	toGrant(event: unknown): CreditGrant | null;
}

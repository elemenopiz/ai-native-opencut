/**
 * Polar payments provider — merchant-of-record implementation of the
 * {@link PaymentsProvider} seam.
 *
 * Confirmed against @polar-sh/sdk@0.48.1 (context7 + installed types):
 *   • `new Polar({ accessToken, server })` — server is "sandbox" | "production".
 *   • `polar.checkouts.create({ products, successUrl, externalCustomerId,
 *      metadata })` → Checkout with `.url` and `.id`. Checkout metadata is
 *      copied onto the resulting order & subscription — that's our trusted link.
 *   • `validateEvent(rawBody, headers, secret)` from "@polar-sh/sdk/webhooks"
 *      verifies the Standard-Webhooks signature and returns the parsed event;
 *      throws `WebhookVerificationError` on a bad signature.
 *
 * Grant policy — we grant on `order.paid` ONLY. In Polar every paid economic
 * event is an Order: a one-time top-up is an order, and each subscription
 * billing period (initial + every renewal) also produces its own order with a
 * fresh `order.id`. Keying the ledger idempotency on `order.id` therefore grants
 * exactly once per payment AND once per renewal. `subscription.*` events are
 * intentionally ignored (no-op) so we never double-grant or grant without a
 * received payment.
 */

import { Polar } from "@polar-sh/sdk";
import {
	validateEvent,
	WebhookVerificationError,
} from "@polar-sh/sdk/webhooks";
import { webEnv } from "@byorn/env/web";
import { creditsForProduct } from "@/lib/payments/catalog";
import {
	type CreateCheckoutParams,
	type CreateCheckoutResult,
	type CreditGrant,
	PaymentsNotConfiguredError,
	type PaymentsProvider,
	WebhookSignatureError,
} from "@/lib/payments/provider";

/** True once the Polar token + webhook secret are both present. */
export function isPolarConfigured(): boolean {
	return Boolean(webEnv.POLAR_ACCESS_TOKEN && webEnv.POLAR_WEBHOOK_SECRET);
}

function polarClient(): Polar {
	return new Polar({
		accessToken: webEnv.POLAR_ACCESS_TOKEN,
		server: webEnv.POLAR_SERVER, // "sandbox" | "production"
	});
}

/**
 * Minimal structural view of the fields we read off a verified `order.paid`
 * event. The SDK returns richly-typed payloads; we only touch these, so a
 * narrow local shape keeps `toGrant` decoupled from the full model surface.
 */
interface OrderPaidLike {
	type: string;
	data: {
		id: string;
		productId?: string | null;
		subscriptionId?: string | null;
		metadata?: Record<string, unknown> | null;
		customer?: { externalId?: string | null } | null;
		subscription?: { productId?: string | null } | null;
	};
}

/**
 * Resolve the trusted app userId from a paid order. Preference order:
 *   1. checkout metadata `userId` (set by us at checkout — the trusted link),
 *   2. the Polar customer's `externalId` (also set by us at checkout, survives
 *      across renewals even if a renewal order omits the original metadata).
 * NEVER derived from anything the buyer can influence.
 */
function resolveUserId(order: OrderPaidLike["data"]): string | null {
	const fromMeta = order.metadata?.userId;
	if (typeof fromMeta === "string" && fromMeta.length > 0) return fromMeta;
	const ext = order.customer?.externalId;
	if (typeof ext === "string" && ext.length > 0) return ext;
	return null;
}

export const polarProvider: PaymentsProvider = {
	id: "polar",

	isConfigured() {
		return isPolarConfigured();
	},

	async createCheckout(
		params: CreateCheckoutParams,
	): Promise<CreateCheckoutResult> {
		if (!isPolarConfigured()) {
			throw new PaymentsNotConfiguredError();
		}

		const checkout = await polarClient().checkouts.create({
			products: [params.productId],
			successUrl: params.successUrl,
			// Trusted link back to our user, set on BOTH surfaces:
			//  • externalCustomerId → the Polar customer's external_id (durable
			//    across subscription renewals),
			//  • metadata.userId → copied onto the order & subscription.
			externalCustomerId: params.userId,
			customerEmail: params.userEmail,
			metadata: { userId: params.userId },
		});

		return { url: checkout.url ?? "", id: checkout.id };
	},

	verifyWebhook(rawBody: string, headers: Record<string, string>): unknown {
		try {
			return validateEvent(rawBody, headers, webEnv.POLAR_WEBHOOK_SECRET);
		} catch (error) {
			if (error instanceof WebhookVerificationError) {
				throw new WebhookSignatureError(error.message);
			}
			throw error;
		}
	},

	toGrant(event: unknown): CreditGrant | null {
		const e = event as OrderPaidLike;
		// We grant only on paid orders — see the module header for why.
		if (!e || e.type !== "order.paid" || !e.data) return null;

		const order = e.data;
		const userId = resolveUserId(order);
		if (!userId) return null; // no trusted link → cannot safely grant

		const productId = order.productId ?? order.subscription?.productId ?? null;
		const mapped = creditsForProduct(productId);
		if (!mapped || mapped.credits <= 0) return null; // unknown/free product

		const isSub =
			mapped.kind === "subscription" || Boolean(order.subscriptionId);
		return {
			userId,
			credits: mapped.credits,
			reason: isSub ? "subscription" : "topup",
			refType: isSub ? "polar_subscription" : "polar_order",
			// order.id is unique per payment and per renewal → grants once each.
			refId: order.id,
			note: mapped.label,
		};
	},
};

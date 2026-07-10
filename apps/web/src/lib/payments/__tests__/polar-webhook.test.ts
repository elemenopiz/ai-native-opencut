import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import { createHmac } from "node:crypto";
import { inArray, like } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { creditAccounts, creditLedger } from "@/lib/db/schema-credits";
import { getAccount } from "@/lib/credits/ledger";
import { TOP_UP_PACKS, SUBSCRIPTION_TIERS } from "@/lib/payments/catalog";
import { polarProvider } from "@/lib/payments/polar";
import {
	PaymentsNotConfiguredError,
	WebhookSignatureError,
} from "@/lib/payments/provider";
import { isPaymentsConfigured } from "@/lib/payments";
import { applyVerifiedEvent } from "@/lib/payments/webhook";
import { POST as webhookPOST } from "@/app/api/webhooks/polar/route";

/**
 * Phase-2 PAYMENTS correctness. Money-adjacent, so — like the ledger tests —
 * this runs against the REAL local Postgres (bun loads apps/web/.env.local via
 * the bunfig test preload). We mock nothing about the ledger: idempotency is
 * exercised by the real credit_ledger UNIQUE key.
 *
 * In the test env POLAR_ACCESS_TOKEN / POLAR_WEBHOOK_SECRET are unset (schema
 * defaults ""), so the provider is genuinely UNCONFIGURED — exactly what the
 * "clean error when unconfigured" cases need. For the route-level signature
 * test we spy `isConfigured` → true to get past the inert gate, while the real
 * signature verification (empty secret) still rejects a bad signature.
 *
 * Each test uses a FRESH throwaway user; all cleaned up in afterAll.
 */

const PACK = TOP_UP_PACKS[0]; // 500 credits, one-time
const TIER = SUBSCRIPTION_TIERS[1]; // Pro, 5000 credits/period

// The secret the preload sets for tests (see scripts/test-env-preload.ts).
const TEST_WEBHOOK_SECRET = "whsec_test_secret_do_not_use_in_prod";

/**
 * Produce Standard-Webhooks headers Polar's `validateEvent` will accept. Polar
 * base64-encodes the secret before handing it to standardwebhooks, which then
 * base64-decodes it — so the HMAC key is the raw UTF-8 bytes of the secret.
 */
function signedHeaders(secret: string, body: string): Record<string, string> {
	const id = `msg_${crypto.randomUUID()}`;
	const timestamp = Math.floor(Date.now() / 1000).toString();
	const signature = createHmac("sha256", Buffer.from(secret, "utf-8"))
		.update(`${id}.${timestamp}.${body}`)
		.digest("base64");
	return {
		"content-type": "application/json",
		"webhook-id": id,
		"webhook-timestamp": timestamp,
		"webhook-signature": `v1,${signature}`,
	};
}

const createdUserIds: string[] = [];

async function makeUser(): Promise<string> {
	const id = `paytest-${crypto.randomUUID()}`;
	await db.insert(users).values({
		id,
		name: "Pay Test",
		email: `${id}@example.test`,
		emailVerified: false,
		createdAt: new Date(),
		updatedAt: new Date(),
	});
	createdUserIds.push(id);
	return id;
}

async function cleanup(ids: string[]) {
	if (ids.length === 0) return;
	await db.delete(creditLedger).where(inArray(creditLedger.userId, ids));
	await db.delete(creditAccounts).where(inArray(creditAccounts.userId, ids));
	await db.delete(users).where(inArray(users.id, ids));
}

/** A minimal `order.paid` event shaped like the fields `toGrant` reads. */
function orderPaidEvent(opts: {
	orderId: string;
	productId: string;
	userId?: string;
	externalId?: string;
	subscriptionId?: string;
}) {
	return {
		type: "order.paid" as const,
		data: {
			id: opts.orderId,
			productId: opts.productId,
			subscriptionId: opts.subscriptionId ?? null,
			metadata: opts.userId ? { userId: opts.userId } : {},
			customer: { externalId: opts.externalId ?? null },
			subscription: opts.subscriptionId ? { productId: opts.productId } : null,
		},
	};
}

afterEach(async () => {
	const ids = [...createdUserIds];
	createdUserIds.length = 0;
	await cleanup(ids);
});

afterAll(async () => {
	await db.delete(creditLedger).where(like(creditLedger.userId, "paytest-%"));
	await db
		.delete(creditAccounts)
		.where(like(creditAccounts.userId, "paytest-%"));
	await db.delete(users).where(like(users.id, "paytest-%"));
});

describe("polar provider — toGrant mapping", () => {
	it("maps a top-up order to a one-time credit grant", () => {
		const g = polarProvider.toGrant(
			orderPaidEvent({
				orderId: "ord_topup",
				productId: PACK.productId,
				userId: "user-123",
			}),
		);
		expect(g).not.toBeNull();
		expect(g?.credits).toBe(PACK.credits); // 500
		expect(g?.userId).toBe("user-123");
		expect(g?.reason).toBe("topup");
		expect(g?.refType).toBe("polar_order");
		expect(g?.refId).toBe("ord_topup");
	});

	it("maps a subscription order to a per-period grant", () => {
		const g = polarProvider.toGrant(
			orderPaidEvent({
				orderId: "ord_sub_cycle_1",
				productId: TIER.productId,
				userId: "user-abc",
				subscriptionId: "sub_1",
			}),
		);
		expect(g?.credits).toBe(TIER.creditsPerPeriod); // 5000
		expect(g?.reason).toBe("subscription");
		expect(g?.refType).toBe("polar_subscription");
		expect(g?.refId).toBe("ord_sub_cycle_1"); // per-payment id, not sub id
	});

	it("resolves userId from customer.externalId when metadata is absent", () => {
		const g = polarProvider.toGrant(
			orderPaidEvent({
				orderId: "ord_ext",
				productId: PACK.productId,
				externalId: "user-ext-9",
			}),
		);
		expect(g?.userId).toBe("user-ext-9");
	});

	it("ignores an order for a product not in the catalog", () => {
		expect(
			polarProvider.toGrant(
				orderPaidEvent({
					orderId: "ord_x",
					productId: "some-unknown-product",
					userId: "user-123",
				}),
			),
		).toBeNull();
	});

	it("ignores a paid order with no trusted userId link", () => {
		expect(
			polarProvider.toGrant(
				orderPaidEvent({ orderId: "ord_y", productId: PACK.productId }),
			),
		).toBeNull();
	});

	it("ignores non-order.paid events (e.g. subscription.active)", () => {
		expect(
			polarProvider.toGrant({
				type: "subscription.active",
				data: { id: "sub_1", productId: TIER.productId, metadata: {} },
			}),
		).toBeNull();
	});
});

describe("webhook grant — idempotency (real ledger)", () => {
	it("grants once for a retried order (same order id → one grant)", async () => {
		const userId = await makeUser();
		const event = orderPaidEvent({
			orderId: "ord_retry_1",
			productId: PACK.productId,
			userId,
		});

		// Polar redelivers webhooks until it gets a 2xx — apply the same event twice.
		const r1 = await applyVerifiedEvent(event);
		const r2 = await applyVerifiedEvent(event);

		expect(r1.status).toBe("ok");
		expect(r2.status).toBe("ok"); // acknowledged again, but…

		const acct = await getAccount(userId);
		expect(acct.balance).toBe(PACK.credits); // …credited exactly once (500)
	});

	it("grants again for a distinct renewal order (new order id)", async () => {
		const userId = await makeUser();
		await applyVerifiedEvent(
			orderPaidEvent({
				orderId: "ord_cycle_1",
				productId: TIER.productId,
				userId,
				subscriptionId: "sub_42",
			}),
		);
		await applyVerifiedEvent(
			orderPaidEvent({
				orderId: "ord_cycle_2", // next billing period → different payment id
				productId: TIER.productId,
				userId,
				subscriptionId: "sub_42",
			}),
		);

		const acct = await getAccount(userId);
		expect(acct.balance).toBe(TIER.creditsPerPeriod * 2); // 10000
	});
});

describe("polar provider — signature verification (real HMAC)", () => {
	it("accepts a correctly-signed request (no signature error)", () => {
		const body = JSON.stringify(
			orderPaidEvent({
				orderId: "ord_ok",
				productId: PACK.productId,
				userId: "user-1",
			}),
		);
		// Correct signature passes verification. Parsing the (deliberately
		// minimal) body then fails a different way — the point is it is NOT a
		// signature rejection.
		expect(() =>
			polarProvider.verifyWebhook(
				body,
				signedHeaders(TEST_WEBHOOK_SECRET, body),
			),
		).not.toThrow(WebhookSignatureError);
	});

	it("rejects a signature made with the wrong secret", () => {
		const body = JSON.stringify(
			orderPaidEvent({
				orderId: "ord_bad",
				productId: PACK.productId,
				userId: "user-1",
			}),
		);
		expect(() =>
			polarProvider.verifyWebhook(
				body,
				signedHeaders("the_wrong_secret", body),
			),
		).toThrow(WebhookSignatureError);
	});
});

describe("webhook route — signature verification", () => {
	it("rejects a bad signature with 401 and grants nothing", async () => {
		const userId = await makeUser();

		// Get past the inert gate so we actually reach signature verification.
		const spy = spyOn(polarProvider, "isConfigured").mockReturnValue(true);
		try {
			const body = JSON.stringify(
				orderPaidEvent({
					orderId: "ord_forged",
					productId: PACK.productId,
					userId,
				}),
			);
			// Signed with a DIFFERENT secret → real verification fails.
			const req = new Request("http://localhost/api/webhooks/polar", {
				method: "POST",
				headers: signedHeaders("a_forged_secret", body),
				body,
			});

			const res = await webhookPOST(req);
			expect(res.status).toBe(401);
		} finally {
			spy.mockRestore();
		}

		// Critical: a forged webhook must not have credited anyone.
		const acct = await getAccount(userId);
		expect(acct.balance).toBe(0);
	});
});

describe("payments — unconfigured (inert)", () => {
	it("reports not configured when POLAR env is unset", () => {
		expect(isPaymentsConfigured()).toBe(false);
		expect(polarProvider.isConfigured()).toBe(false);
	});

	it("checkout creation fails with a clear error when unconfigured", async () => {
		await expect(
			polarProvider.createCheckout({
				productId: PACK.productId,
				userId: "user-123",
				successUrl: "http://localhost/account",
			}),
		).rejects.toBeInstanceOf(PaymentsNotConfiguredError);
	});

	it("webhook route is inert (503) while unconfigured", async () => {
		const req = new Request("http://localhost/api/webhooks/polar", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		const res = await webhookPOST(req);
		expect(res.status).toBe(503);
	});
});

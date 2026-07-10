/**
 * POST /api/webhooks/polar — grant credits when Polar reports a paid order.
 *
 * The money path. NOT session-gated — it is authenticated by the webhook
 * SIGNATURE instead:
 *   1. Read the RAW body (`req.text()`) BEFORE parsing — signature verification
 *      is over the exact bytes Polar sent.
 *   2. Verify the signature with POLAR_WEBHOOK_SECRET; a bad/absent signature is
 *      401 and grants nothing.
 *   3. Map the verified event to a single credit grant (only `order.paid` grants
 *      — see the provider). Resolve the userId from the TRUSTED checkout metadata
 *      / external customer id, never from anything the buyer controls.
 *   4. `grant()` is idempotent on `order.id`, so a retried webhook (Polar retries
 *      until it gets a 2xx) and every subscription renewal each grant ONCE.
 *
 * Always 200 on handled/ignored events so Polar stops retrying; 401 only on a
 * signature failure; 503 while payments are unconfigured.
 */

import { NextResponse } from "next/server";
import { getPaymentsProvider } from "@/lib/payments";
import { WebhookSignatureError } from "@/lib/payments/provider";
import { applyVerifiedEvent } from "@/lib/payments/webhook";

export async function POST(request: Request) {
	const provider = getPaymentsProvider();

	if (!provider.isConfigured()) {
		// Payments inert — acknowledge without acting so Polar isn't left retrying
		// against a half-configured deploy.
		return NextResponse.json(
			{ error: "payments_not_configured" },
			{ status: 503 },
		);
	}

	// RAW body first — verification is byte-exact.
	const rawBody = await request.text();
	const headers: Record<string, string> = {};
	request.headers.forEach((value, key) => {
		headers[key] = value;
	});

	let event: unknown;
	try {
		event = provider.verifyWebhook(rawBody, headers);
	} catch (error) {
		if (error instanceof WebhookSignatureError) {
			// Reject unverified payloads — never grant on an unsigned request.
			return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
		}
		console.error("Error verifying Polar webhook:", error);
		return NextResponse.json({ error: "bad_request" }, { status: 400 });
	}

	try {
		// Maps the event to at most one grant and applies it idempotently
		// (idempotency key = payment/renewal id). "ignored" for events we don't
		// grant on — still a 200 so Polar stops retrying.
		const result = await applyVerifiedEvent(event);
		return NextResponse.json({ status: result.status });
	} catch (error) {
		// A DB failure here should NOT be acknowledged — return 500 so Polar
		// retries and the grant isn't silently lost.
		console.error("Error granting credits from Polar webhook:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}

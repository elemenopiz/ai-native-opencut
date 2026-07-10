/**
 * POST /api/credits/checkout — start a Polar checkout for credits.
 *
 * Session-gated (better-auth), matching the other authed routes in this repo.
 * Body: { productId? | packKey? | tierKey? } — resolved against the catalog so a
 * client can only ever buy a product we actually sell. The authenticated userId
 * is attached to the checkout/customer metadata as the TRUSTED link the webhook
 * later reads (a client-supplied userId is NEVER trusted).
 *
 * Returns { url } to redirect to. Returns a clean 503 when payments aren't
 * configured (env unset), mirroring the Studio adapters' inert-until-configured
 * behavior.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { headers } from "next/headers";
import { webEnv } from "@byorn/env/web";
import { auth } from "@/lib/auth/server";
import { getPaymentsProvider, resolveProductId } from "@/lib/payments";

const checkoutSchema = z
	.object({
		productId: z.string().min(1).optional(),
		packKey: z.string().min(1).optional(),
		tierKey: z.string().min(1).optional(),
	})
	.refine((b) => b.productId || b.packKey || b.tierKey, {
		message: "One of productId, packKey, or tierKey is required",
	});

export async function POST(request: Request) {
	try {
		const session = await auth.api.getSession({ headers: await headers() });
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const provider = getPaymentsProvider();
		if (!provider.isConfigured()) {
			// Inert until POLAR_* env is set — a clear, actionable error.
			return NextResponse.json(
				{ error: "payments_not_configured" },
				{ status: 503 },
			);
		}

		const body = await request.json().catch(() => null);
		const parsed = checkoutSchema.safeParse(body);
		if (!parsed.success) {
			return NextResponse.json(
				{
					error: "Invalid request",
					details: parsed.error.flatten().fieldErrors,
				},
				{ status: 400 },
			);
		}

		const productId = resolveProductId(parsed.data);
		if (!productId) {
			return NextResponse.json({ error: "unknown_product" }, { status: 400 });
		}

		const siteUrl = webEnv.NEXT_PUBLIC_SITE_URL.replace(/\/$/, "");
		const { url } = await provider.createCheckout({
			productId,
			userId: session.user.id,
			userEmail: session.user.email ?? undefined,
			successUrl: `${siteUrl}/account?checkout=success&checkout_id={CHECKOUT_ID}`,
		});

		return NextResponse.json({ url });
	} catch (error) {
		console.error("Error creating credits checkout:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}

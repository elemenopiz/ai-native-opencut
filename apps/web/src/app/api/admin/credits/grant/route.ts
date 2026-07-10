/**
 * POST /api/admin/credits/grant — soft-launch admin path to grant credits.
 *
 * Session-gated AND the caller's session email must be in ADMIN_EMAILS (403
 * otherwise). No payments this phase — this is how balances are seeded for the
 * soft launch. Body: { userId, amount, note? }. Idempotent per (admin, userId,
 * amount, note) so a double-submit doesn't double-grant.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { auth } from "@/lib/auth/server";
import { grant } from "@/lib/credits/ledger";
import { isAdminEmail } from "@/lib/credits/admin";

const grantSchema = z.object({
	userId: z.string().min(1),
	amount: z.number().int().positive(),
	note: z.string().max(500).optional(),
});

export async function POST(request: Request) {
	try {
		const session = await auth.api.getSession({ headers: await headers() });
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}
		if (!isAdminEmail(session.user.email)) {
			return NextResponse.json({ error: "Forbidden" }, { status: 403 });
		}

		const body = await request.json();
		const parsed = grantSchema.safeParse(body);
		if (!parsed.success) {
			return NextResponse.json(
				{
					error: "Invalid request",
					details: parsed.error.flatten().fieldErrors,
				},
				{ status: 400 },
			);
		}

		const { userId, amount, note } = parsed.data;

		// Dedupe key: same admin granting the same amount+note to the same user is
		// treated as one grant (protects against a double-submit). A deliberate
		// repeat grant should vary the note.
		const idempotencyKey = `admin_grant:${createHash("sha256")
			.update(`${session.user.id}:${userId}:${amount}:${note ?? ""}`)
			.digest("hex")}`;

		const account = await grant(userId, amount, {
			reason: "admin_grant",
			refType: "admin",
			refId: session.user.id,
			note,
			idempotencyKey,
		});

		return NextResponse.json({
			userId,
			granted: amount,
			balance: account.balance,
			spendable: account.spendable,
		});
	} catch (error) {
		console.error("Error granting credits:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}

/**
 * GET /api/credits/balance — the caller's credit balance.
 *
 * Session-gated (matches the other authed routes in this repo). Returns
 * `{ spendable, balance, reserved, lifetimeGranted }` where spendable =
 * balance - reserved. The balance pill in the editor header reads this;
 * `lifetimeGranted` lets the client compute lifetime spend
 * (granted − balance) and show the beta pacing nudge once the 650-credit
 * allowance is used.
 */

import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth/server";
import { getAccount, lifetimeGranted } from "@/lib/credits/ledger";

export async function GET() {
	try {
		const session = await auth.api.getSession({ headers: await headers() });
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const [{ spendable, balance, reserved }, granted] = await Promise.all([
			getAccount(session.user.id),
			lifetimeGranted(session.user.id),
		]);
		return NextResponse.json({
			spendable,
			balance,
			reserved,
			lifetimeGranted: granted,
		});
	} catch (error) {
		console.error("Error reading credit balance:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}

/**
 * GET /api/credits/balance — the caller's credit balance.
 *
 * Session-gated (matches the other authed routes in this repo). Returns
 * `{ spendable, balance, reserved }` where spendable = balance - reserved. The
 * balance pill in the editor header reads this.
 */

import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth/server";
import { getAccount } from "@/lib/credits/ledger";

export async function GET() {
	try {
		const session = await auth.api.getSession({ headers: await headers() });
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const { spendable, balance, reserved } = await getAccount(session.user.id);
		return NextResponse.json({ spendable, balance, reserved });
	} catch (error) {
		console.error("Error reading credit balance:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}

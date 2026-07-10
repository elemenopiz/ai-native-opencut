/**
 * GET /api/credits/history — the caller's recent credit ledger, newest first.
 *
 * Session-gated. Paginated via `?limit=` (1–100, default 20) and `?offset=`.
 * Returns actual credit movements (grants + charges); delta=0 reserve/release
 * markers are excluded by the ledger service. The account page renders this.
 */

import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { headers } from "next/headers";
import { auth } from "@/lib/auth/server";
import { getAccount, history } from "@/lib/credits/ledger";

const querySchema = z.object({
	limit: z.coerce.number().int().min(1).max(100).default(20),
	offset: z.coerce.number().int().min(0).default(0),
});

export async function GET(request: NextRequest) {
	try {
		const session = await auth.api.getSession({ headers: await headers() });
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const parsed = querySchema.safeParse({
			limit: request.nextUrl.searchParams.get("limit") ?? undefined,
			offset: request.nextUrl.searchParams.get("offset") ?? undefined,
		});
		if (!parsed.success) {
			return NextResponse.json(
				{ error: "Invalid query", details: parsed.error.flatten().fieldErrors },
				{ status: 400 },
			);
		}

		const { limit, offset } = parsed.data;
		const [entries, account] = await Promise.all([
			history(session.user.id, { limit, offset }),
			getAccount(session.user.id),
		]);

		return NextResponse.json({
			balance: account.balance,
			reserved: account.reserved,
			spendable: account.spendable,
			entries,
		});
	} catch (error) {
		console.error("Error reading credit history:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}

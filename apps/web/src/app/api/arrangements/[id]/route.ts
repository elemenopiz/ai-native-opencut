import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { arrangements } from "@/lib/db/schema-arrangements";
import { enforceRateLimit } from "@/lib/rate-limit";
import type { Arrangement } from "@/types/arrangement";

/**
 * GET /api/arrangements/[id] — resolve a published arrangement for the no-login
 * `/t/[id]` remix landing. Also bumps the "remixed N times" counter so a
 * template accrues a usage badge as it spreads.
 *
 * The READ stays unlimited (it's a public share link), but the counter bump is
 * an anonymous Postgres write, so it's gated per IP: past the limit we still
 * serve the arrangement and just skip the increment.
 */
export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	try {
		const { id } = await params;

		const rows = await db
			.select({ data: arrangements.data, remixCount: arrangements.remixCount })
			.from(arrangements)
			.where(eq(arrangements.id, id))
			.limit(1);

		if (!rows.length) {
			return NextResponse.json(
				{ error: "Arrangement not found" },
				{ status: 404 },
			);
		}

		const arrangement = JSON.parse(rows[0].data) as Arrangement;

		// Rate-limit only the anonymous counter WRITE, never the read: past the
		// limit we serve the arrangement as usual and skip the increment.
		const limited = await enforceRateLimit({
			name: "arrangements:remix",
			request: req,
		});

		if (!limited) {
			// Fire-and-forget usage counter; never block or fail the fetch on it.
			void db
				.update(arrangements)
				.set({ remixCount: sql`${arrangements.remixCount} + 1` })
				.where(eq(arrangements.id, id))
				.catch(() => {});
		}

		return NextResponse.json({
			// Reflect this remix in the returned count (the row was read before the
			// increment above was applied).
			remixCount: rows[0].remixCount + (limited ? 0 : 1),
			arrangement,
		});
	} catch (err) {
		const message =
			err instanceof Error ? err.message : "Failed to fetch arrangement";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}

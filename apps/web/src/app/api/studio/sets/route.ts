import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { auth } from "@/lib/auth/server";
import { db } from "@/lib/db";
import { generationSets, takes } from "@/lib/db/schema-studio";

export async function GET() {
	try {
		// Sets expose generation history and rehosted video URLs. Require a session
		// and scope to it — never honor a client-supplied ?userId=, and never fall
		// through to an unscoped query that would leak every user's sets.
		const session = await auth.api.getSession({ headers: await headers() });
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const sets = await db.query.generationSets.findMany({
			where: eq(generationSets.userId, session.user.id),
			orderBy: [desc(generationSets.createdAt)],
			limit: 50,
		});

		// Attach takes for each set
		const setsWithTakes = await Promise.all(
			sets.map(async (set) => {
				const setTakes = await db
					.select()
					.from(takes)
					.where(eq(takes.setId, set.id))
					.orderBy(desc(takes.createdAt));
				return { ...set, takes: setTakes };
			}),
		);

		return NextResponse.json({ sets: setsWithTakes });
	} catch (err) {
		const message = err instanceof Error ? err.message : "Failed to fetch sets";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}

import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { generationSets, takes } from "@/lib/db/schema-studio";

export async function GET(req: Request) {
	try {
		const { searchParams } = new URL(req.url);
		const userId = searchParams.get("userId");

		const sets = userId
			? await db.query.generationSets.findMany({
				where: eq(generationSets.userId, userId),
				orderBy: [desc(generationSets.createdAt)],
				limit: 50,
			})
			: await db.query.generationSets.findMany({
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

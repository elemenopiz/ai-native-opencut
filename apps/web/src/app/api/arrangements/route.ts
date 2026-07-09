import { NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { arrangements } from "@/lib/db/schema-arrangements";
import { validateArrangement } from "@/lib/arrangements/validate";

/**
 * POST /api/arrangements — publish a media-free arrangement, mint a public id.
 * No login required (matches our no-login-to-try posture). The payload is
 * validated + normalized server-side before insert, so a share link can never
 * smuggle media or oversized data through.
 */
export async function POST(req: Request) {
	try {
		const body = await req.json();
		const arrangement = validateArrangement(body?.arrangement ?? body);

		const id = nanoid(10);
		const stored = { ...arrangement, id, createdAt: new Date().toISOString() };

		await db.insert(arrangements).values({
			id,
			name: stored.name,
			description: stored.description ?? null,
			slotCount: stored.slots.length,
			totalDuration: Math.round(stored.totalDuration),
			remixCount: 0,
			data: JSON.stringify(stored),
		});

		return NextResponse.json({ id });
	} catch (err) {
		const message =
			err instanceof Error ? err.message : "Failed to publish arrangement";
		return NextResponse.json({ error: message }, { status: 400 });
	}
}

/** GET /api/arrangements — list recent public arrangements (for a trending rail). */
export async function GET() {
	try {
		const rows = await db
			.select({
				id: arrangements.id,
				name: arrangements.name,
				description: arrangements.description,
				slotCount: arrangements.slotCount,
				totalDuration: arrangements.totalDuration,
				remixCount: arrangements.remixCount,
				createdAt: arrangements.createdAt,
			})
			.from(arrangements)
			.orderBy(desc(arrangements.createdAt))
			.limit(50);

		return NextResponse.json({ arrangements: rows });
	} catch (err) {
		const message =
			err instanceof Error ? err.message : "Failed to list arrangements";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}

import { NextResponse } from "next/server";
import { desc, eq, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { personas } from "@/lib/db/schema-studio";

// Safely rehydrate a stored JSON array; a malformed row degrades to [] rather
// than throwing and 500-ing the entire list request.
function parseRefImageUrls(raw: string | null): string[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? (parsed as string[]) : [];
	} catch {
		return [];
	}
}

// Shape returned to the client — refImageUrls rehydrated from JSON to an array.
function serialize(p: typeof personas.$inferSelect) {
	return {
		id: p.id,
		name: p.name,
		descriptor: p.descriptor,
		anchorImageUrl: p.anchorImageUrl,
		refImageUrls: parseRefImageUrls(p.refImageUrls),
		seed: p.seed,
		createdAt: p.createdAt,
	};
}

// POST — create a persona. anchorImageUrl is either a generated still (character
// sheet → crop) or, in the photo-upload fast-follow, an uploaded image URL.
export async function POST(req: Request) {
	try {
		const body = (await req.json()) as {
			name?: string;
			descriptor?: string;
			anchorImageUrl?: string;
			refImageUrls?: string[];
			seed?: number;
			userId?: string;
		};

		const { name, descriptor, anchorImageUrl, refImageUrls, seed, userId } =
			body;
		if (!name?.trim() || !descriptor?.trim() || !anchorImageUrl?.trim()) {
			return NextResponse.json(
				{ error: "name, descriptor and anchorImageUrl are required" },
				{ status: 400 },
			);
		}

		const [row] = await db
			.insert(personas)
			.values({
				id: nanoid(),
				userId: userId ?? null,
				name: name.trim(),
				descriptor: descriptor.trim(),
				anchorImageUrl,
				refImageUrls: refImageUrls?.length
					? JSON.stringify(refImageUrls)
					: null,
				seed: seed ?? null,
			})
			.returning();

		return NextResponse.json({ persona: serialize(row) });
	} catch (err) {
		const message =
			err instanceof Error ? err.message : "Failed to create persona";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}

// GET — list personas (optionally scoped to a user).
export async function GET(req: Request) {
	try {
		const { searchParams } = new URL(req.url);
		const userId = searchParams.get("userId");

		// Scope to the requested user, or — when no userId is supplied — to the
		// anonymous bucket (userId IS NULL). Never fall through to an unscoped
		// query: that would return every user's personas to a no-userId caller.
		const rows = await db.query.personas.findMany({
			where: userId ? eq(personas.userId, userId) : isNull(personas.userId),
			orderBy: [desc(personas.createdAt)],
			limit: 100,
		});

		return NextResponse.json({ personas: rows.map(serialize) });
	} catch (err) {
		const message =
			err instanceof Error ? err.message : "Failed to fetch personas";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}

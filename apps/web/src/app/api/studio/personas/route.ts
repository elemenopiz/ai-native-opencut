import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { headers } from "next/headers";
import { auth } from "@/lib/auth/server";
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
		// Creating a persona — require a signed-in user. Ownership is stamped from
		// the session, never from the body (a body userId would let a caller forge
		// a persona under another user's account).
		const session = await auth.api.getSession({ headers: await headers() });
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const body = (await req.json()) as {
			name?: string;
			descriptor?: string;
			anchorImageUrl?: string;
			refImageUrls?: string[];
			seed?: number;
		};

		const { name, descriptor, anchorImageUrl, refImageUrls, seed } = body;
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
				userId: session.user.id,
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

// GET — list the signed-in user's personas.
export async function GET() {
	try {
		// Personas expose anchor/reference photo URLs (PII). Require a session and
		// scope to it — never honor a client-supplied ?userId=, which would let any
		// caller read another user's persona photos.
		const session = await auth.api.getSession({ headers: await headers() });
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const rows = await db.query.personas.findMany({
			where: eq(personas.userId, session.user.id),
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

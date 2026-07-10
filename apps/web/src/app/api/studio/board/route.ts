import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { auth } from "@/lib/auth/server";
import {
	boardItems,
	takes,
	generationSets,
	imageStills,
} from "@/lib/db/schema-studio";

// GET — fetch all board items, enriched with their take+set or image still
export async function GET() {
	try {
		// The board is shared server-side (no owner column yet — see route note),
		// so gating on a session only closes the anonymous-read hole. TRUE per-user
		// isolation needs an ownerId column + query scoping (follow-up).
		const session = await auth.api.getSession({ headers: await headers() });
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const items = await db
			.select()
			.from(boardItems)
			.orderBy(boardItems.position);

		const enriched = await Promise.all(
			items.map(async (item) => {
				if (item.kind === "image" && item.imageStillId) {
					const image = await db.query.imageStills.findFirst({
						where: eq(imageStills.id, item.imageStillId),
					});
					return { ...item, image, take: null, set: null };
				}

				const take = item.takeId
					? await db.query.takes.findFirst({ where: eq(takes.id, item.takeId) })
					: null;
				const set = take
					? await db.query.generationSets.findFirst({
							where: eq(generationSets.id, take.setId),
						})
					: null;
				return { ...item, take, set, image: null };
			}),
		);

		return NextResponse.json({ items: enriched });
	} catch (err) {
		const message =
			err instanceof Error ? err.message : "Failed to fetch board";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}

// POST — pin a take or an image still to the board
export async function POST(req: Request) {
	try {
		const session = await auth.api.getSession({ headers: await headers() });
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const body = (await req.json()) as {
			takeId?: string;
			imageStillId?: string;
			notes?: string;
		};
		const { takeId, imageStillId, notes } = body;

		if (!takeId && !imageStillId) {
			return NextResponse.json(
				{ error: "takeId or imageStillId is required" },
				{ status: 400 },
			);
		}

		// Auto-assign next position
		const existing = await db
			.select()
			.from(boardItems)
			.orderBy(desc(boardItems.position))
			.limit(1);
		const position = (existing[0]?.position ?? -1) + 1;

		const id = nanoid();
		const [item] = await db
			.insert(boardItems)
			.values({
				id,
				kind: imageStillId ? "image" : "take",
				takeId: takeId ?? null,
				imageStillId: imageStillId ?? null,
				notes: notes ?? null,
				position,
			})
			.returning();

		return NextResponse.json({ item });
	} catch (err) {
		const message =
			err instanceof Error ? err.message : "Failed to pin to board";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}

// DELETE — remove a take from the board
export async function DELETE(req: Request) {
	try {
		const session = await auth.api.getSession({ headers: await headers() });
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const { searchParams } = new URL(req.url);
		const id = searchParams.get("id");
		if (!id) {
			return NextResponse.json({ error: "id is required" }, { status: 400 });
		}

		await db.delete(boardItems).where(eq(boardItems.id, id));
		return NextResponse.json({ ok: true });
	} catch (err) {
		const message =
			err instanceof Error ? err.message : "Failed to remove from board";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}

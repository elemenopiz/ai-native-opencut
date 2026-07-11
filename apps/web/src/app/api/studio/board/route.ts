import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { auth } from "@/lib/auth/server";
import {
	boardItems,
	takes,
	generationSets,
	imageStills,
} from "@/lib/db/schema-studio";

// GET — fetch the caller's board items, enriched with their take+set or image still
export async function GET() {
	try {
		// Per-user tenancy: every read is scoped to the session user's ownerId.
		// Legacy rows with a NULL ownerId (pre-backfill / underivable owner) match
		// no one — the board fails closed rather than leaking across accounts.
		const session = await auth.api.getSession({ headers: await headers() });
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		// One query for the whole board: left-join the pinned take (+ its parent
		// set) and the pinned image still, instead of 1-2 lookups PER item (the
		// old N+1 fanned out under Promise.all and scaled with board size).
		const rows = await db
			.select({
				item: boardItems,
				take: takes,
				set: generationSets,
				image: imageStills,
			})
			.from(boardItems)
			.leftJoin(takes, eq(boardItems.takeId, takes.id))
			.leftJoin(generationSets, eq(takes.setId, generationSets.id))
			.leftJoin(imageStills, eq(boardItems.imageStillId, imageStills.id))
			.where(eq(boardItems.ownerId, session.user.id))
			.orderBy(boardItems.position);

		// Same response shape as the per-item lookups: an image item carries
		// `image` (take/set null); everything else carries `take`+`set` (image
		// null), with `set` only present when the take resolved.
		const enriched = rows.map(({ item, take, set, image }) => {
			if (item.kind === "image" && item.imageStillId) {
				return { ...item, image, take: null, set: null };
			}
			return { ...item, take, set: take ? set : null, image: null };
		});

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

		// The pinned artifact must belong to the caller — otherwise any user could
		// pin (and thereby read) another user's take or still by guessing its id.
		// A miss and a cross-user id both 404, so the endpoint never confirms
		// another user's artifact exists (same contract as takes/[takeId]).
		if (imageStillId) {
			const still = await db.query.imageStills.findFirst({
				where: eq(imageStills.id, imageStillId),
			});
			if (!still || still.userId !== session.user.id) {
				return NextResponse.json(
					{ error: "Image still not found" },
					{ status: 404 },
				);
			}
		} else if (takeId) {
			const take = await db.query.takes.findFirst({
				where: eq(takes.id, takeId),
			});
			if (!take) {
				return NextResponse.json({ error: "Take not found" }, { status: 404 });
			}
			// Prefer the denormalized ownerId; legacy rows (NULL, pre-backfill)
			// resolve through the parent set.
			let takeOwner: string | null = take.ownerId;
			if (!takeOwner) {
				const set = await db.query.generationSets.findFirst({
					where: eq(generationSets.id, take.setId),
				});
				takeOwner = set?.userId ?? null;
			}
			if (takeOwner !== session.user.id) {
				return NextResponse.json({ error: "Take not found" }, { status: 404 });
			}
		}

		// Auto-assign next position within the caller's own board
		const existing = await db
			.select()
			.from(boardItems)
			.where(eq(boardItems.ownerId, session.user.id))
			.orderBy(desc(boardItems.position))
			.limit(1);
		const position = (existing[0]?.position ?? -1) + 1;

		const id = nanoid();
		const [item] = await db
			.insert(boardItems)
			.values({
				id,
				// Tenancy: ownership always comes from the session, never the body.
				ownerId: session.user.id,
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

		// Scope the delete to the caller's own rows — a cross-user id matches
		// nothing and 404s, so one user can never unpin another user's board.
		const deleted = await db
			.delete(boardItems)
			.where(
				and(eq(boardItems.id, id), eq(boardItems.ownerId, session.user.id)),
			)
			.returning();
		if (!deleted.length) {
			return NextResponse.json(
				{ error: "Board item not found" },
				{ status: 404 },
			);
		}
		return NextResponse.json({ ok: true });
	} catch (err) {
		const message =
			err instanceof Error ? err.message : "Failed to remove from board";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}

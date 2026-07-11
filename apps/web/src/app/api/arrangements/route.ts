import { NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { arrangements } from "@/lib/db/schema-arrangements";
import { validateArrangement } from "@/lib/arrangements/validate";
import { enforceRateLimit } from "@/lib/rate-limit";

/**
 * Hard cap on the raw request body. `validateArrangement` bounds slot/overlay
 * counts and string lengths, but a couple of fields (transform, background)
 * pass through as-is, and `req.json()` would otherwise happily parse an
 * arbitrarily large body before validation runs. A maxed-out legitimate
 * arrangement is well under this; anything bigger is abuse.
 */
const MAX_BODY_BYTES = 512 * 1024;

/**
 * POST /api/arrangements — publish a media-free arrangement, mint a public id.
 * No login required (matches our no-login-to-try posture), so it is abuse-safe
 * instead: per-IP rate limit, hard body-size cap, and the payload is
 * validated + normalized server-side before insert, so a share link can never
 * smuggle media or oversized data through.
 */
export async function POST(req: Request) {
	try {
		const limited = await enforceRateLimit({
			name: "arrangements:publish",
			request: req,
		});
		if (limited) return limited;

		const contentLength = Number(req.headers.get("content-length") ?? 0);
		if (contentLength > MAX_BODY_BYTES) {
			return NextResponse.json({ error: "Payload too large" }, { status: 413 });
		}

		// Re-check the actual size — content-length can lie or be absent.
		const raw = await req.text();
		if (raw.length > MAX_BODY_BYTES) {
			return NextResponse.json({ error: "Payload too large" }, { status: 413 });
		}

		const body = JSON.parse(raw);
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

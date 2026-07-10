import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { takes } from "@/lib/db/schema-studio";

// PATCH — update a take (star/unstar, change status)
export async function PATCH(
	req: Request,
	{ params }: { params: Promise<{ takeId: string }> },
) {
	try {
		const { takeId } = await params;
		const body = (await req.json()) as {
			starred?: boolean;
			status?: "drafting" | "kept" | "promoted";
		};

		// Whitelist mutable fields — never spread the raw body into `.set()`, which
		// would let a caller overwrite id/setId/videoUrl/providerJobId/seed.
		const patch: Partial<{
			starred: boolean;
			status: "drafting" | "kept" | "promoted";
		}> = {};
		if (typeof body.starred === "boolean") patch.starred = body.starred;
		if (
			body.status === "drafting" ||
			body.status === "kept" ||
			body.status === "promoted"
		) {
			patch.status = body.status;
		}

		if (Object.keys(patch).length === 0) {
			return NextResponse.json(
				{ error: "No valid fields to update" },
				{ status: 400 },
			);
		}

		const updated = await db
			.update(takes)
			.set({ ...patch, updatedAt: new Date() })
			.where(eq(takes.id, takeId))
			.returning();

		if (!updated.length) {
			return NextResponse.json({ error: "Take not found" }, { status: 404 });
		}

		return NextResponse.json({ take: updated[0] });
	} catch (err) {
		const message =
			err instanceof Error ? err.message : "Failed to update take";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}

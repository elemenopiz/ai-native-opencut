import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { auth } from "@/lib/auth/server";
import { db } from "@/lib/db";
import { takes, generationSets } from "@/lib/db/schema-studio";

// PATCH — update a take (star/unstar, change status)
export async function PATCH(
	req: Request,
	{ params }: { params: Promise<{ takeId: string }> },
) {
	try {
		// Mutating a take — require a signed-in user and verify ownership.
		const session = await auth.api.getSession({ headers: await headers() });
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

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

		// The take must belong to the caller — resolve ownership through its parent
		// set (takes carry no userId of their own). A miss or a cross-user take both
		// return 404, so the endpoint never confirms another user's take exists.
		const take = await db.query.takes.findFirst({
			where: eq(takes.id, takeId),
		});
		if (!take) {
			return NextResponse.json({ error: "Take not found" }, { status: 404 });
		}
		const set = await db.query.generationSets.findFirst({
			where: eq(generationSets.id, take.setId),
		});
		if (!set || set.userId !== session.user.id) {
			return NextResponse.json({ error: "Take not found" }, { status: 404 });
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

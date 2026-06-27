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
		const body = await req.json() as {
			starred?: boolean;
			status?: "drafting" | "kept" | "promoted";
		};

		const updated = await db
			.update(takes)
			.set({ ...body, updatedAt: new Date() })
			.where(eq(takes.id, takeId))
			.returning();

		if (!updated.length) {
			return NextResponse.json({ error: "Take not found" }, { status: 404 });
		}

		return NextResponse.json({ take: updated[0] });
	} catch (err) {
		const message = err instanceof Error ? err.message : "Failed to update take";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}

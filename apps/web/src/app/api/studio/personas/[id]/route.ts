import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { personas } from "@/lib/db/schema-studio";

// DELETE — remove a persona. generation_sets.persona_id is ON DELETE SET NULL,
// so historical takes are preserved (they just lose the persona link).
export async function DELETE(
	_req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	try {
		const { id } = await params;
		const deleted = await db
			.delete(personas)
			.where(eq(personas.id, id))
			.returning();

		if (!deleted.length) {
			return NextResponse.json({ error: "Persona not found" }, { status: 404 });
		}
		return NextResponse.json({ ok: true });
	} catch (err) {
		const message = err instanceof Error ? err.message : "Failed to delete persona";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}

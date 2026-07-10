import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { auth } from "@/lib/auth/server";
import { db } from "@/lib/db";
import { personas } from "@/lib/db/schema-studio";

// DELETE — remove a persona. generation_sets.persona_id is ON DELETE SET NULL,
// so historical takes are preserved (they just lose the persona link).
export async function DELETE(
	_req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	try {
		// Destructive — require a signed-in user and scope the delete to their own
		// personas. Matching id AND userId in the WHERE means a cross-user id simply
		// deletes nothing (404), never another user's persona.
		const session = await auth.api.getSession({ headers: await headers() });
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const { id } = await params;
		const deleted = await db
			.delete(personas)
			.where(and(eq(personas.id, id), eq(personas.userId, session.user.id)))
			.returning();

		if (!deleted.length) {
			return NextResponse.json({ error: "Persona not found" }, { status: 404 });
		}
		return NextResponse.json({ ok: true });
	} catch (err) {
		const message =
			err instanceof Error ? err.message : "Failed to delete persona";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}

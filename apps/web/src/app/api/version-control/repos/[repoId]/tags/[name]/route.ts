import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { tags } from "@/lib/db/schema-version-control";
import { auth } from "@/lib/auth/server";
import { headers } from "next/headers";
import { eq, and } from "drizzle-orm";
import {
	checkRepoAccess,
	checkRepoOwner,
} from "@/lib/db/version-control-utils";

export async function DELETE(
	_request: NextRequest,
	{ params }: { params: Promise<{ repoId: string; name: string }> },
) {
	try {
		const session = await auth.api.getSession({ headers: await headers() });
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const { repoId, name } = await params;
		// WRITE gate: only the repo owner may delete tags (no tag-permission
		// concept exists in the schema).
		if (!(await checkRepoOwner(repoId, session.user.id))) {
			const visible = await checkRepoAccess(repoId, session.user.id);
			return NextResponse.json(
				{ error: visible ? "Forbidden" : "Not found" },
				{ status: visible ? 403 : 404 },
			);
		}

		await db
			.delete(tags)
			.where(and(eq(tags.repoId, repoId), eq(tags.name, name)));

		return NextResponse.json({ ok: true });
	} catch (error) {
		console.error("Error deleting tag:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}

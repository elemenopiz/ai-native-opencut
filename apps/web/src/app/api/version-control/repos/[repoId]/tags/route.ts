import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { tags } from "@/lib/db/schema-version-control";
import { auth } from "@/lib/auth/server";
import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { generateUUID } from "@/utils/id";
import {
	checkRepoAccess,
	checkRepoOwner,
} from "@/lib/db/version-control-utils";

const createTagSchema = z.object({
	id: z.string().optional(),
	commitId: z.string(),
	name: z.string().min(1),
	type: z.string().default("custom"),
	note: z.string().optional(),
});

export async function POST(
	request: NextRequest,
	{ params }: { params: Promise<{ repoId: string }> },
) {
	try {
		const session = await auth.api.getSession({ headers: await headers() });
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const { repoId } = await params;
		// WRITE gate: tags aren't branch-scoped and there's no tag-permission
		// concept in the schema, so only the repo owner may create them.
		if (!(await checkRepoOwner(repoId, session.user.id))) {
			const visible = await checkRepoAccess(repoId, session.user.id);
			return NextResponse.json(
				{ error: visible ? "Forbidden" : "Not found" },
				{ status: visible ? 403 : 404 },
			);
		}

		const body = await request.json();
		const parsed = createTagSchema.safeParse(body);
		if (!parsed.success) {
			return NextResponse.json({ error: "Invalid request" }, { status: 400 });
		}

		const tag = {
			id: parsed.data.id || generateUUID(),
			repoId,
			...parsed.data,
			createdBy: session.user.id,
			createdAt: new Date(),
		};

		const inserted = await db
			.insert(tags)
			.values(tag)
			.onConflictDoNothing()
			.returning({ id: tags.id });
		if (inserted.length === 0) {
			// Unique (repoId, name) collision — the row was not written.
			return NextResponse.json(
				{ error: "A tag with that name already exists" },
				{ status: 409 },
			);
		}
		return NextResponse.json(tag, { status: 201 });
	} catch (error) {
		console.error("Error creating tag:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}

export async function GET(
	_request: NextRequest,
	{ params }: { params: Promise<{ repoId: string }> },
) {
	try {
		const session = await auth.api.getSession({ headers: await headers() });
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const { repoId } = await params;
		if (!(await checkRepoAccess(repoId, session.user.id))) {
			return NextResponse.json({ error: "Not found" }, { status: 404 });
		}

		const result = await db.select().from(tags).where(eq(tags.repoId, repoId));
		return NextResponse.json(result);
	} catch (error) {
		console.error("Error listing tags:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}

import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { branches } from "@/lib/db/schema-version-control";
import { auth } from "@/lib/auth/server";
import { headers } from "next/headers";
import { eq, and } from "drizzle-orm";
import {
	checkBranchPushPermission,
	checkRepoAccess,
} from "@/lib/db/version-control-utils";

const updateBranchSchema = z.object({
	headCommitId: z.string().optional(),
	description: z.string().optional(),
	color: z.string().optional(),
});

export async function PUT(
	request: NextRequest,
	{ params }: { params: Promise<{ repoId: string; name: string }> },
) {
	try {
		const session = await auth.api.getSession({ headers: await headers() });
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const { repoId, name } = await params;
		// WRITE gate: require push permission on this branch (owner, or explicit
		// branch write/admin). checkRepoAccess is read-only and would allow any
		// signed-in user to mutate a public repo they don't own.
		const push = await checkBranchPushPermission(repoId, name, session.user.id);
		if (!push.allowed) {
			// 403 when the repo is visible but the caller can't write; 404 when the
			// repo isn't visible at all (don't leak its existence).
			const visible = await checkRepoAccess(repoId, session.user.id);
			return NextResponse.json(
				{ error: visible ? "Forbidden" : "Not found" },
				{ status: visible ? 403 : 404 },
			);
		}

		const body = await request.json();
		const parsed = updateBranchSchema.safeParse(body);
		if (!parsed.success) {
			return NextResponse.json({ error: "Invalid request" }, { status: 400 });
		}

		const updated = await db
			.update(branches)
			.set(parsed.data)
			.where(and(eq(branches.repoId, repoId), eq(branches.name, name)))
			.returning({ id: branches.id });

		if (updated.length === 0) {
			return NextResponse.json({ error: "Branch not found" }, { status: 404 });
		}

		return NextResponse.json({ ok: true });
	} catch (error) {
		console.error("Error updating branch:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}

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
		// WRITE gate: deleting a branch requires push permission on it.
		const push = await checkBranchPushPermission(repoId, name, session.user.id);
		if (!push.allowed) {
			const visible = await checkRepoAccess(repoId, session.user.id);
			return NextResponse.json(
				{ error: visible ? "Forbidden" : "Not found" },
				{ status: visible ? 403 : 404 },
			);
		}

		if (name === "main") {
			return NextResponse.json(
				{ error: "Cannot delete main branch" },
				{ status: 400 },
			);
		}

		await db
			.delete(branches)
			.where(and(eq(branches.repoId, repoId), eq(branches.name, name)));

		return NextResponse.json({ ok: true });
	} catch (error) {
		console.error("Error deleting branch:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}

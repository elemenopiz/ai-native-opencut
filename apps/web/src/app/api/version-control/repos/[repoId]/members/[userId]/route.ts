import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { projectMembers } from "@/lib/db/schema-version-control";
import { auth } from "@/lib/auth/server";
import { headers } from "next/headers";
import { and, eq } from "drizzle-orm";
import { getRepoRole } from "@/lib/db/version-control-utils";

const updateRoleSchema = z.object({
	role: z.enum(["editor", "viewer"]),
});

/**
 * DELETE /api/version-control/repos/[repoId]/members/[userId]
 * Remove a member. The owner can remove anyone; a member can remove
 * themselves (leave the project).
 */
export async function DELETE(
	_request: NextRequest,
	{ params }: { params: Promise<{ repoId: string; userId: string }> },
) {
	try {
		const session = await auth.api.getSession({ headers: await headers() });
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const { repoId, userId } = await params;
		const role = await getRepoRole(repoId, session.user.id);
		if (!role) {
			return NextResponse.json({ error: "Not found" }, { status: 404 });
		}

		const isSelf = userId === session.user.id;
		if (role !== "owner" && !isSelf) {
			return NextResponse.json(
				{ error: "Forbidden", message: "Only the owner can remove teammates" },
				{ status: 403 },
			);
		}

		const deleted = await db
			.delete(projectMembers)
			.where(
				and(
					eq(projectMembers.repoId, repoId),
					eq(projectMembers.userId, userId),
				),
			)
			.returning({ id: projectMembers.id });

		if (deleted.length === 0) {
			return NextResponse.json({ error: "Member not found" }, { status: 404 });
		}

		return NextResponse.json({ ok: true });
	} catch (error) {
		console.error("Error removing member:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}

/**
 * PATCH /api/version-control/repos/[repoId]/members/[userId]
 * Change a member's role. Owner only.
 */
export async function PATCH(
	request: NextRequest,
	{ params }: { params: Promise<{ repoId: string; userId: string }> },
) {
	try {
		const session = await auth.api.getSession({ headers: await headers() });
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const { repoId, userId } = await params;
		const role = await getRepoRole(repoId, session.user.id);
		if (!role) {
			return NextResponse.json({ error: "Not found" }, { status: 404 });
		}
		if (role !== "owner") {
			return NextResponse.json(
				{ error: "Forbidden", message: "Only the owner can change roles" },
				{ status: 403 },
			);
		}

		const body = await request.json();
		const parsed = updateRoleSchema.safeParse(body);
		if (!parsed.success) {
			return NextResponse.json({ error: "Invalid request" }, { status: 400 });
		}

		const updated = await db
			.update(projectMembers)
			.set({ role: parsed.data.role })
			.where(
				and(
					eq(projectMembers.repoId, repoId),
					eq(projectMembers.userId, userId),
				),
			)
			.returning();

		if (updated.length === 0) {
			return NextResponse.json({ error: "Member not found" }, { status: 404 });
		}

		return NextResponse.json(updated[0]);
	} catch (error) {
		console.error("Error updating member role:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}

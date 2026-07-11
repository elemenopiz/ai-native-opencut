import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import {
	projectInvitations,
	projectMembers,
} from "@/lib/db/schema-version-control";
import { auth } from "@/lib/auth/server";
import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { generateUUID } from "@/utils/id";
import { getRepoRole } from "@/lib/db/version-control-utils";

const respondSchema = z.object({
	action: z.enum(["accept", "decline"]),
});

/**
 * POST /api/version-control/invitations/[inviteId]
 * Accept or decline an invitation addressed to the signed-in user's email.
 * Accepting creates the membership row — the project then appears under
 * "Shared with me".
 */
export async function POST(
	request: NextRequest,
	{ params }: { params: Promise<{ inviteId: string }> },
) {
	try {
		const session = await auth.api.getSession({ headers: await headers() });
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const { inviteId } = await params;
		const body = await request.json();
		const parsed = respondSchema.safeParse(body);
		if (!parsed.success) {
			return NextResponse.json({ error: "Invalid request" }, { status: 400 });
		}

		const [invite] = await db
			.select()
			.from(projectInvitations)
			.where(eq(projectInvitations.id, inviteId))
			.limit(1);

		// Invitations are addressed to an email — only that account may respond.
		if (!invite || invite.email !== session.user.email.toLowerCase()) {
			return NextResponse.json({ error: "Not found" }, { status: 404 });
		}
		if (invite.status !== "pending") {
			return NextResponse.json(
				{ error: "Invitation is no longer pending" },
				{ status: 409 },
			);
		}

		if (parsed.data.action === "decline") {
			await db
				.update(projectInvitations)
				.set({ status: "declined", respondedAt: new Date() })
				.where(eq(projectInvitations.id, inviteId));
			return NextResponse.json({ ok: true, status: "declined" });
		}

		// Accept: create the membership (idempotent on re-accept races).
		await db
			.insert(projectMembers)
			.values({
				id: generateUUID(),
				repoId: invite.repoId,
				userId: session.user.id,
				role: invite.role === "viewer" ? "viewer" : "editor",
				invitedBy: invite.invitedBy,
				createdAt: new Date(),
			})
			.onConflictDoNothing();

		await db
			.update(projectInvitations)
			.set({ status: "accepted", respondedAt: new Date() })
			.where(eq(projectInvitations.id, inviteId));

		return NextResponse.json({
			ok: true,
			status: "accepted",
			repoId: invite.repoId,
		});
	} catch (error) {
		console.error("Error responding to invitation:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}

/**
 * DELETE /api/version-control/invitations/[inviteId]
 * Revoke a pending invitation. Repo owner only.
 */
export async function DELETE(
	_request: NextRequest,
	{ params }: { params: Promise<{ inviteId: string }> },
) {
	try {
		const session = await auth.api.getSession({ headers: await headers() });
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const { inviteId } = await params;
		const [invite] = await db
			.select()
			.from(projectInvitations)
			.where(eq(projectInvitations.id, inviteId))
			.limit(1);
		if (!invite) {
			return NextResponse.json({ error: "Not found" }, { status: 404 });
		}

		const role = await getRepoRole(invite.repoId, session.user.id);
		if (role !== "owner") {
			return NextResponse.json({ error: "Not found" }, { status: 404 });
		}

		await db
			.update(projectInvitations)
			.set({ status: "revoked", respondedAt: new Date() })
			.where(eq(projectInvitations.id, inviteId));

		return NextResponse.json({ ok: true });
	} catch (error) {
		console.error("Error revoking invitation:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}

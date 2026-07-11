import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import {
	projectInvitations,
	projectMembers,
	projectRepositories,
} from "@/lib/db/schema-version-control";
import { auth } from "@/lib/auth/server";
import { headers } from "next/headers";
import { and, eq } from "drizzle-orm";
import { generateUUID } from "@/utils/id";
import { enforceRateLimit } from "@/lib/rate-limit";
import { getRepoRole } from "@/lib/db/version-control-utils";
import { sendEmail } from "@/lib/auth/email";
import { webEnv } from "@byorn/env/web";

/** Keep teams small while collaboration is young — bounds invite fan-out too. */
const MAX_MEMBERS_PER_REPO = 25;

const inviteSchema = z.object({
	email: z.string().email().max(320),
	role: z.enum(["editor", "viewer"]).default("editor"),
});

/**
 * GET /api/version-control/repos/[repoId]/members
 * List the owner, accepted members, and pending invitations for a repo.
 * Visible to anyone with a role on the repo.
 */
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
		const role = await getRepoRole(repoId, session.user.id);
		if (!role) {
			return NextResponse.json({ error: "Not found" }, { status: 404 });
		}

		const [repo] = await db
			.select({
				userId: projectRepositories.userId,
				ownerName: users.name,
				ownerEmail: users.email,
				ownerImage: users.image,
			})
			.from(projectRepositories)
			.leftJoin(users, eq(projectRepositories.userId, users.id))
			.where(eq(projectRepositories.id, repoId))
			.limit(1);

		const members = await db
			.select({
				userId: projectMembers.userId,
				role: projectMembers.role,
				createdAt: projectMembers.createdAt,
				name: users.name,
				email: users.email,
				image: users.image,
			})
			.from(projectMembers)
			.innerJoin(users, eq(projectMembers.userId, users.id))
			.where(eq(projectMembers.repoId, repoId));

		const invitations = await db
			.select({
				id: projectInvitations.id,
				email: projectInvitations.email,
				role: projectInvitations.role,
				status: projectInvitations.status,
				createdAt: projectInvitations.createdAt,
			})
			.from(projectInvitations)
			.where(
				and(
					eq(projectInvitations.repoId, repoId),
					eq(projectInvitations.status, "pending"),
				),
			);

		return NextResponse.json({
			owner: repo
				? {
						userId: repo.userId,
						name: repo.ownerName,
						email: repo.ownerEmail,
						image: repo.ownerImage,
					}
				: null,
			members,
			pendingInvitations: invitations,
			myRole: role,
		});
	} catch (error) {
		console.error("Error listing members:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}

/**
 * POST /api/version-control/repos/[repoId]/members
 * Invite a teammate by email. Owner only. Creates (or re-arms) a pending
 * invitation keyed by lowercased email — the invitee accepts it from their
 * projects page, whether or not they had a Byorn account when invited.
 */
export async function POST(
	request: NextRequest,
	{ params }: { params: Promise<{ repoId: string }> },
) {
	try {
		const session = await auth.api.getSession({ headers: await headers() });
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const limited = await enforceRateLimit({
			name: "vc:invite",
			request,
			userId: session.user.id,
		});
		if (limited) return limited;

		const { repoId } = await params;
		const role = await getRepoRole(repoId, session.user.id);
		if (!role) {
			return NextResponse.json({ error: "Not found" }, { status: 404 });
		}
		if (role !== "owner") {
			return NextResponse.json(
				{ error: "Forbidden", message: "Only the project owner can invite" },
				{ status: 403 },
			);
		}

		const body = await request.json();
		const parsed = inviteSchema.safeParse(body);
		if (!parsed.success) {
			return NextResponse.json(
				{ error: "Invalid request", details: parsed.error.flatten() },
				{ status: 400 },
			);
		}

		const email = parsed.data.email.trim().toLowerCase();
		if (email === session.user.email.toLowerCase()) {
			return NextResponse.json(
				{ error: "That's you", message: "You already own this project" },
				{ status: 400 },
			);
		}

		// Already an accepted member? (Invitee may or may not have an account.)
		const [invitee] = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.email, email))
			.limit(1);
		if (invitee) {
			const [existing] = await db
				.select({ id: projectMembers.id })
				.from(projectMembers)
				.where(
					and(
						eq(projectMembers.repoId, repoId),
						eq(projectMembers.userId, invitee.id),
					),
				)
				.limit(1);
			if (existing) {
				return NextResponse.json(
					{
						error: "Already a member",
						message: `${email} is already on this project`,
					},
					{ status: 409 },
				);
			}
		}

		const memberCount = await db
			.select({ id: projectMembers.id })
			.from(projectMembers)
			.where(eq(projectMembers.repoId, repoId));
		if (memberCount.length >= MAX_MEMBERS_PER_REPO) {
			return NextResponse.json(
				{
					error: "Member limit reached",
					message: `Projects are capped at ${MAX_MEMBERS_PER_REPO} teammates for now`,
				},
				{ status: 400 },
			);
		}

		// One live row per (repo, email): re-inviting a declined/revoked address
		// re-arms the same row back to pending.
		const invitation = {
			id: generateUUID(),
			repoId,
			email,
			role: parsed.data.role,
			status: "pending",
			invitedBy: session.user.id,
			createdAt: new Date(),
			respondedAt: null,
		};
		const [saved] = await db
			.insert(projectInvitations)
			.values(invitation)
			.onConflictDoUpdate({
				target: [projectInvitations.repoId, projectInvitations.email],
				set: {
					role: parsed.data.role,
					status: "pending",
					invitedBy: session.user.id,
					createdAt: new Date(),
					respondedAt: null,
				},
			})
			.returning();

		// Best-effort notification — never fail the invite over email delivery.
		const [repo] = await db
			.select({ name: projectRepositories.name })
			.from(projectRepositories)
			.where(eq(projectRepositories.id, repoId))
			.limit(1);
		try {
			const projectName = repo?.name ?? "a project";
			const appUrl = webEnv.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
			await sendEmail({
				to: email,
				subject: `${session.user.name} invited you to "${projectName}" on Byorn`,
				html: `<p>${session.user.name} invited you to collaborate on <strong>${projectName}</strong> on Byorn.</p><p><a href="${appUrl}/projects">Open your projects page</a> to accept the invite${invitee ? "" : " — sign up with this email address and it will be waiting for you"}.</p>`,
				text: `${session.user.name} invited you to collaborate on "${projectName}" on Byorn. Open ${appUrl}/projects to accept the invite${invitee ? "" : " — sign up with this email address and it will be waiting for you"}.`,
			});
		} catch (emailError) {
			console.error("Invite email failed (invite still created):", emailError);
		}

		return NextResponse.json(saved, { status: 201 });
	} catch (error) {
		console.error("Error inviting member:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}

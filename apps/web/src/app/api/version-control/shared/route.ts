import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import {
	branches,
	commits,
	projectInvitations,
	projectMembers,
	projectRepositories,
} from "@/lib/db/schema-version-control";
import { auth } from "@/lib/auth/server";
import { headers } from "next/headers";
import { and, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

/**
 * GET /api/version-control/shared
 * Everything the signed-in user sees under "Shared with me":
 *   - pending invitations addressed to their email (join → repo + inviter)
 *   - projects they're a member of (join → repo + owner + main-head metadata
 *     so the projects page can render a real card before the clone exists)
 */
export async function GET() {
	try {
		const session = await auth.api.getSession({ headers: await headers() });
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const email = session.user.email.toLowerCase();
		const inviter = alias(users, "inviter");

		const invitations = await db
			.select({
				id: projectInvitations.id,
				repoId: projectInvitations.repoId,
				role: projectInvitations.role,
				createdAt: projectInvitations.createdAt,
				projectName: projectRepositories.name,
				inviterName: inviter.name,
				inviterEmail: inviter.email,
				inviterImage: inviter.image,
			})
			.from(projectInvitations)
			.innerJoin(
				projectRepositories,
				eq(projectInvitations.repoId, projectRepositories.id),
			)
			.leftJoin(inviter, eq(projectInvitations.invitedBy, inviter.id))
			.where(
				and(
					eq(projectInvitations.email, email),
					eq(projectInvitations.status, "pending"),
				),
			);

		const memberships = await db
			.select({
				repoId: projectMembers.repoId,
				role: projectMembers.role,
				joinedAt: projectMembers.createdAt,
				projectId: projectRepositories.projectId,
				name: projectRepositories.name,
				defaultBranch: projectRepositories.defaultBranch,
				updatedAt: projectRepositories.updatedAt,
				ownerName: users.name,
				ownerEmail: users.email,
				ownerImage: users.image,
			})
			.from(projectMembers)
			.innerJoin(
				projectRepositories,
				eq(projectMembers.repoId, projectRepositories.id),
			)
			.leftJoin(users, eq(projectRepositories.userId, users.id))
			.where(eq(projectMembers.userId, session.user.id));

		// Decorate each shared project with its default-branch head commit's
		// thumbnail/duration so the card looks like a project, not a stub.
		const repoIds = memberships.map((m) => m.repoId);
		const headByRepo = new Map<
			string,
			{ thumbnailUrl: string | null; duration: number; updatedAt: Date }
		>();
		if (repoIds.length > 0) {
			const branchRows = await db
				.select({
					repoId: branches.repoId,
					name: branches.name,
					headCommitId: branches.headCommitId,
				})
				.from(branches)
				.where(inArray(branches.repoId, repoIds));

			const defaultBranchByRepo = new Map(
				memberships.map((m) => [m.repoId, m.defaultBranch]),
			);
			const headCommitIds = branchRows
				.filter((b) => b.name === defaultBranchByRepo.get(b.repoId))
				.map((b) => ({ repoId: b.repoId, commitId: b.headCommitId }));

			if (headCommitIds.length > 0) {
				const commitRows = await db
					.select({
						id: commits.id,
						thumbnailUrl: commits.thumbnailUrl,
						duration: commits.duration,
						createdAt: commits.createdAt,
					})
					.from(commits)
					.where(
						inArray(
							commits.id,
							headCommitIds.map((h) => h.commitId),
						),
					);
				const commitById = new Map(commitRows.map((c) => [c.id, c]));
				for (const { repoId, commitId } of headCommitIds) {
					const commit = commitById.get(commitId);
					if (commit) {
						headByRepo.set(repoId, {
							thumbnailUrl: commit.thumbnailUrl,
							duration: commit.duration,
							updatedAt: commit.createdAt,
						});
					}
				}
			}
		}

		return NextResponse.json({
			invitations,
			projects: memberships.map((m) => ({
				repoId: m.repoId,
				projectId: m.projectId,
				name: m.name,
				role: m.role,
				defaultBranch: m.defaultBranch,
				joinedAt: m.joinedAt,
				owner: {
					name: m.ownerName,
					email: m.ownerEmail,
					image: m.ownerImage,
				},
				thumbnailUrl: headByRepo.get(m.repoId)?.thumbnailUrl ?? null,
				duration: headByRepo.get(m.repoId)?.duration ?? 0,
				updatedAt: headByRepo.get(m.repoId)?.updatedAt ?? m.updatedAt,
			})),
		});
	} catch (error) {
		console.error("Error listing shared projects:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}

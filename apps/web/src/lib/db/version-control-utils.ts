import { db } from "@/lib/db";
import {
	branches,
	branchPermissions,
	projectMembers,
	projectRepositories,
} from "./schema-version-control";
import { eq, and } from "drizzle-orm";

/** Collaboration role a user holds on a repo. Owner ⊃ editor ⊃ viewer. */
export type RepoRole = "owner" | "editor" | "viewer";

/**
 * Resolve the collaboration role a user holds on a repo: "owner" for the repo
 * creator, the project_members role for invited teammates, null for everyone
 * else. Public visibility is NOT a role — callers that want public-read must
 * check repo.isPublic themselves (checkRepoAccess already does).
 */
export async function getRepoRole(
	repoId: string,
	userId: string,
): Promise<RepoRole | null> {
	const repos = await db
		.select({ userId: projectRepositories.userId })
		.from(projectRepositories)
		.where(eq(projectRepositories.id, repoId))
		.limit(1);

	if (repos.length === 0) return null;
	if (repos[0].userId === userId) return "owner";

	const members = await db
		.select({ role: projectMembers.role })
		.from(projectMembers)
		.where(
			and(eq(projectMembers.repoId, repoId), eq(projectMembers.userId, userId)),
		)
		.limit(1);

	if (members.length === 0) return null;
	return members[0].role === "viewer" ? "viewer" : "editor";
}

/**
 * Check if a user can push to a specific branch.
 * Returns { allowed, reason }.
 */
export async function checkBranchPushPermission(
	repoId: string,
	branchName: string,
	userId: string,
): Promise<{ allowed: boolean; reason?: string }> {
	// Get repo — check if user is owner
	const repos = await db
		.select()
		.from(projectRepositories)
		.where(eq(projectRepositories.id, repoId))
		.limit(1);

	if (repos.length === 0) {
		return { allowed: false, reason: "Repository not found" };
	}

	const repo = repos[0];

	// Repo owner always has access
	if (repo.userId === userId) {
		return { allowed: true };
	}

	// Get the branch
	const branchResults = await db
		.select()
		.from(branches)
		.where(and(eq(branches.repoId, repoId), eq(branches.name, branchName)))
		.limit(1);

	if (branchResults.length === 0) {
		return { allowed: false, reason: "Branch not found" };
	}

	const branch = branchResults[0];

	// Protected branches require explicit write permission
	if (branch.isProtected) {
		const perms = await db
			.select()
			.from(branchPermissions)
			.where(
				and(
					eq(branchPermissions.branchId, branch.id),
					eq(branchPermissions.userId, userId),
				),
			)
			.limit(1);

		if (perms.length === 0) {
			return {
				allowed: false,
				reason: `Branch "${branchName}" is protected. Merge required.`,
			};
		}

		const perm = perms[0];
		if (perm.permission === "read") {
			return {
				allowed: false,
				reason: `You only have read access to "${branchName}"`,
			};
		}

		return { allowed: true };
	}

	// For public repos, anyone can push to non-protected branches
	if (repo.isPublic) {
		return { allowed: true };
	}

	// Shared-project editors can push to non-protected branches.
	const memberRows = await db
		.select({ role: projectMembers.role })
		.from(projectMembers)
		.where(
			and(eq(projectMembers.repoId, repoId), eq(projectMembers.userId, userId)),
		)
		.limit(1);
	if (memberRows.length > 0) {
		if (memberRows[0].role === "viewer") {
			return {
				allowed: false,
				reason: "You have view-only access to this project",
			};
		}
		return { allowed: true };
	}

	// For private repos, check if the user holds any permission on THIS repo's
	// branches. Scope via branches.repoId — an unscoped userId lookup would leak
	// cross-repo access (a permission on some OTHER repo would grant entry here).
	const perms = await db
		.select({ id: branchPermissions.id })
		.from(branchPermissions)
		.innerJoin(branches, eq(branchPermissions.branchId, branches.id))
		.where(
			and(eq(branches.repoId, repoId), eq(branchPermissions.userId, userId)),
		)
		.limit(1);

	if (perms.length === 0) {
		return { allowed: false, reason: "No access to this repository" };
	}

	return { allowed: true };
}

/**
 * Check if a repo is visible to a user.
 */
export async function checkRepoAccess(
	repoId: string,
	userId: string,
): Promise<boolean> {
	const repos = await db
		.select()
		.from(projectRepositories)
		.where(eq(projectRepositories.id, repoId))
		.limit(1);

	if (repos.length === 0) return false;

	const repo = repos[0];
	if (repo.isPublic) return true;
	if (repo.userId === userId) return true;

	// Shared-project members (any role) can read the repo.
	const members = await db
		.select({ id: projectMembers.id })
		.from(projectMembers)
		.where(
			and(eq(projectMembers.repoId, repoId), eq(projectMembers.userId, userId)),
		)
		.limit(1);
	if (members.length > 0) return true;

	// Check if user has any branch permission in this repo
	const branchList = await db
		.select({ id: branches.id })
		.from(branches)
		.where(eq(branches.repoId, repoId))
		.limit(1);

	if (branchList.length === 0) return false;

	const perms = await db
		.select()
		.from(branchPermissions)
		.where(
			and(
				eq(branchPermissions.branchId, branchList[0].id),
				eq(branchPermissions.userId, userId),
			),
		)
		.limit(1);

	return perms.length > 0;
}

/**
 * Check if a user OWNS a repo. Use this to gate write operations that only the
 * owner may perform (creating/deleting tags, etc.).
 *
 * NOTE: unlike checkRepoAccess (a READ-visibility check that returns true for
 * ANY public repo), this never grants access on the basis of public visibility.
 */
export async function checkRepoOwner(
	repoId: string,
	userId: string,
): Promise<boolean> {
	const repos = await db
		.select({ userId: projectRepositories.userId })
		.from(projectRepositories)
		.where(eq(projectRepositories.id, repoId))
		.limit(1);

	if (repos.length === 0) return false;

	return repos[0].userId === userId;
}

/**
 * Check if a user may WRITE to a repo (create branches, push commits, …).
 * True for the repo owner, or a user holding a write/admin branch permission on
 * ANY branch of THIS repo. Unlike checkRepoAccess, this is NOT satisfied merely
 * by a repo being public — public visibility is read-only.
 */
export async function checkRepoWriteAccess(
	repoId: string,
	userId: string,
): Promise<boolean> {
	const repos = await db
		.select({ userId: projectRepositories.userId })
		.from(projectRepositories)
		.where(eq(projectRepositories.id, repoId))
		.limit(1);

	if (repos.length === 0) return false;
	if (repos[0].userId === userId) return true;

	// Shared-project members with the "editor" role can write; viewers cannot.
	const members = await db
		.select({ role: projectMembers.role })
		.from(projectMembers)
		.where(
			and(eq(projectMembers.repoId, repoId), eq(projectMembers.userId, userId)),
		)
		.limit(1);
	if (members.length > 0 && members[0].role !== "viewer") return true;

	// Scope the permission lookup to THIS repo's branches (via branches.repoId).
	const perms = await db
		.select({ permission: branchPermissions.permission })
		.from(branchPermissions)
		.innerJoin(branches, eq(branchPermissions.branchId, branches.id))
		.where(
			and(eq(branches.repoId, repoId), eq(branchPermissions.userId, userId)),
		)
		.limit(1);

	if (perms.length === 0) return false;

	return perms[0].permission === "write" || perms[0].permission === "admin";
}

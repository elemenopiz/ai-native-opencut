import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import {
	projectRepositories,
	commits,
	branches,
	tags,
} from "@/lib/db/schema-version-control";
import { auth } from "@/lib/auth/server";
import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { generateUUID } from "@/utils/id";
import { checkRepoAccess } from "@/lib/db/version-control-utils";
import { enforceRateLimit } from "@/lib/rate-limit";

const forkSchema = z.object({
	newProjectId: z.string().min(1),
	name: z.string().min(1),
});

/**
 * Rows per multi-row INSERT. Commits have ~20 columns, so 500 rows stays far
 * under Postgres's 65535 bind-parameter limit while keeping the round-trip
 * count low for large histories.
 */
const INSERT_CHUNK_SIZE = 500;

async function insertChunked<T>(
	insert: (rows: T[]) => Promise<unknown>,
	rows: T[],
): Promise<void> {
	for (let i = 0; i < rows.length; i += INSERT_CHUNK_SIZE) {
		await insert(rows.slice(i, i + INSERT_CHUNK_SIZE));
	}
}

/**
 * POST /api/version-control/repos/:repoId/fork
 * Fork a repository — copy all commits, branches, and tags.
 * Media files are shared by reference (content-addressable), not duplicated.
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

		// Forking copies an entire history in one request — keep it rare per user.
		const limited = await enforceRateLimit({
			name: "vc:fork",
			request,
			userId: session.user.id,
		});
		if (limited) return limited;

		const { repoId } = await params;
		// Only repos the caller can see (own, or public) may be forked — never
		// another user's private repo, whose full history the fork would copy.
		if (!(await checkRepoAccess(repoId, session.user.id))) {
			return NextResponse.json({ error: "Not found" }, { status: 404 });
		}

		const body = await request.json();
		const parsed = forkSchema.safeParse(body);
		if (!parsed.success) {
			return NextResponse.json({ error: "Invalid request" }, { status: 400 });
		}

		// Get source repo
		const sourceRepos = await db
			.select()
			.from(projectRepositories)
			.where(eq(projectRepositories.id, repoId))
			.limit(1);

		if (sourceRepos.length === 0) {
			return NextResponse.json(
				{ error: "Source repo not found" },
				{ status: 404 },
			);
		}

		const sourceRepo = sourceRepos[0];

		// Copy all commits (they reference media by hash, no duplication needed).
		// Commit ids are the table's GLOBAL primary key, so the fork must re-key
		// every commit; reusing the source ids would collide with the existing
		// rows. Build an old→new id map first, then remap all intra-history
		// references so parents/branch heads/tags point at the copied commits.
		const sourceCommits = await db
			.select()
			.from(commits)
			.where(eq(commits.repoId, repoId));

		const commitIdMap = new Map<string, string>();
		for (const commit of sourceCommits) {
			commitIdMap.set(commit.id, generateUUID());
		}
		const remapCommitId = <T extends string | null>(id: T): T =>
			(id ? (commitIdMap.get(id) ?? id) : id) as T;

		const sourceBranches = await db
			.select()
			.from(branches)
			.where(eq(branches.repoId, repoId));

		const sourceTags = await db
			.select()
			.from(tags)
			.where(eq(tags.repoId, repoId));

		// All fork writes happen atomically: if any insert fails (or the request
		// times out mid-copy), the transaction rolls back and no half-copied fork
		// is left behind. Rows go in as chunked multi-row inserts rather than one
		// statement per row, so large histories don't pay a round-trip per commit.
		const newRepoId = generateUUID();
		await db.transaction(async (tx) => {
			await tx.insert(projectRepositories).values({
				id: newRepoId,
				projectId: parsed.data.newProjectId,
				userId: session.user.id,
				name: parsed.data.name,
				defaultBranch: sourceRepo.defaultBranch,
				isPublic: false,
				forkedFromId: repoId,
				forkedFromCommitId: null,
				createdAt: new Date(),
				updatedAt: new Date(),
			});

			await insertChunked(
				(rows) => tx.insert(commits).values(rows),
				sourceCommits.map((commit) => ({
					...commit,
					id: commitIdMap.get(commit.id) as string,
					repoId: newRepoId,
					parentId: remapCommitId(commit.parentId),
					mergeParentId: remapCommitId(commit.mergeParentId),
					keyframeAncestorId: remapCommitId(commit.keyframeAncestorId),
				})),
			);

			// Copy branches (re-key their head/created-from commit references)
			await insertChunked(
				(rows) => tx.insert(branches).values(rows),
				sourceBranches.map((branch) => ({
					...branch,
					id: generateUUID(),
					repoId: newRepoId,
					headCommitId: remapCommitId(branch.headCommitId),
					createdFromCommitId: remapCommitId(branch.createdFromCommitId),
				})),
			);

			// Copy tags (re-key their commit reference)
			await insertChunked(
				(rows) => tx.insert(tags).values(rows),
				sourceTags.map((tag) => ({
					...tag,
					id: generateUUID(),
					repoId: newRepoId,
					commitId: remapCommitId(tag.commitId),
				})),
			);
		});

		return NextResponse.json(
			{
				id: newRepoId,
				forkedFrom: repoId,
				commits: sourceCommits.length,
				branches: sourceBranches.length,
				tags: sourceTags.length,
			},
			{ status: 201 },
		);
	} catch (error) {
		console.error("Error forking repo:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}

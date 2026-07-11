import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import {
	commits,
	branches,
	tags,
	projectRepositories,
} from "@/lib/db/schema-version-control";
import { auth } from "@/lib/auth/server";
import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { enforceRateLimit } from "@/lib/rate-limit";

/** Max entities per push array — matches the commits route's batch clamp. */
const MAX_PUSH_BATCH = 200;
/** Max total request body (batch of snapshots), pre-checked via content-length. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

const syncRequestSchema = z.object({
	/** Commit IDs the client already has */
	knownCommitIds: z.array(z.string()),
	/** New commits to push to server */
	pushCommits: z.array(z.unknown()).max(MAX_PUSH_BATCH).optional(),
	/** Branch updates to push */
	pushBranches: z.array(z.unknown()).max(MAX_PUSH_BATCH).optional(),
	/** Tag updates to push */
	pushTags: z.array(z.unknown()).max(MAX_PUSH_BATCH).optional(),
});

/**
 * Bulk sync endpoint: push local changes AND pull remote changes in one request.
 * Returns commits/branches/tags that the client doesn't have.
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

		// Throttle syncs per account before any body parsing or repo lookups.
		const limited = await enforceRateLimit({
			name: "vc:sync",
			request,
			userId: session.user.id,
		});
		if (limited) return limited;

		// Cheap reject of oversized bodies before json() buffers them.
		const contentLength = Number(request.headers.get("content-length"));
		if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
			return NextResponse.json(
				{
					error: "Request body too large",
					message: `Sync requests are capped at ${MAX_BODY_BYTES / (1024 * 1024)} MB — push in smaller batches.`,
					maxBytes: MAX_BODY_BYTES,
				},
				{ status: 413 },
			);
		}

		const { repoId } = await params;

		// Verify the caller owns this repo before reading or writing its history.
		const [repo] = await db
			.select({ userId: projectRepositories.userId })
			.from(projectRepositories)
			.where(eq(projectRepositories.id, repoId))
			.limit(1);
		if (!repo || repo.userId !== session.user.id) {
			return NextResponse.json({ error: "Not found" }, { status: 404 });
		}

		const body = await request.json();
		const parsed = syncRequestSchema.safeParse(body);
		if (!parsed.success) {
			return NextResponse.json({ error: "Invalid request" }, { status: 400 });
		}

		const { knownCommitIds, pushCommits, pushBranches, pushTags } = parsed.data;

		// ── Push: insert new commits from client ──────────────────────────
		let pushedCount = 0;
		if (pushCommits && pushCommits.length > 0) {
			for (const raw of pushCommits) {
				const commit = raw as Record<string, unknown>;
				const inserted = await db
					.insert(commits)
					.values({
						id: commit.id as string,
						repoId,
						parentId: (commit.parentId as string) ?? null,
						mergeParentId: (commit.mergeParentId as string) ?? null,
						hash: (commit.hash as string) || (commit.id as string),
						message: commit.message as string,
						authorId: session.user.id,
						authorName: session.user.name,
						authorAvatar: session.user.image,
						isKeyframe: (commit.isKeyframe as boolean) ?? false,
						snapshotData: commit.snapshotData ?? null,
						deltaData: commit.deltaData ?? null,
						keyframeAncestorId: (commit.keyframeAncestorId as string) ?? null,
						thumbnailUrl: (commit.thumbnailUrl as string) ?? null,
						duration: (commit.duration as number) ?? 0,
						trackCount: (commit.trackCount as number) ?? 0,
						elementCount: (commit.elementCount as number) ?? 0,
						changeSummary: commit.changeSummary ?? null,
						isAutoCommit: (commit.isAutoCommit as boolean) ?? false,
						mergeSourceBranch: (commit.mergeSourceBranch as string) ?? null,
						createdAt: new Date(),
					})
					.onConflictDoNothing()
					.returning({ id: commits.id });
				// Count only rows actually written — a commit the server already has
				// is skipped by onConflictDoNothing and must not inflate the count.
				pushedCount += inserted.length;
			}
		}

		// Push branches
		if (pushBranches && pushBranches.length > 0) {
			for (const raw of pushBranches) {
				const branch = raw as Record<string, unknown>;
				await db
					.insert(branches)
					.values({
						id: branch.id as string,
						repoId,
						name: branch.name as string,
						headCommitId: branch.headCommitId as string,
						description: (branch.description as string) ?? null,
						color: (branch.color as string) ?? null,
						createdFromBranch: (branch.createdFromBranch as string) ?? null,
						createdFromCommitId: (branch.createdFromCommitId as string) ?? null,
						isProtected: false,
						createdAt: new Date(),
					})
					.onConflictDoNothing();
			}
		}

		// Push tags
		if (pushTags && pushTags.length > 0) {
			for (const raw of pushTags) {
				const tag = raw as Record<string, unknown>;
				await db
					.insert(tags)
					.values({
						id: tag.id as string,
						repoId,
						commitId: tag.commitId as string,
						name: tag.name as string,
						type: (tag.type as string) ?? "custom",
						note: (tag.note as string) ?? null,
						createdBy: session.user.id,
						createdAt: new Date(),
					})
					.onConflictDoNothing();
			}
		}

		// ── Pull: find commits server has that client doesn't ─────────────
		let pullCommits: (typeof commits.$inferSelect)[] = [];
		if (knownCommitIds.length > 0) {
			pullCommits = await db
				.select()
				.from(commits)
				.where(eq(commits.repoId, repoId));
			// Filter out known commits in JS to avoid SQL size limits
			const knownSet = new Set(knownCommitIds);
			pullCommits = pullCommits.filter((c) => !knownSet.has(c.id));
		} else {
			pullCommits = await db
				.select()
				.from(commits)
				.where(eq(commits.repoId, repoId));
		}

		const pullBranches = await db
			.select()
			.from(branches)
			.where(eq(branches.repoId, repoId));

		const pullTags = await db
			.select()
			.from(tags)
			.where(eq(tags.repoId, repoId));

		return NextResponse.json({
			pushed: pushedCount,
			pull: {
				commits: pullCommits,
				branches: pullBranches,
				tags: pullTags,
			},
		});
	} catch (error) {
		console.error("Error syncing:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}

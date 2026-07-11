import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { commits } from "@/lib/db/schema-version-control";
import { auth } from "@/lib/auth/server";
import { headers } from "next/headers";
import { eq, desc } from "drizzle-orm";
import {
	checkRepoAccess,
	checkRepoWriteAccess,
} from "@/lib/db/version-control-utils";
import { enforceRateLimit } from "@/lib/rate-limit";

/** Max commits per push — matches the GET list clamp. */
const MAX_BATCH_COMMITS = 200;
/**
 * Max serialized size of a single commit payload. snapshotData carries a full
 * timeline snapshot, which is legitimately large but must not be unbounded —
 * 2 MB fits real project snapshots with ample headroom.
 */
const MAX_COMMIT_PAYLOAD_BYTES = 2 * 1024 * 1024;
/** Max total request body (batch of snapshots), pre-checked via content-length. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

const createCommitSchema = z.object({
	id: z.string(),
	parentId: z.string().nullable(),
	mergeParentId: z.string().nullable().optional(),
	hash: z.string(),
	message: z.string(),
	isKeyframe: z.boolean(),
	snapshotData: z.unknown().nullable(),
	deltaData: z.unknown().nullable(),
	keyframeAncestorId: z.string().nullable().optional(),
	thumbnailUrl: z.string().nullable().optional(),
	duration: z.number(),
	trackCount: z.number(),
	elementCount: z.number(),
	changeSummary: z.unknown(),
	isAutoCommit: z.boolean().optional(),
	mergeSourceBranch: z.string().nullable().optional(),
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

		// Throttle pushes per account before any body parsing or repo lookups.
		const limited = await enforceRateLimit({
			name: "vc:commits",
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
					message: `Commit pushes are capped at ${MAX_BODY_BYTES / (1024 * 1024)} MB per request.`,
					maxBytes: MAX_BODY_BYTES,
				},
				{ status: 413 },
			);
		}

		const { repoId } = await params;
		// WRITE gate: pushing commits requires owner or repo write permission. The
		// payload isn't branch-scoped, so we gate at the repo level (not per-branch
		// push). checkRepoAccess is read-only and would let any signed-in user
		// write to a public repo they don't own.
		if (!(await checkRepoWriteAccess(repoId, session.user.id))) {
			const visible = await checkRepoAccess(repoId, session.user.id);
			return NextResponse.json(
				{ error: visible ? "Forbidden" : "Not found" },
				{ status: visible ? 403 : 404 },
			);
		}

		const body = await request.json();

		// Support batch push (array of commits)
		const commitList = Array.isArray(body) ? body : [body];

		if (commitList.length > MAX_BATCH_COMMITS) {
			return NextResponse.json(
				{
					error: "Too many commits in one push",
					message: `Push at most ${MAX_BATCH_COMMITS} commits per request and batch the rest.`,
					maxCommits: MAX_BATCH_COMMITS,
				},
				{ status: 400 },
			);
		}

		// Validate + size-check the whole batch BEFORE writing anything.
		const rows: (typeof commits.$inferInsert)[] = [];
		for (const raw of commitList) {
			const parsed = createCommitSchema.safeParse(raw);
			if (!parsed.success) {
				return NextResponse.json(
					{ error: "Invalid commit data", details: parsed.error.flatten() },
					{ status: 400 },
				);
			}

			// snapshotData/deltaData are unbounded JSON — bound each commit's
			// serialized size so one payload can't blow up memory or the table.
			if (JSON.stringify(parsed.data).length > MAX_COMMIT_PAYLOAD_BYTES) {
				return NextResponse.json(
					{
						error: "Commit payload too large",
						message: `Each commit (snapshot included) is capped at ${MAX_COMMIT_PAYLOAD_BYTES / (1024 * 1024)} MB.`,
						maxBytes: MAX_COMMIT_PAYLOAD_BYTES,
					},
					{ status: 413 },
				);
			}

			rows.push({
				...parsed.data,
				repoId,
				authorId: session.user.id,
				authorName: session.user.name,
				authorAvatar: session.user.image,
				createdAt: new Date(),
			});
		}

		// Single multi-row insert inside a transaction — the batch lands
		// atomically instead of one round-trip per commit (a timeout mid-loop
		// used to leave a partial push behind).
		if (rows.length > 0) {
			await db.transaction(async (tx) => {
				await tx.insert(commits).values(rows).onConflictDoNothing();
			});
		}

		return NextResponse.json({ pushed: commitList.length }, { status: 201 });
	} catch (error) {
		console.error("Error pushing commits:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}

export async function GET(
	request: NextRequest,
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

		const { searchParams } = new URL(request.url);
		const limitParam = parseInt(searchParams.get("limit") || "50", 10);
		const offsetParam = parseInt(searchParams.get("offset") || "0", 10);
		const limit = Math.min(
			Number.isNaN(limitParam) ? 50 : Math.max(limitParam, 1),
			200,
		);
		const offset = Number.isNaN(offsetParam) ? 0 : Math.max(offsetParam, 0);

		const result = await db
			.select()
			.from(commits)
			.where(eq(commits.repoId, repoId))
			.orderBy(desc(commits.createdAt))
			.limit(limit)
			.offset(offset);

		return NextResponse.json(result);
	} catch (error) {
		console.error("Error listing commits:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}

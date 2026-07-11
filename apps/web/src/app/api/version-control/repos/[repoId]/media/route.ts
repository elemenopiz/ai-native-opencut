import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import {
	commitMediaRefs,
	commits,
	mediaObjects,
} from "@/lib/db/schema-version-control";
import { auth } from "@/lib/auth/server";
import { headers } from "next/headers";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
	checkRepoAccess,
	checkRepoWriteAccess,
} from "@/lib/db/version-control-utils";

const MAX_REFS_PER_REQUEST = 200;

const registerRefsSchema = z.object({
	commitId: z.string().min(1),
	refs: z
		.array(
			z.object({
				mediaId: z.string().min(1),
				mediaHash: z.string().min(1),
				name: z.string().max(512).optional(),
			}),
		)
		.max(MAX_REFS_PER_REQUEST),
});

/**
 * GET /api/version-control/repos/[repoId]/media
 * The repo's media manifest: every asset referenced by any commit, newest ref
 * per mediaId, joined to its content-addressable object. A shared-project
 * clone downloads these to rebuild the local media library.
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
		if (!(await checkRepoAccess(repoId, session.user.id))) {
			return NextResponse.json({ error: "Not found" }, { status: 404 });
		}

		const rows = await db
			.select({
				mediaId: commitMediaRefs.mediaId,
				name: commitMediaRefs.name,
				hash: mediaObjects.hash,
				size: mediaObjects.size,
				mimeType: mediaObjects.mimeType,
				width: mediaObjects.width,
				height: mediaObjects.height,
				duration: mediaObjects.duration,
				commitCreatedAt: commits.createdAt,
			})
			.from(commitMediaRefs)
			.innerJoin(commits, eq(commitMediaRefs.commitId, commits.id))
			.innerJoin(mediaObjects, eq(commitMediaRefs.mediaHash, mediaObjects.hash))
			.where(eq(commits.repoId, repoId))
			.orderBy(desc(commits.createdAt));

		// Newest ref wins per mediaId (rows are commit-newest-first).
		const byMediaId = new Map<string, (typeof rows)[number]>();
		for (const row of rows) {
			if (!byMediaId.has(row.mediaId)) byMediaId.set(row.mediaId, row);
		}

		return NextResponse.json({
			media: Array.from(byMediaId.values()).map((row) => ({
				mediaId: row.mediaId,
				name: row.name,
				hash: row.hash,
				size: row.size,
				mimeType: row.mimeType,
				width: row.width,
				height: row.height,
				duration: row.duration,
			})),
		});
	} catch (error) {
		console.error("Error listing repo media:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}

/**
 * POST /api/version-control/repos/[repoId]/media
 * Register commit↔media references after uploading blobs to
 * /api/version-control/media. Requires write access; the commit must belong
 * to this repo and every hash must already exist as a media object.
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

		const { repoId } = await params;
		if (!(await checkRepoWriteAccess(repoId, session.user.id))) {
			const visible = await checkRepoAccess(repoId, session.user.id);
			return NextResponse.json(
				{ error: visible ? "Forbidden" : "Not found" },
				{ status: visible ? 403 : 404 },
			);
		}

		const body = await request.json();
		const parsed = registerRefsSchema.safeParse(body);
		if (!parsed.success) {
			return NextResponse.json({ error: "Invalid request" }, { status: 400 });
		}
		const { commitId, refs } = parsed.data;
		if (refs.length === 0) {
			return NextResponse.json({ registered: 0 });
		}

		// The anchor commit must belong to THIS repo — otherwise a writer on one
		// repo could attach refs to another repo's history.
		const [commit] = await db
			.select({ id: commits.id })
			.from(commits)
			.where(and(eq(commits.id, commitId), eq(commits.repoId, repoId)))
			.limit(1);
		if (!commit) {
			return NextResponse.json({ error: "Commit not found" }, { status: 404 });
		}

		// Every referenced hash must already be uploaded.
		const hashes = [...new Set(refs.map((r) => r.mediaHash))];
		const known = await db
			.select({ hash: mediaObjects.hash })
			.from(mediaObjects)
			.where(inArray(mediaObjects.hash, hashes));
		const knownSet = new Set(known.map((k) => k.hash));
		const missing = hashes.filter((h) => !knownSet.has(h));
		if (missing.length > 0) {
			return NextResponse.json(
				{ error: "Unknown media hashes", missing },
				{ status: 400 },
			);
		}

		// Skip refs this commit already has (repeat syncs are idempotent).
		const existing = await db
			.select({ mediaId: commitMediaRefs.mediaId })
			.from(commitMediaRefs)
			.where(eq(commitMediaRefs.commitId, commitId));
		const existingIds = new Set(existing.map((e) => e.mediaId));
		const toInsert = refs.filter((r) => !existingIds.has(r.mediaId));

		if (toInsert.length > 0) {
			await db.insert(commitMediaRefs).values(
				toInsert.map((ref) => ({
					commitId,
					mediaHash: ref.mediaHash,
					mediaId: ref.mediaId,
					name: ref.name ?? null,
				})),
			);
		}

		return NextResponse.json({ registered: toInsert.length });
	} catch (error) {
		console.error("Error registering media refs:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}

import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
	commitMediaRefs,
	commits,
	mediaObjects,
} from "@/lib/db/schema-version-control";
import { auth } from "@/lib/auth/server";
import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { checkRepoAccess } from "@/lib/db/version-control-utils";

/**
 * GET /api/version-control/media/[hash]
 * Content-addressed blob fetch: hashes are global, so the same object can be
 * referenced by many repos across many owners (dedup). Access is granted if
 * EITHER the caller uploaded the object (covers the upload → register-refs
 * window before any commit references it yet) OR the caller has read access
 * (checkRepoAccess — owner, project member, branch permission, or public) to
 * AT LEAST ONE repo that references this hash via a commit. Access to any one
 * referencing repo suffices: the caller could fetch the same bytes through
 * that repo's media manifest anyway. We use checkRepoAccess (not
 * getRepoRole) so public-repo non-members — who the sibling manifest route
 * already grants read access — can still resolve the blob. Denial is 403,
 * not 404: the hash itself functions as a bearer-style capability once
 * shared, so there is nothing left to hide by pretending it doesn't exist.
 * See queue row BUG24.
 */
export async function GET(
	_request: NextRequest,
	{ params }: { params: Promise<{ hash: string }> },
) {
	try {
		const session = await auth.api.getSession({ headers: await headers() });
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const { hash } = await params;

		const result = await db
			.select()
			.from(mediaObjects)
			.where(eq(mediaObjects.hash, hash))
			.limit(1);

		if (result.length === 0) {
			return NextResponse.json({ error: "Media not found" }, { status: 404 });
		}

		const object = result[0];
		let allowed = object.uploadedBy === session.user.id;

		if (!allowed) {
			const referencingRepos = await db
				.selectDistinct({ repoId: commits.repoId })
				.from(commitMediaRefs)
				.innerJoin(commits, eq(commitMediaRefs.commitId, commits.id))
				.where(eq(commitMediaRefs.mediaHash, hash));

			for (const { repoId } of referencingRepos) {
				if (await checkRepoAccess(repoId, session.user.id)) {
					allowed = true;
					break;
				}
			}
		}

		if (!allowed) {
			return NextResponse.json({ error: "Forbidden" }, { status: 403 });
		}

		// Redirect to the R2 storage URL
		return NextResponse.redirect(object.storageUrl);
	} catch (error) {
		console.error("Error getting media:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}

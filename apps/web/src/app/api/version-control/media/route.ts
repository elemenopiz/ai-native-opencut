import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { mediaObjects } from "@/lib/db/schema-version-control";
import { auth } from "@/lib/auth/server";
import { headers } from "next/headers";
import {
	computeHash,
	uploadMedia,
} from "@/services/storage/cloud-media-storage";
import { eq } from "drizzle-orm";
import { enforceRateLimit } from "@/lib/rate-limit";

/**
 * Uploads are buffered fully in memory before hashing/R2 — cap the file size so
 * one request can't balloon the process (same posture as the sounds proxy).
 * 200 MB comfortably fits project video media while bounding memory.
 */
const MAX_MEDIA_BYTES = 200 * 1024 * 1024;
/** Slack for multipart boundary/header overhead in the content-length pre-check. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

function tooLarge() {
	return NextResponse.json(
		{
			error: "File too large",
			message: `Media uploads are capped at ${MAX_MEDIA_BYTES / (1024 * 1024)} MB.`,
			maxBytes: MAX_MEDIA_BYTES,
		},
		{ status: 413 },
	);
}

/**
 * POST /api/version-control/media/upload
 * Upload a media file with content-addressable hashing.
 */
export async function POST(request: NextRequest) {
	try {
		const session = await auth.api.getSession({ headers: await headers() });
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		// Bound how often one account can push a full in-memory buffer to R2.
		const limited = await enforceRateLimit({
			name: "vc:media",
			request,
			userId: session.user.id,
		});
		if (limited) return limited;

		// Cheap reject before the multipart body is parsed/buffered at all.
		const contentLength = Number(request.headers.get("content-length"));
		if (
			Number.isFinite(contentLength) &&
			contentLength > MAX_MEDIA_BYTES + MULTIPART_OVERHEAD_BYTES
		) {
			return tooLarge();
		}

		const formData = await request.formData();
		const file = formData.get("file") as File | null;
		if (!file) {
			return NextResponse.json({ error: "No file provided" }, { status: 400 });
		}

		// Enforce on the ACTUAL size too — content-length can be absent or wrong.
		if (file.size > MAX_MEDIA_BYTES) {
			return tooLarge();
		}

		const buffer = await file.arrayBuffer();
		if (buffer.byteLength > MAX_MEDIA_BYTES) {
			return tooLarge();
		}
		const hash = await computeHash(buffer);

		// Check if already in DB (dedup)
		const existing = await db
			.select()
			.from(mediaObjects)
			.where(eq(mediaObjects.hash, hash))
			.limit(1);

		if (existing.length > 0) {
			return NextResponse.json({
				hash,
				storageUrl: existing[0].storageUrl,
				deduplicated: true,
			});
		}

		// Upload to R2
		const storageUrl = await uploadMedia(buffer, hash, file.type);

		// Record in DB
		await db.insert(mediaObjects).values({
			hash,
			size: file.size,
			mimeType: file.type,
			storageUrl,
			uploadedBy: session.user.id,
			uploadedAt: new Date(),
		});

		return NextResponse.json(
			{ hash, storageUrl, deduplicated: false },
			{ status: 201 },
		);
	} catch (error) {
		console.error("Error uploading media:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}

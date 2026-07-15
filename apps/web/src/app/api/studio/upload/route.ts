import { NextResponse } from "next/server";
import { headers } from "next/headers";
import {
	canRehost,
	rehostToR2,
	MAX_REFERENCE_IMAGE_BYTES,
	MAX_REFERENCE_VIDEO_BYTES,
} from "@/lib/studio/media-storage";
import { auth } from "@/lib/auth/server";
import { enforceRateLimit } from "@/lib/rate-limit";

/**
 * Legacy buffered upload for reference media (Seedance omni-reference).
 * Accepts a single file (image or video) as multipart/form-data under the
 * `file` field, buffers the whole body in this route, persists it to R2, and
 * returns a publicly-fetchable URL that BytePlus can pull from.
 *
 * The platform (Vercel) caps a serverless function's request body at ~4.5 MB
 * — well under a real phone video — so this route only ever sees videos small
 * enough to have squeaked under that cap; anything bigger is rejected by the
 * platform itself with a plain-text 413 before this handler runs. `/api/
 * studio/upload-url` (presigned direct-to-R2 PUT, bypassing this cap entirely)
 * is the primary path now; this route is the fallback for when cloud storage
 * isn't configured (local dev), where it still serves its original purpose —
 * small images as inline base64 data URLs.
 */

// Keep inline data-URL fallback to small images only.
const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB

export const maxDuration = 60;

/** Slack for multipart boundary/header overhead in the content-length pre-check. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

function tooLarge(kind: "image" | "video", maxBytes: number) {
	return NextResponse.json(
		{
			error: "File too large",
			message: `Reference ${kind}s are capped at ${maxBytes / (1024 * 1024)} MB.`,
			maxBytes,
		},
		{ status: 413 },
	);
}

export async function POST(req: Request) {
	try {
		// Rehosting media to R2 is an open write path to our object storage —
		// require a signed-in user so it can't be driven anonymously.
		const session = await auth.api.getSession({ headers: await headers() });
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		// Throttle uploads per account (bounds R2 cost/abuse, not a paid model call).
		const limited = await enforceRateLimit({
			name: "studio:upload",
			request: req,
			userId: session.user.id,
		});
		if (limited) return limited;

		// Cheap reject before the multipart body is parsed/buffered at all. The
		// kind isn't known yet, so this pre-check uses the larger (video) cap;
		// the exact per-kind cap is enforced on the parsed file below.
		const contentLength = Number(req.headers.get("content-length"));
		if (
			Number.isFinite(contentLength) &&
			contentLength > MAX_REFERENCE_VIDEO_BYTES + MULTIPART_OVERHEAD_BYTES
		) {
			return tooLarge("video", MAX_REFERENCE_VIDEO_BYTES);
		}

		const form = await req.formData();
		const file = form.get("file");

		if (!(file instanceof File)) {
			return NextResponse.json(
				{ error: "Expected a `file` field" },
				{ status: 400 },
			);
		}

		const mime = file.type || "application/octet-stream";
		const kind = mime.startsWith("video/")
			? "video"
			: mime.startsWith("image/")
				? "image"
				: null;

		if (!kind) {
			return NextResponse.json(
				{ error: "Only image and video files are supported" },
				{ status: 400 },
			);
		}

		// Enforce the per-kind cap on the ACTUAL size (content-length can be
		// absent or wrong): check the File's reported size before buffering,
		// then the buffer itself.
		const maxBytes =
			kind === "video" ? MAX_REFERENCE_VIDEO_BYTES : MAX_REFERENCE_IMAGE_BYTES;
		if (file.size > maxBytes) {
			return tooLarge(kind, maxBytes);
		}

		const bytes = await file.arrayBuffer();
		if (bytes.byteLength > maxBytes) {
			return tooLarge(kind, maxBytes);
		}

		if (canRehost()) {
			const url = await rehostToR2(bytes, mime);
			return NextResponse.json({ url, kind, mimeType: mime });
		}

		// No cloud storage — inline small images as data URLs so generation still
		// works in local dev. Videos can't be inlined; surface a clear message.
		if (kind === "image" && bytes.byteLength <= MAX_INLINE_IMAGE_BYTES) {
			const base64 = Buffer.from(bytes).toString("base64");
			return NextResponse.json({
				url: `data:${mime};base64,${base64}`,
				kind,
				mimeType: mime,
			});
		}

		return NextResponse.json(
			{
				error:
					kind === "video"
						? "Reference videos need cloud storage. Configure R2 (R2_* env vars) to upload videos."
						: "Image too large to inline. Configure R2 storage to upload it.",
			},
			{ status: 400 },
		);
	} catch (err) {
		const message = err instanceof Error ? err.message : "Upload failed";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}

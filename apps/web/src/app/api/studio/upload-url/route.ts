import { NextResponse } from "next/server";
import { headers } from "next/headers";
import {
	canRehost,
	presignDirectUpload,
	MAX_REFERENCE_IMAGE_BYTES,
	MAX_REFERENCE_VIDEO_BYTES,
} from "@/lib/studio/media-storage";
import { auth } from "@/lib/auth/server";
import { enforceRateLimit } from "@/lib/rate-limit";

/**
 * Mint a presigned R2 PUT URL for a reference upload (Seedance omni-reference
 * image/video). The browser uploads bytes straight to R2 with the returned
 * `uploadUrl` — never through this route — so a real phone video isn't bound
 * by the platform's serverless function body-size cap (~4.5 MB on Vercel),
 * which the old buffered `/api/studio/upload` route silently hit: the
 * platform rejected the oversized request with a plain-text 413 before our
 * handler ever ran, and the client's `res.json()` threw a confusing
 * "Unexpected token" parse error instead of a real "file too large" message.
 *
 * Falls back to `{ available: false }` (not an error) when cloud storage
 * isn't configured — callers use the legacy buffered route instead, same as
 * local dev without R2 credentials always has.
 */
export async function POST(req: Request) {
	try {
		const session = await auth.api.getSession({ headers: await headers() });
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		// Shares the same quota as the legacy buffered route — this is a second
		// entry point onto the same feature, not a second budget.
		const limited = await enforceRateLimit({
			name: "studio:upload",
			request: req,
			userId: session.user.id,
		});
		if (limited) return limited;

		const body = (await req.json().catch(() => null)) as {
			mimeType?: string;
			sizeBytes?: number;
		} | null;
		const mimeType = body?.mimeType;
		const sizeBytes = body?.sizeBytes;
		if (typeof mimeType !== "string" || typeof sizeBytes !== "number") {
			return NextResponse.json(
				{ error: "Expected { mimeType, sizeBytes }" },
				{ status: 400 },
			);
		}

		const kind = mimeType.startsWith("video/")
			? "video"
			: mimeType.startsWith("image/")
				? "image"
				: null;
		if (!kind) {
			return NextResponse.json(
				{ error: "Only image and video files are supported" },
				{ status: 400 },
			);
		}

		const maxBytes =
			kind === "video" ? MAX_REFERENCE_VIDEO_BYTES : MAX_REFERENCE_IMAGE_BYTES;
		if (sizeBytes > maxBytes) {
			return NextResponse.json(
				{
					error: "File too large",
					message: `Reference ${kind}s are capped at ${maxBytes / (1024 * 1024)} MB.`,
					maxBytes,
				},
				{ status: 413 },
			);
		}

		if (!canRehost()) {
			// Not an error — the caller falls back to the buffered upload route
			// (which still supports small images via its base64 dev fallback).
			return NextResponse.json({ available: false });
		}

		const { uploadUrl, publicUrl } = await presignDirectUpload(session.user.id);
		return NextResponse.json({ available: true, uploadUrl, publicUrl, kind });
	} catch (err) {
		const message =
			err instanceof Error ? err.message : "Failed to presign upload";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}

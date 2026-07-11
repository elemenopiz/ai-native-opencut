import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { canRehost, rehostToR2 } from "@/lib/studio/media-storage";
import { auth } from "@/lib/auth/server";
import { enforceRateLimit } from "@/lib/rate-limit";

/**
 * Upload reference media for Seedance omni-reference. Accepts a single file
 * (image or video) as multipart/form-data under the `file` field, persists it
 * to R2, and returns a publicly-fetchable URL that BytePlus can pull from.
 *
 * Dev fallback: with no cloud storage configured, small images are returned as
 * base64 data URLs (ModelArk accepts inline base64 in `image_url.url`). Videos
 * require R2 — base64 data URLs are too large to be fetched reliably.
 */

// Keep inline data-URL fallback to small images only.
const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB

export const maxDuration = 60;

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

		const bytes = await file.arrayBuffer();

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

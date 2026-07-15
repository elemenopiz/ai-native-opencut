import type { EditorCore } from "@/core";
import { getDragData } from "@/lib/drag-data";
import { fetchWithTimeout, MEDIA_TIMEOUT_MS } from "@/lib/studio/fetch-timeout";
import { normalizeReferenceVideoFps } from "@/lib/studio/normalize-reference-video";

/**
 * Shared helpers for attaching reference media in the Generate panel. A
 * reference must be a publicly-fetchable URL (BytePlus pulls it server-side),
 * so every attachment — whether a dropped file or a clip dragged from the
 * Assets panel — is rehosted to R2 first.
 *
 * Two upload paths:
 *   1. Presigned direct-to-R2 PUT (`/api/studio/upload-url` mints the URL,
 *      the browser PUTs bytes straight to R2). The file body never transits
 *      our own server, so it isn't bound by the platform's serverless
 *      function body-size cap (~4.5 MB on Vercel) — a real phone video
 *      routinely blows past that, and hitting it used to surface as a raw
 *      JSON-parse crash ("Unexpected token 'R', "Request En"...") instead of
 *      a real "file too large" message, because the platform's plain-text
 *      413 broke a blind `res.json()` call.
 *   2. Legacy buffered upload through `/api/studio/upload` — the fallback
 *      when cloud storage isn't configured (local dev), which still serves
 *      its original purpose of inlining small images as base64 data URLs.
 */

export interface UploadedReference {
	url: string;
	kind: "image" | "video";
}

/** Parse a response body as JSON without letting a non-JSON body (an
 *  infra-level error page, a platform size-limit rejection, …) throw a raw
 *  `SyntaxError` at the caller — surface a clear message instead. */
async function parseJsonResponse<T>(res: Response): Promise<T> {
	const text = await res.text();
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new Error(
			res.ok
				? "Server returned an unexpected response."
				: `Upload failed (${res.status})`,
		);
	}
}

interface PresignedUpload {
	uploadUrl: string;
	publicUrl: string;
	kind: "image" | "video";
}

/** Ask for a presigned direct-upload URL. Returns null when cloud storage
 *  isn't configured (not an error — the caller falls back to the buffered
 *  route), and throws on a real failure (auth, rate limit, oversized file). */
async function requestPresignedUpload(
	file: File,
): Promise<PresignedUpload | null> {
	const res = await fetchWithTimeout("/api/studio/upload-url", {
		timeoutMs: MEDIA_TIMEOUT_MS,
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ mimeType: file.type, sizeBytes: file.size }),
	});
	const data = await parseJsonResponse<
		| {
				available: true;
				uploadUrl: string;
				publicUrl: string;
				kind: "image" | "video";
		  }
		| { available: false }
		| { error?: string; message?: string }
	>(res);
	if (!res.ok) {
		const message = "message" in data ? data.message : undefined;
		const error = "error" in data ? data.error : undefined;
		throw new Error(message ?? error ?? "Upload failed");
	}
	return "available" in data && data.available ? data : null;
}

/** PUT bytes straight to R2 with a presigned URL — bypasses our server
 *  entirely, so a failure response here is R2's own (XML), never JSON; don't
 *  attempt to parse it. */
async function putToPresignedUrl(
	file: File,
	presign: PresignedUpload,
): Promise<UploadedReference> {
	const res = await fetchWithTimeout(presign.uploadUrl, {
		timeoutMs: MEDIA_TIMEOUT_MS,
		method: "PUT",
		headers: { "Content-Type": file.type || "application/octet-stream" },
		body: file,
	});
	if (!res.ok) {
		throw new Error(`Upload to storage failed (${res.status})`);
	}
	return { url: presign.publicUrl, kind: presign.kind };
}

/** Legacy path: buffer the whole file through our own server. Only reached
 *  when cloud storage isn't configured (local dev) — see the module docstring. */
async function uploadViaServer(file: File): Promise<UploadedReference> {
	const body = new FormData();
	body.append("file", file);
	// Whole-file upload to R2 — media budget.
	const res = await fetchWithTimeout("/api/studio/upload", {
		timeoutMs: MEDIA_TIMEOUT_MS,
		method: "POST",
		body,
	});
	const data = await parseJsonResponse<{
		url?: string;
		kind?: "image" | "video";
		error?: string;
		message?: string;
	}>(res);
	if (!res.ok || !data.url) {
		throw new Error(data.message ?? data.error ?? "Upload failed");
	}
	return {
		url: data.url,
		kind: data.kind ?? (file.type.startsWith("video/") ? "video" : "image"),
	};
}

/** Upload one file and return its rehosted URL + detected kind. */
export async function uploadReferenceFile(
	file: File,
): Promise<UploadedReference> {
	// BytePlus rejects reference videos over 60fps, and a phone clip labelled
	// "60fps" often measures ~60.04fps (variable-frame-rate). Normalize before
	// rehosting so the file the provider pulls is a clean ≤60fps video. No-op
	// for images and for videos already at or under 60fps.
	const prepared = await normalizeReferenceVideoFps(file);
	const presign = await requestPresignedUpload(prepared);
	if (presign) {
		try {
			return await putToPresignedUrl(prepared, presign);
		} catch {
			// The direct PUT can fail for reasons outside the app's control at
			// the browser layer (most commonly the R2 bucket's CORS policy not
			// yet covering this origin) — fall back to the buffered route
			// rather than hard-failing an upload we know how to complete
			// another way. Still strictly better than before even when this
			// fallback also fails: `uploadViaServer` never throws a raw
			// JSON-parse error, only a real "file too large" / status message.
		}
	}
	return uploadViaServer(prepared);
}

/**
 * If a drag came from the Assets panel, resolve the dragged clip's File so it
 * can be uploaded. Returns null for non-asset drags (e.g. OS file drops, which
 * the caller handles via `dataTransfer.files`).
 */
export function assetFileFromDrag(
	editor: EditorCore,
	dataTransfer: DataTransfer,
): { file: File; kind: "image" | "video" } | null {
	const drag = getDragData({ dataTransfer });
	if (!drag || drag.type !== "media") return null;
	if (drag.mediaType === "audio") return null;
	const asset = editor.media.getAssets().find((a) => a.id === drag.id);
	if (!asset?.file) return null;
	return {
		file: asset.file,
		kind: drag.mediaType === "video" ? "video" : "image",
	};
}

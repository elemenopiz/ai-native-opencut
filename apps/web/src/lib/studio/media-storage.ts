/**
 * Rehost Studio media (Seedance videos, GPT Image stills) into our own R2 so
 * we don't depend on provider URLs that expire (~24h for Seedance) and so a
 * generated still has a stable, publicly-fetchable URL for image-to-video.
 *
 * URL strategy:
 *   - If R2_PUBLIC_BASE_URL is set (custom domain / r2.dev), return a permanent
 *     public URL — the production path.
 *   - Otherwise fall back to a presigned URL (max 7 days). Fine for dev; set a
 *     public base for production so URLs don't rot.
 */

import { webEnv } from "@byorn/env/web";
import { fetchWithTimeout, MEDIA_TIMEOUT_MS } from "@/lib/studio/fetch-timeout";
import {
	computeHash,
	uploadMedia,
	presignGetUrl,
	presignGetUrlForKey,
	presignPutUrl,
	isCloudStorageConfigured,
} from "@/services/storage/cloud-media-storage";

const PRESIGN_TTL_SECONDS = 60 * 60 * 24 * 7; // SigV4 maximum

// Shared reference-media size caps — the whole file is buffered in memory
// before rehosting on the legacy (no-R2) upload path, so cap by kind so one
// request can't balloon the process. Reference stills don't need more than
// 20 MB; reference videos are short clips, 100 MB matches the sounds proxy.
// Used by both /api/studio/upload (legacy buffered) and /api/studio/upload-url
// (presigned direct-to-R2) so the two paths can't drift apart.
export const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB
export const MAX_REFERENCE_VIDEO_BYTES = 100 * 1024 * 1024; // 100 MB

export function canRehost(): boolean {
	return isCloudStorageConfigured();
}

function publicBase(): string {
	return webEnv.R2_PUBLIC_BASE_URL.replace(/\/+$/, "");
}

/** Persist bytes into R2 and return a fetchable URL (public or presigned). */
export async function rehostToR2(
	data: ArrayBuffer,
	mimeType: string,
): Promise<string> {
	const hash = await computeHash(data);
	await uploadMedia(data, hash, mimeType);
	if (webEnv.R2_PUBLIC_BASE_URL) {
		return `${publicBase()}/media/${hash}`;
	}
	return presignGetUrl(hash, PRESIGN_TTL_SECONDS);
}

// Short window to start the PUT after requesting a presigned upload URL — the
// client uses it within the same page load, no reason to leave it valid longer.
const UPLOAD_PRESIGN_TTL_SECONDS = 60 * 10; // 10 minutes

export interface DirectUploadTarget {
	/** Presigned PUT URL — the browser uploads bytes straight here. */
	uploadUrl: string;
	/** Where the object will be fetchable from once the PUT completes. */
	publicUrl: string;
}

/**
 * Mint a presigned PUT URL for a NEW, not-yet-uploaded reference file, plus
 * the fetchable GET URL it'll live at once uploaded. The browser PUTs bytes
 * straight to R2 with `uploadUrl` — the body never transits our own server,
 * so it isn't bound by the platform's serverless function body-size cap
 * (~4.5 MB on Vercel), which real phone videos routinely exceed.
 *
 * Reference uploads aren't content-addressed like `rehostToR2` (we don't have
 * the bytes yet to hash before minting the URL), so the key is a random id
 * namespaced under the uploading user.
 */
export async function presignDirectUpload(
	ownerId: string,
): Promise<DirectUploadTarget> {
	const key = `refs/${ownerId}/${crypto.randomUUID()}`;
	const uploadUrl = await presignPutUrl(key, UPLOAD_PRESIGN_TTL_SECONDS);
	const publicUrl = webEnv.R2_PUBLIC_BASE_URL
		? `${publicBase()}/${key}`
		: await presignGetUrlForKey(key, PRESIGN_TTL_SECONDS);
	return { uploadUrl, publicUrl };
}

/** True if a URL is already one of ours — so we don't re-download/re-upload. */
export function isRehostedUrl(url: string | null | undefined): boolean {
	if (!url) return false;
	if (webEnv.R2_PUBLIC_BASE_URL && url.startsWith(publicBase())) return true;
	return (
		url.includes("r2.cloudflarestorage.com") || url.includes("X-Amz-Signature")
	);
}

/** Generated clips are short (≤ ~12s); 200MB comfortably bounds even 1080p
 *  output while keeping a hostile/buggy provider URL from ballooning memory
 *  on the hot poll route. */
const MAX_FETCH_BYTES = 200 * 1024 * 1024;

/**
 * Decode a data: URL or fetch a remote URL into raw bytes.
 *
 * Remote fetches are bounded in both time and size (this runs inside request
 * handlers — the poll route rehosts finished videos through it). Same pattern
 * as the sounds proxy: reject on content-length, then enforce the cap again
 * while reading (the header can be missing or wrong). Failures throw; callers
 * that rehost best-effort keep their provider-URL fallback.
 */
export async function fetchBytes(
	url: string,
	opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<ArrayBuffer> {
	if (url.startsWith("data:")) {
		const b64 = url.slice(url.indexOf(",") + 1);
		const buf = Buffer.from(b64, "base64");
		return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
	}
	const maxBytes = opts.maxBytes ?? MAX_FETCH_BYTES;
	const res = await fetchWithTimeout(url, {
		timeoutMs: opts.timeoutMs ?? MEDIA_TIMEOUT_MS,
	});
	if (!res.ok) throw new Error(`fetch bytes failed ${res.status}`);

	const contentLength = Number(res.headers.get("content-length"));
	if (Number.isFinite(contentLength) && contentLength > maxBytes) {
		res.body?.cancel().catch(() => {});
		throw new Error(`fetch bytes exceeded ${maxBytes} byte limit`);
	}
	if (!res.body) return res.arrayBuffer();

	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let received = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		received += value.byteLength;
		if (received > maxBytes) {
			await reader.cancel().catch(() => {});
			throw new Error(`fetch bytes exceeded ${maxBytes} byte limit`);
		}
		chunks.push(value);
	}
	const out = new Uint8Array(received);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out.buffer;
}

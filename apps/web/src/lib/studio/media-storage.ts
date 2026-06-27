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

import { webEnv } from "@opencut-ai/env/web";
import {
	computeHash,
	uploadMedia,
	presignGetUrl,
	isCloudStorageConfigured,
} from "@/services/storage/cloud-media-storage";

const PRESIGN_TTL_SECONDS = 60 * 60 * 24 * 7; // SigV4 maximum

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

/** True if a URL is already one of ours — so we don't re-download/re-upload. */
export function isRehostedUrl(url: string | null | undefined): boolean {
	if (!url) return false;
	if (webEnv.R2_PUBLIC_BASE_URL && url.startsWith(publicBase())) return true;
	return url.includes("r2.cloudflarestorage.com") || url.includes("X-Amz-Signature");
}

/** Decode a data: URL or fetch a remote URL into raw bytes. */
export async function fetchBytes(url: string): Promise<ArrayBuffer> {
	if (url.startsWith("data:")) {
		const b64 = url.slice(url.indexOf(",") + 1);
		const buf = Buffer.from(b64, "base64");
		return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
	}
	const res = await fetch(url);
	if (!res.ok) throw new Error(`fetch bytes failed ${res.status}`);
	return res.arrayBuffer();
}

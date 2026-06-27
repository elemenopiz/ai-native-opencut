import { AwsClient } from "aws4fetch";
import { webEnv } from "@opencut-ai/env/web";

/**
 * Content-addressable cloud media storage using Cloudflare R2 (S3-compatible).
 * Files are stored by their SHA-256 hash for deduplication.
 */

let r2Client: AwsClient | null = null;

function getR2Client(): AwsClient {
	if (!r2Client) {
		r2Client = new AwsClient({
			accessKeyId: webEnv.R2_ACCESS_KEY_ID,
			secretAccessKey: webEnv.R2_SECRET_ACCESS_KEY,
		});
	}
	return r2Client;
}

function getR2Url(key: string): string {
	const bucket = webEnv.R2_BUCKET_NAME || "opencut-media";
	return `https://${webEnv.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com/${bucket}/${key}`;
}

/**
 * Compute SHA-256 hash of a buffer.
 */
export async function computeHash(data: ArrayBuffer): Promise<string> {
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Check if a media object already exists in R2 by hash.
 */
export async function mediaExists(hash: string): Promise<boolean> {
	try {
		const client = getR2Client();
		const url = getR2Url(`media/${hash}`);
		const response = await client.fetch(url, { method: "HEAD" });
		return response.ok;
	} catch {
		return false;
	}
}

/**
 * Upload a media file to R2, keyed by its content hash.
 * Returns the storage URL. Skips upload if hash already exists (dedup).
 */
export async function uploadMedia(
	data: ArrayBuffer,
	hash: string,
	mimeType: string,
): Promise<string> {
	const exists = await mediaExists(hash);
	if (exists) {
		return getR2Url(`media/${hash}`);
	}

	const client = getR2Client();
	const url = getR2Url(`media/${hash}`);

	const response = await client.fetch(url, {
		method: "PUT",
		body: data,
		headers: {
			"Content-Type": mimeType,
		},
	});

	if (!response.ok) {
		throw new Error(`R2 upload failed: ${response.status} ${response.statusText}`);
	}

	return url;
}

/**
 * Get a download URL for a media object by hash.
 */
export function getMediaUrl(hash: string): string {
	return getR2Url(`media/${hash}`);
}

/**
 * Whether R2 credentials are present. Callers should treat cloud storage as
 * optional and degrade gracefully when this is false.
 */
export function isCloudStorageConfigured(): boolean {
	return Boolean(
		webEnv.CLOUDFLARE_ACCOUNT_ID &&
			webEnv.R2_ACCESS_KEY_ID &&
			webEnv.R2_SECRET_ACCESS_KEY,
	);
}

/**
 * Produce a time-limited, publicly fetchable GET URL for a stored object.
 * Used when no public bucket domain is configured. SigV4 caps expiry at 7 days.
 */
export async function presignGetUrl(
	hash: string,
	expiresInSeconds: number,
): Promise<string> {
	const client = getR2Client();
	const url = new URL(getR2Url(`media/${hash}`));
	url.searchParams.set("X-Amz-Expires", String(expiresInSeconds));
	const signed = await client.sign(url.toString(), {
		method: "GET",
		aws: { signQuery: true },
	});
	return signed.url;
}

/**
 * Delete a media object from R2.
 */
export async function deleteMedia(hash: string): Promise<void> {
	const client = getR2Client();
	const url = getR2Url(`media/${hash}`);
	await client.fetch(url, { method: "DELETE" });
}

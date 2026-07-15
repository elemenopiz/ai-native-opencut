import { AwsClient } from "aws4fetch";
import { webEnv } from "@byorn/env/web";

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

function bucketName(): string {
	// Keep this fallback in lockstep with the R2_BUCKET_NAME env default
	// (packages/env/src/web.ts) so the two don't resolve to different buckets.
	return webEnv.R2_BUCKET_NAME || "byorn-media";
}

function getR2Url(key: string): string {
	return `https://${webEnv.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com/${bucketName()}/${key}`;
}

// ── Storage guard (R2 free tier is 10 GB) ──────────────────────────────────
// We refuse new uploads once the bucket reaches R2_MAX_STORAGE_BYTES. Usage is
// computed by listing the bucket and summing object sizes, cached briefly so we
// don't list on every write. Dedup (content-addressing) means identical bytes
// are never stored — or counted — twice.

const USAGE_TTL_MS = 60_000;
let usageCache: { bytes: number; at: number } | null = null;

/** Sum the size of every object in the bucket (paginated), with a short cache. */
export async function getBucketUsageBytes(force = false): Promise<number> {
	if (!force && usageCache && Date.now() - usageCache.at < USAGE_TTL_MS) {
		return usageCache.bytes;
	}

	const client = getR2Client();
	const root = `https://${webEnv.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com/${bucketName()}`;
	let total = 0;
	let token: string | undefined;

	do {
		const url = new URL(root);
		url.searchParams.set("list-type", "2");
		url.searchParams.set("max-keys", "1000");
		if (token) url.searchParams.set("continuation-token", token);

		const res = await client.fetch(url.toString(), { method: "GET" });
		if (!res.ok) {
			// If we can't read usage, don't block uploads — fail open.
			return usageCache?.bytes ?? 0;
		}
		const xml = await res.text();
		for (const m of xml.matchAll(/<Size>(\d+)<\/Size>/g)) {
			total += Number(m[1]);
		}
		const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
		token = truncated
			? xml.match(
					/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/,
				)?.[1]
			: undefined;
	} while (token);

	usageCache = { bytes: total, at: Date.now() };
	return total;
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

	// Guard the R2 free tier: refuse a genuinely new object if it would push the
	// bucket past the configured cap. Dedup hits above never reach here.
	const cap = webEnv.R2_MAX_STORAGE_BYTES;
	if (cap > 0) {
		const usage = await getBucketUsageBytes();
		if (usage + data.byteLength > cap) {
			const gb = (n: number) => (n / 1e9).toFixed(2);
			throw new Error(
				`R2 storage limit reached: ${gb(usage)} GB used of ${gb(cap)} GB cap. ` +
					`Delete old media in the "${bucketName()}" bucket or raise R2_MAX_STORAGE_BYTES.`,
			);
		}
	}

	const client = getR2Client();
	const url = getR2Url(`media/${hash}`);

	// R2 rejects PUTs without a Content-Length (411). undici won't infer length
	// for a bare ArrayBuffer body and falls back to chunked encoding, so wrap it
	// in a Uint8Array and set the length explicitly.
	const body = new Uint8Array(data);
	const response = await client.fetch(url, {
		method: "PUT",
		body,
		headers: {
			"Content-Type": mimeType,
			"Content-Length": String(body.byteLength),
		},
	});

	if (!response.ok) {
		throw new Error(
			`R2 upload failed: ${response.status} ${response.statusText}`,
		);
	}

	// Keep the cached usage roughly current so back-to-back uploads in the same
	// window still respect the cap without re-listing.
	if (usageCache) usageCache.bytes += data.byteLength;

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
	// Treat the .env.example placeholders ("your_account_id_here", etc.) as
	// unconfigured so they don't trick callers into attempting doomed R2 writes.
	const real = (v: string) => Boolean(v) && !/^your_/.test(v);
	return (
		real(webEnv.CLOUDFLARE_ACCOUNT_ID) &&
		real(webEnv.R2_ACCESS_KEY_ID) &&
		real(webEnv.R2_SECRET_ACCESS_KEY)
	);
}

/** Sign a request for an arbitrary key with a query-string (presigned URL)
 *  SigV4 signature. Shared by the GET/PUT presign helpers below — the
 *  signing shape only differs by HTTP method. SigV4 caps expiry at 7 days. */
async function presignKey(
	key: string,
	method: "GET" | "PUT",
	expiresInSeconds: number,
): Promise<string> {
	const client = getR2Client();
	const url = new URL(getR2Url(key));
	url.searchParams.set("X-Amz-Expires", String(expiresInSeconds));
	const signed = await client.sign(url.toString(), {
		method,
		aws: { signQuery: true },
	});
	return signed.url;
}

/**
 * Produce a time-limited, publicly fetchable GET URL for a stored object.
 * Used when no public bucket domain is configured. SigV4 caps expiry at 7 days.
 */
export function presignGetUrl(
	hash: string,
	expiresInSeconds: number,
): Promise<string> {
	return presignKey(`media/${hash}`, "GET", expiresInSeconds);
}

/** Same as {@link presignGetUrl}, but for an arbitrary object key rather than
 *  a content hash under `media/` — used for keys that aren't content-addressed
 *  (e.g. the `refs/{ownerId}/{id}` keys `presignDirectUpload` mints, since we
 *  don't have the bytes to hash before the client has uploaded them). */
export function presignGetUrlForKey(
	key: string,
	expiresInSeconds: number,
): Promise<string> {
	return presignKey(key, "GET", expiresInSeconds);
}

/**
 * Produce a time-limited presigned PUT URL for a NEW object key. The browser
 * uploads bytes directly to this URL — the file body never transits our own
 * server, so it isn't bound by the platform's serverless function body-size
 * cap (the reason large reference-video uploads used to fail; see
 * `presignDirectUpload` in `lib/studio/media-storage.ts`).
 */
export function presignPutUrl(
	key: string,
	expiresInSeconds: number,
): Promise<string> {
	return presignKey(key, "PUT", expiresInSeconds);
}

/**
 * Delete a media object from R2.
 */
export async function deleteMedia(hash: string): Promise<void> {
	const client = getR2Client();
	const url = getR2Url(`media/${hash}`);
	await client.fetch(url, { method: "DELETE" });
}

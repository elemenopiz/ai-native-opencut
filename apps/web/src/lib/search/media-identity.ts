/**
 * Stable media identity for cross-project understanding reuse (Flow E).
 *
 * A `MediaAsset.id` is a fresh `generateUUID()` minted at IMPORT time, so the SAME
 * physical file re-imported into a new project gets a DIFFERENT id — which means
 * its per-project understanding record (keyed by `mediaId`) is not found and the
 * (paid) Understanding Pass would run again. This module supplies a CONTENT-derived
 * identity that is stable across re-imports and across projects, so the user-media
 * memory can be keyed by it.
 *
 * Primary identity is a SHA-256 of the file bytes (Web Crypto `crypto.subtle`,
 * available in the browser and in bun/node test envs). When subtle crypto or the
 * bytes are unavailable, it falls back to a cheap `name:size:lastModified`
 * SIGNATURE — weaker but still stable for the common "user re-drops the same file
 * from disk" case. The two spaces are namespaced by prefix (`sha256:` / `sig:`) so
 * a signature can never be mistaken for (or collide with) a real hash.
 */

/** Something we can derive a content identity from — a File/Blob, raw bytes, or a signature triple. */
export type MediaIdentityInput =
	| Blob
	| ArrayBuffer
	| Uint8Array
	| { name?: string; size?: number; lastModified?: number };

/** A cheap, stable-ish signature from file metadata (fallback when bytes/hash aren't available). */
export function mediaSignature(meta: {
	name?: string;
	size?: number;
	lastModified?: number;
}): string {
	const name = (meta.name ?? "").trim().toLowerCase();
	const size = Number.isFinite(meta.size) ? Math.floor(meta.size as number) : 0;
	const mtime = Number.isFinite(meta.lastModified)
		? Math.floor(meta.lastModified as number)
		: 0;
	return `sig:${name}:${size}:${mtime}`;
}

/** Hex-encode an ArrayBuffer of hash bytes. */
function toHex(buf: ArrayBuffer): string {
	const bytes = new Uint8Array(buf);
	let out = "";
	for (const b of bytes) out += b.toString(16).padStart(2, "0");
	return out;
}

/** Whether Web Crypto's subtle digest is usable in this environment. */
function hasSubtleCrypto(): boolean {
	return (
		typeof globalThis.crypto !== "undefined" &&
		typeof globalThis.crypto.subtle !== "undefined" &&
		typeof globalThis.crypto.subtle.digest === "function"
	);
}

async function toArrayBuffer(
	input: Blob | ArrayBuffer | Uint8Array,
): Promise<ArrayBuffer> {
	if (input instanceof ArrayBuffer) return input;
	if (input instanceof Uint8Array) {
		// Copy out an exact-length ArrayBuffer (the view may span a larger buffer).
		return input.slice().buffer;
	}
	// Blob / File.
	return input.arrayBuffer();
}

/**
 * Compute a stable content identity for a piece of media. Returns a namespaced
 * string: `sha256:<hex>` when the bytes can be hashed, else a `sig:` signature.
 *
 * Never throws: a hashing/read failure falls back to the metadata signature (or,
 * with no metadata, a stable `sig::0:0`) so callers can always key on the result.
 */
export async function computeMediaIdentity(
	input: MediaIdentityInput,
): Promise<string> {
	// A bare signature triple (no bytes) — hash isn't possible, use the signature.
	if (
		!(input instanceof Blob) &&
		!(input instanceof ArrayBuffer) &&
		!(input instanceof Uint8Array)
	) {
		return mediaSignature(input);
	}

	// Capture metadata for the fallback BEFORE attempting the (throwable) hash.
	const meta =
		input instanceof Blob
			? {
					name: (input as File).name,
					size: input.size,
					lastModified: (input as File).lastModified,
				}
			: { size: (input as { byteLength?: number }).byteLength };

	if (!hasSubtleCrypto()) return mediaSignature(meta);

	try {
		const buffer = await toArrayBuffer(input);
		const digest = await globalThis.crypto.subtle.digest("SHA-256", buffer);
		return `sha256:${toHex(digest)}`;
	} catch {
		return mediaSignature(meta);
	}
}

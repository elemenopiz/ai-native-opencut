/**
 * BytePlus ModelArk "real-human asset" references.
 *
 * A verified likeness in ModelArk's private asset library (My assets →
 * Real-human) is addressed by an `asset://<asset_id>` URI rather than a
 * fetchable media URL. Passed to Seedance 2.0 as a `reference_image` /
 * `reference_video`, it's a consent-verified real face that clears the
 * real-person filter a raw upload would trip — so these refs must bypass the
 * usual rehost/normalize/`<img>` paths (the scheme isn't browser-fetchable).
 */
export const ASSET_URI_SCHEME = "asset://";

/** Whether a reference URL is a BytePlus verified-asset URI. */
export function isAssetRef(url: string): boolean {
	return url.startsWith(ASSET_URI_SCHEME);
}

/**
 * Normalize user input into a BytePlus asset URI, or null if it isn't one.
 * Accepts a full `asset://asset-…` URI (used as-is) or a bare `asset-…` id
 * (prefixed with the scheme). Anything else — a stray URL, a `group-…` id,
 * empty, garbage — returns null so the caller rejects it rather than sending a
 * reference the provider can't resolve.
 */
export function normalizeAssetUri(raw: string): string | null {
	const trimmed = raw.trim();
	if (isAssetRef(trimmed)) return trimmed;
	if (trimmed.startsWith("asset-")) return `${ASSET_URI_SCHEME}${trimmed}`;
	return null;
}

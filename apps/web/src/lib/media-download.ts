import type { MediaAsset } from "@/types/assets";

/**
 * Download a library asset's ORIGINAL bytes to the user's machine. Assets keep
 * their source `File` in memory (`MediaAsset.file`), so this is a pure
 * client-side object-URL + anchor click — no re-encode, no server round-trip,
 * and proxies (`proxyFile`) are deliberately ignored: what you download is
 * exactly what was imported or generated.
 */

const EXT_BY_MIME: Record<string, string> = {
	"video/mp4": "mp4",
	"video/webm": "webm",
	"video/quicktime": "mov",
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif",
	"audio/mpeg": "mp3",
	"audio/mp4": "m4a",
	"audio/wav": "wav",
	"audio/x-wav": "wav",
	"audio/ogg": "ogg",
};

const HAS_EXT = /\.[a-z0-9]{2,5}$/i;

/**
 * Filename for the saved file. The asset's display name wins (it's what the
 * user knows the clip as), but display names often carry no extension —
 * generated takes are named like "Take 3" — so one is appended from the source
 * file's own name, else its MIME type. Pure and exported for tests.
 */
export function assetDownloadFilename(asset: {
	name: string;
	file: File;
}): string {
	const base = asset.name.trim() || asset.file.name.trim() || "asset";
	if (HAS_EXT.test(base)) return base;
	const fromFileName = HAS_EXT.exec(asset.file.name.trim())?.[0];
	if (fromFileName) return `${base}${fromFileName}`;
	const fromMime = EXT_BY_MIME[asset.file.type];
	return fromMime ? `${base}.${fromMime}` : base;
}

/** Trigger the browser download. Throws if the asset has no file bytes. */
export function downloadMediaAsset(asset: MediaAsset): void {
	if (!asset.file) {
		// `file` is typed required but in-flight/partially-loaded assets can
		// lack it at runtime (see assets.tsx's own `!!item.file` guards).
		throw new Error("This asset's file isn't loaded yet — try again shortly.");
	}
	const url = URL.createObjectURL(asset.file);
	const a = document.createElement("a");
	a.href = url;
	a.download = assetDownloadFilename(asset);
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
}

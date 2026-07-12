/**
 * Data-URL → Blob/File conversion. Frame extraction decodes to a `data:` URL
 * (canvas `toDataURL`), but the media library persists real `File`s and R2
 * upload wants a `File`/`Blob` — so we materialize the base64 payload once here
 * instead of re-fetching the data URL through `fetch()` (which works but spins
 * up a network task for bytes we already hold).
 */

/** Parse a `data:<mime>;base64,<payload>` URL into `{ mime, bytes }`. */
function decodeDataUrl(dataUrl: string): { mime: string; bytes: Uint8Array } {
	const comma = dataUrl.indexOf(",");
	if (!dataUrl.startsWith("data:") || comma === -1) {
		throw new Error("Not a data URL");
	}
	const header = dataUrl.slice(5, comma); // between "data:" and ","
	const isBase64 = /;base64$/i.test(header);
	const mime = header.replace(/;base64$/i, "") || "application/octet-stream";
	const payload = dataUrl.slice(comma + 1);

	if (isBase64) {
		const binary = atob(payload);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return { mime, bytes };
	}
	// Non-base64 (percent-encoded) data URLs — rare for our canvas output, but
	// handle them so the util is generally correct.
	const decoded = decodeURIComponent(payload);
	const bytes = new Uint8Array(decoded.length);
	for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
	return { mime, bytes };
}

/** Convert a `data:` URL to a `Blob`. */
export function dataUrlToBlob(dataUrl: string): Blob {
	const { mime, bytes } = decodeDataUrl(dataUrl);
	return new Blob([bytes], { type: mime });
}

/**
 * Convert a `data:` URL to a named `File`. The extension is derived from the
 * MIME type (png/jpg) so downstream consumers (upload MIME sniffing, filenames)
 * see a sensible name.
 */
export function dataUrlToFile(dataUrl: string, baseName: string): File {
	const { mime, bytes } = decodeDataUrl(dataUrl);
	const ext =
		mime === "image/png" ? "png" : mime === "image/jpeg" ? "jpg" : "bin";
	const safe = baseName.replace(/[\\/:*?"<>|]+/g, "_").trim() || "frame";
	const fileName = /\.[a-z0-9]+$/i.test(safe) ? safe : `${safe}.${ext}`;
	return new File([bytes], fileName, { type: mime });
}

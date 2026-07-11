import type { EditorCore } from "@/core";
import { getDragData } from "@/lib/drag-data";
import { fetchWithTimeout, MEDIA_TIMEOUT_MS } from "@/lib/studio/fetch-timeout";

/**
 * Shared helpers for attaching reference media in the Generate panel. A
 * reference must be a publicly-fetchable URL (BytePlus pulls it server-side), so
 * every attachment — whether a dropped file or a clip dragged from the Assets
 * panel — is uploaded to R2 via `/api/studio/upload` first.
 */

export interface UploadedReference {
	url: string;
	kind: "image" | "video";
}

/** Upload one file and return its rehosted URL + detected kind. */
export async function uploadReferenceFile(
	file: File,
): Promise<UploadedReference> {
	const body = new FormData();
	body.append("file", file);
	// Whole-file upload to R2 — media budget.
	const res = await fetchWithTimeout("/api/studio/upload", {
		timeoutMs: MEDIA_TIMEOUT_MS,
		method: "POST",
		body,
	});
	const data = (await res.json()) as {
		url?: string;
		kind?: "image" | "video";
		error?: string;
	};
	if (!res.ok || !data.url) throw new Error(data.error ?? "Upload failed");
	return {
		url: data.url,
		kind: data.kind ?? (file.type.startsWith("video/") ? "video" : "image"),
	};
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

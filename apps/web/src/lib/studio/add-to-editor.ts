import type { EditorCore } from "@/core";
import { processMediaAssets } from "@/lib/media/processing";
import { fetchWithTimeout, MEDIA_TIMEOUT_MS } from "@/lib/studio/fetch-timeout";
import { buildElementFromMedia } from "@/lib/timeline/element-utils";
import { TIMELINE_CONSTANTS } from "@/constants/timeline-constants";
import type { PendingClip } from "@/stores/studio-handoff-store";

/** A Studio output (video take, image still, or generated audio) headed for
 *  a project. */
export interface StudioMediaItem {
	url: string;
	name: string;
	kind: "video" | "image" | "audio";
}

/**
 * Imports Studio outputs into a project's media library WITHOUT touching the
 * timeline. The clips show up in the editor's Assets panel, where the existing
 * drag-to-timeline machinery takes over — this is the "Send to editor" path.
 */
export async function addItemsToProjectMedia({
	editor,
	projectId,
	items,
	source,
}: {
	editor: EditorCore;
	projectId: string;
	items: StudioMediaItem[];
	/** Tags the resulting assets (e.g. "ai" for Studio-generated media). */
	source?: "ai";
}): Promise<{ added: number; failed: number; mediaIds: string[] }> {
	let added = 0;
	let failed = 0;
	const mediaIds: string[] = [];

	for (const item of items) {
		try {
			// Whole-media download through the proxy — media budget.
			const res = await fetchWithTimeout(
				`/api/studio/proxy?url=${encodeURIComponent(item.url)}`,
				{ timeoutMs: MEDIA_TIMEOUT_MS },
			);
			if (!res.ok) throw new Error(`fetch failed ${res.status}`);

			const blob = await res.blob();
			const ext =
				item.kind === "image" ? "png" : item.kind === "audio" ? "mp3" : "mp4";
			const fallbackType =
				item.kind === "image"
					? "image/png"
					: item.kind === "audio"
						? "audio/mpeg"
						: "video/mp4";
			const expectedPrefix =
				item.kind === "image"
					? "image/"
					: item.kind === "audio"
						? "audio/"
						: "video/";

			const fileName = item.name.toLowerCase().endsWith(`.${ext}`)
				? item.name
				: `${item.name}.${ext}`;
			// Providers sometimes serve generated media as octet-stream; coerce to
			// the right family so the editor doesn't reject it as unsupported.
			const type = blob.type.startsWith(expectedPrefix)
				? blob.type
				: fallbackType;
			const file = new File([blob], fileName, { type });

			const [processed] = await processMediaAssets({ files: [file] });
			if (!processed) throw new Error("processing produced no asset");

			const mediaId = await editor.media.addMediaAsset({
				projectId,
				asset: source ? { ...processed, source } : processed,
			});
			if (mediaId) mediaIds.push(mediaId);
			added++;
		} catch (err) {
			console.error(
				"Failed to add studio item to project media:",
				item.url,
				err,
			);
			failed++;
		}
	}

	return { added, failed, mediaIds };
}

/**
 * Imports generated Studio clips onto the editor timeline.
 *
 * Each clip's remote URL is fetched (through our same-origin proxy to avoid
 * provider CORS), turned into a File, run through the editor's normal media
 * pipeline (probe dimensions/duration, thumbnail), registered as a project
 * media asset, then appended to the timeline as a video element.
 *
 * Returns the number of clips successfully added.
 */
export async function addClipsToEditor({
	editor,
	projectId,
	clips,
	onProgress,
}: {
	editor: EditorCore;
	projectId: string;
	clips: PendingClip[];
	onProgress?: (done: number, total: number) => void;
}): Promise<{ added: number; failed: number }> {
	let added = 0;
	let failed = 0;

	for (let i = 0; i < clips.length; i++) {
		const clip = clips[i];
		try {
			// Whole-video download through the proxy — media budget.
			const res = await fetchWithTimeout(
				`/api/studio/proxy?url=${encodeURIComponent(clip.videoUrl)}`,
				{ timeoutMs: MEDIA_TIMEOUT_MS },
			);
			if (!res.ok) throw new Error(`fetch failed ${res.status}`);

			const blob = await res.blob();
			const fileName = clip.name.toLowerCase().endsWith(".mp4")
				? clip.name
				: `${clip.name}.mp4`;
			// The editor classifies media by MIME type, so coerce anything that
			// isn't already a recognized video (e.g. application/octet-stream) to
			// video/mp4 — otherwise the clip would be rejected as "unsupported".
			const type = blob.type.startsWith("video/") ? blob.type : "video/mp4";
			const file = new File([blob], fileName, { type });

			const [processed] = await processMediaAssets({ files: [file] });
			if (!processed) throw new Error("processing produced no asset");

			const mediaId = await editor.media.addMediaAsset({
				projectId,
				asset: { ...processed, source: "ai" },
			});

			const duration =
				processed.duration ??
				clip.durationHint ??
				TIMELINE_CONSTANTS.DEFAULT_ELEMENT_DURATION;

			const element = buildElementFromMedia({
				mediaId,
				mediaType: "video",
				name: processed.name,
				duration,
				startTime: 0,
			});

			editor.timeline.insertElement({
				element,
				placement: { mode: "auto" },
			});

			added++;
		} catch (err) {
			console.error(
				"Failed to add studio clip to timeline:",
				clip.videoUrl,
				err,
			);
			failed++;
		} finally {
			onProgress?.(i + 1, clips.length);
		}
	}

	return { added, failed };
}

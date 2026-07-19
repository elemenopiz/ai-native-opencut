import { aiClient } from "@/lib/ai-client";

/**
 * Shared AI background-removal ("matting") pipeline — the pure browser-
 * boundary logic that used to live inline in `ai-toolbar.tsx`'s
 * `handleRemoveBackground` callback (the sole caller of
 * `BackgroundRemovalDialog`'s `onRemoveBackground` prop). Extracted so BOTH
 * the dialog's caller (`ai-toolbar.tsx`, unchanged behavior) and the Director
 * `removeBackground` verb (`lib/director/director-api.ts`) call the SAME
 * pipeline instead of a UI-only copy — poach plan item #3
 * (`docs/poach/vyra-poach-plan.md`), "reuse the dialog's underlying pipeline,
 * do not reimplement matting."
 *
 * Talks to the same `aiClient.removeBackground` boundary the dialog already
 * used, which posts to the (currently retired/parked, ADR-004) local AI
 * backend's `/api/generate/remove-bg` — this module does not change that
 * wiring, only where the calling logic lives.
 */

export interface BackgroundRemovalResult {
	/** The source image, as a browser-displayable URL (object URL for an
	 *  uploaded File, the original URL for a timeline-frame/asset source). */
	originalUrl: string;
	/** The matted result's URL, as returned by the AI backend. */
	processedUrl: string;
	/** Real pixel width of the processed image, measured after decode. */
	width: number;
	/** Real pixel height of the processed image, measured after decode. */
	height: number;
}

/** The matting call itself — narrowed to exactly what this pipeline needs
 *  from `aiClient`, so tests can inject a stub without touching the network. */
export interface BackgroundRemovalClient {
	removeBackground(file: File): Promise<{ imageUrl: string }>;
}

/** Measure a processed image's real pixel dimensions by decoding it — the
 *  backend doesn't report dimensions, only a URL. Resolves `{0, 0}` (never
 *  rejects) on a decode failure so a slow/broken image never hangs the
 *  pipeline. */
function measureImageDimensions(
	url: string,
): Promise<{ width: number; height: number }> {
	return new Promise((resolve) => {
		const img = new Image();
		img.onload = () =>
			resolve({ width: img.naturalWidth, height: img.naturalHeight });
		img.onerror = () => resolve({ width: 0, height: 0 });
		img.src = url;
	});
}

/**
 * Remove the background from a source image — a File (an upload) or a URL (a
 * timeline-frame/library-asset source) — and return the matted result plus
 * both images' real dimensions for a before/after comparison. Non-File
 * sources are fetched and rewrapped as a File first, since the underlying
 * client method takes a File (matches `aiClient.removeBackground`'s
 * multipart-upload contract).
 */
export async function removeImageBackground(
	source: File | string,
	client: BackgroundRemovalClient = aiClient,
): Promise<BackgroundRemovalResult> {
	const originalUrl =
		typeof source === "string" ? source : URL.createObjectURL(source);

	let file: File;
	if (typeof source === "string") {
		const res = await fetch(source);
		const blob = await res.blob();
		file = new File([blob], "frame.png", { type: blob.type || "image/png" });
	} else {
		file = source;
	}

	const { imageUrl } = await client.removeBackground(file);
	const dims = await measureImageDimensions(imageUrl);

	return {
		originalUrl,
		processedUrl: imageUrl,
		width: dims.width,
		height: dims.height,
	};
}

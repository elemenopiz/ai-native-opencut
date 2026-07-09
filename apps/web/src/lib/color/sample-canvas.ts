/**
 * Read a downsampled `ImageData` off a (potentially large) source canvas.
 *
 * Used by both the scopes UI and auto color-correction to sample the composited
 * preview frame cheaply: we let the GPU box-scale the source into a small
 * analysis canvas via `drawImage`, then read that back with `getImageData`.
 * This keeps the per-frame `getImageData` cost bounded regardless of the
 * project's canvas resolution.
 */

/** Reusable analysis canvas so we don't allocate one per sample. */
let analysisCanvas: HTMLCanvasElement | OffscreenCanvas | null = null;
let analysisCtx:
	| CanvasRenderingContext2D
	| OffscreenCanvasRenderingContext2D
	| null = null;

function getAnalysisContext({
	width,
	height,
}: {
	width: number;
	height: number;
}) {
	if (!analysisCanvas) {
		analysisCanvas =
			typeof OffscreenCanvas !== "undefined"
				? new OffscreenCanvas(width, height)
				: document.createElement("canvas");
	}
	if (analysisCanvas.width !== width) analysisCanvas.width = width;
	if (analysisCanvas.height !== height) analysisCanvas.height = height;
	if (!analysisCtx) {
		analysisCtx = analysisCanvas.getContext("2d", {
			willReadFrequently: true,
		}) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
	}
	return analysisCtx;
}

/**
 * Sample `source` into an `ImageData` no wider than `maxSize` (aspect
 * preserved). Returns `null` if the source has no dimensions yet or a 2D
 * context is unavailable.
 */
export function sampleCanvasImageData({
	source,
	maxSize = 320,
}: {
	source: HTMLCanvasElement;
	maxSize?: number;
}): ImageData | null {
	const srcW = source.width;
	const srcH = source.height;
	if (!srcW || !srcH) return null;

	const scale = Math.min(1, maxSize / Math.max(srcW, srcH));
	const width = Math.max(1, Math.round(srcW * scale));
	const height = Math.max(1, Math.round(srcH * scale));

	const ctx = getAnalysisContext({ width, height });
	if (!ctx) return null;

	ctx.clearRect(0, 0, width, height);
	try {
		ctx.drawImage(source, 0, 0, width, height);
		return ctx.getImageData(0, 0, width, height);
	} catch {
		// Tainted canvas or transient render state — treat as no sample.
		return null;
	}
}

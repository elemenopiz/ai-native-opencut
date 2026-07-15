export function createOffscreenCanvas({
	width,
	height,
}: {
	width: number;
	height: number;
}): OffscreenCanvas | HTMLCanvasElement {
	try {
		return new OffscreenCanvas(width, height);
	} catch {
		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		return canvas;
	}
}

/**
 * `getContext("2d")` with high-quality resampling. `imageSmoothingEnabled`
 * defaults to true, but `imageSmoothingQuality` defaults to "low" — a
 * single-tap bilinear filter that visibly softens/aliases any scaled
 * drawImage. Most of this renderer's draws ARE scaled (decoded video frame
 * onto a playback-quality-downscaled backing store, effect/transition
 * scratch canvases, image downscaling), so this is the difference between a
 * crisp and a blurry preview. "high" costs essentially nothing extra here:
 * the canvas is already sized to the target resolution, so this only changes
 * the resampling kernel, not the pixel count.
 *
 * Note: assigning a canvas's width/height resets its context state
 * (including these two flags) — call this again after every resize rather
 * than caching a context configured once.
 */
export function getContext2D(
	canvas: OffscreenCanvas | HTMLCanvasElement,
): OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null {
	const ctx = canvas.getContext("2d") as
		| OffscreenCanvasRenderingContext2D
		| CanvasRenderingContext2D
		| null;
	if (ctx) {
		ctx.imageSmoothingEnabled = true;
		ctx.imageSmoothingQuality = "high";
	}
	return ctx;
}

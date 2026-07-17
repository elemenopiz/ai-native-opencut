export interface ContainFitSize {
	width: number;
	height: number;
}

export interface ContainFitRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * Computes the placement of a `src`-sized image inside a `dst`-sized canvas
 * using uniform "contain" scaling — the image is scaled up/down as much as
 * possible while staying entirely inside `dst`, then centered. Any leftover
 * space (when the aspect ratios differ) is the letterbox/pillarbox gutter,
 * meant to be filled with a solid color before drawing the returned rect.
 *
 * All returned fields are rounded to integers (canvas APIs want integer
 * pixels), and the gutter is kept symmetric to within 1px on each axis —
 * i.e. `x` and `dst.width - (x + width)` never differ by more than 1, same
 * for `y`. When `src` and `dst` share an aspect ratio this degenerates to a
 * pure scale with x = y = 0 (no bars).
 */
export function computeContainFit({
	src,
	dst,
}: {
	src: ContainFitSize;
	dst: ContainFitSize;
}): ContainFitRect {
	if (src.width <= 0 || src.height <= 0 || dst.width <= 0 || dst.height <= 0) {
		return {
			x: 0,
			y: 0,
			width: Math.round(dst.width),
			height: Math.round(dst.height),
		};
	}

	const scale = Math.min(dst.width / src.width, dst.height / src.height);
	const width = Math.round(src.width * scale);
	const height = Math.round(src.height * scale);

	const x = Math.round((dst.width - width) / 2);
	const y = Math.round((dst.height - height) / 2);

	return { x, y, width, height };
}

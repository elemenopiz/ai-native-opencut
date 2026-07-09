import type { Cube3DLut } from "./lut-cube-parser";

/**
 * A 3D LUT baked into a single 2D RGBA8 texture, using the standard
 * "tile the blue axis horizontally" layout: `size` slices of `size x size`
 * (red x green) laid out side by side, so width = size*size, height = size.
 * This lets a WebGL1 context (no true 3D textures) sample a 3D LUT with two
 * 2D texture fetches + a manual lerp across the blue axis — see
 * `definitions/lut-3d.frag.glsl` for the shader-side sampling.
 */
export interface TiledLutTexture {
	width: number;
	height: number;
	/** RGBA8 pixel data, row-major, top row first (no Y-flip needed). */
	data: Uint8Array;
	size: number;
}

/** Bakes a parsed `.cube` LUT into a tiled RGBA8 texture ready for GPU upload. */
export function buildTiledLutTexture(lut: Cube3DLut): TiledLutTexture {
	const { size, data } = lut;
	const width = size * size;
	const height = size;
	const rgba = new Uint8Array(width * height * 4);

	for (let i = 0; i < size * size * size; i++) {
		// .cube data is stored red-fastest, then green, then blue (slowest).
		const r = i % size;
		const g = Math.floor(i / size) % size;
		const b = Math.floor(i / (size * size));

		const x = b * size + r;
		const y = g;
		const pixelIndex = (y * width + x) * 4;

		rgba[pixelIndex + 0] = Math.round(data[i * 3 + 0] * 255);
		rgba[pixelIndex + 1] = Math.round(data[i * 3 + 1] * 255);
		rgba[pixelIndex + 2] = Math.round(data[i * 3 + 2] * 255);
		rgba[pixelIndex + 3] = 255;
	}

	return { width, height, data: rgba, size };
}

/** A pass-through LUT (identity mapping) — used as the default/"None" preset. */
export function buildIdentityLut(size = 2): Cube3DLut {
	const data = new Float32Array(size * size * size * 3);
	for (let b = 0; b < size; b++) {
		for (let g = 0; g < size; g++) {
			for (let r = 0; r < size; r++) {
				const i = b * size * size + g * size + r;
				data[i * 3 + 0] = r / (size - 1);
				data[i * 3 + 1] = g / (size - 1);
				data[i * 3 + 2] = b / (size - 1);
			}
		}
	}
	return { size, data, title: "Identity" };
}

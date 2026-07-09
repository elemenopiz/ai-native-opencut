/**
 * Adobe / DaVinci `.cube` LUT ingestion.
 *
 * Parses a 3D `.cube` color lookup table and bakes it into a **tiled 2D atlas**
 * so it can be sampled from a WebGL1 fragment shader (WebGL1 has no
 * `sampler3D`). The atlas is a horizontal strip of `size` blue-slices, each
 * `size x size` (red across, green down):
 *
 *     width  = size * size   (slice b occupies columns [b*size, b*size+size))
 *     height = size
 *     pixel(x=b*size+r, y=g) = LUT[r, g, b]
 *
 * The shader picks the two nearest blue slices, samples each with hardware
 * bilinear filtering (texel-center offsets keep the red axis from bleeding into
 * the neighbouring slice), and blends them by the blue fraction — the standard
 * WebGL1 tiled-LUT technique (cf. three.js `LUTPass` fallback / GPU Gems).
 */

export interface CubeLut3D {
	kind: "3d";
	title: string;
	/** N in LUT_3D_SIZE — the per-axis resolution. */
	size: number;
	/** Input domain lower bound (default [0,0,0]). */
	domainMin: [number, number, number];
	/** Input domain upper bound (default [1,1,1]). */
	domainMax: [number, number, number];
	/**
	 * Flat RGB triplets, **red index changing fastest**, then green, then blue
	 * (as written in the `.cube` table). Length === size^3 * 3.
	 */
	data: Float32Array;
}

/** A baked 2D LUT atlas ready to upload as an RGBA8 texture. */
export interface LutAtlas {
	size: number;
	width: number;
	height: number;
	/** RGBA8 pixels, row-major, length === width * height * 4. */
	pixels: Uint8ClampedArray;
	domainMin: [number, number, number];
	domainMax: [number, number, number];
}

/**
 * Serialized LUT stored inline in an effect param (a plain JSON string).
 *
 * Storage strategy: the parsed cube is thousands of floats and must NOT live in
 * the flat `EffectParamValues` record as numbers. Instead the baked atlas is
 * base64-encoded into a single **string** param. Strings pass through project
 * save/reload and through keyframe param resolution untouched (keyframes are
 * number-only), so the LUT survives both. Decoding back into an `ImageData` is
 * synchronous (`atob`, no async image load), and a render-time cache keyed by
 * the exact string avoids re-decoding every frame — see `lut.ts`.
 */
export interface SerializedLut {
	name: string;
	size: number;
	width: number;
	height: number;
	domainMin: [number, number, number];
	domainMax: [number, number, number];
	/** base64 of the RGBA8 atlas pixels. */
	pixelsBase64: string;
}

const MIN_LUT_SIZE = 2;
const MAX_LUT_SIZE = 256;

function isFiniteNumber(value: number): boolean {
	return typeof value === "number" && Number.isFinite(value);
}

function parseTriplet({
	tokens,
	keyword,
	lineNumber,
}: {
	tokens: string[];
	keyword: string;
	lineNumber: number;
}): [number, number, number] {
	if (tokens.length < 3) {
		throw new Error(
			`Invalid .cube: ${keyword} on line ${lineNumber} expects 3 values`,
		);
	}
	const r = Number(tokens[0]);
	const g = Number(tokens[1]);
	const b = Number(tokens[2]);
	if (!isFiniteNumber(r) || !isFiniteNumber(g) || !isFiniteNumber(b)) {
		throw new Error(
			`Invalid .cube: ${keyword} on line ${lineNumber} has non-numeric values`,
		);
	}
	return [r, g, b];
}

/**
 * Parse a `.cube` LUT file. Supports 3D LUTs (the common case). 1D LUTs
 * (`LUT_1D_SIZE`) are clearly rejected rather than silently mishandled.
 *
 * @throws {Error} on malformed input, unsupported 1D LUTs, or size/row mismatch.
 */
export function parseCubeLut({ text }: { text: string }): CubeLut3D {
	const lines = text.split(/\r?\n/);

	let title = "";
	let size: number | null = null;
	let domainMin: [number, number, number] = [0, 0, 0];
	let domainMax: [number, number, number] = [1, 1, 1];
	const data: number[] = [];

	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		const lineNumber = i + 1;
		// Strip inline comments and surrounding whitespace.
		const withoutComment = raw.split("#")[0];
		const line = withoutComment.trim();
		if (line.length === 0) continue;

		const tokens = line.split(/\s+/);
		const keyword = tokens[0].toUpperCase();

		switch (keyword) {
			case "TITLE": {
				const match = line.match(/"([^"]*)"/);
				title = match ? match[1] : tokens.slice(1).join(" ");
				break;
			}
			case "LUT_1D_SIZE":
				throw new Error(
					"1D LUTs (LUT_1D_SIZE) are not supported — please provide a 3D .cube LUT.",
				);
			case "LUT_3D_SIZE": {
				const n = Number(tokens[1]);
				if (!Number.isInteger(n) || n < MIN_LUT_SIZE || n > MAX_LUT_SIZE) {
					throw new Error(
						`Invalid .cube: LUT_3D_SIZE must be an integer in [${MIN_LUT_SIZE}, ${MAX_LUT_SIZE}], got "${tokens[1]}"`,
					);
				}
				size = n;
				break;
			}
			case "DOMAIN_MIN":
				domainMin = parseTriplet({
					tokens: tokens.slice(1),
					keyword,
					lineNumber,
				});
				break;
			case "DOMAIN_MAX":
				domainMax = parseTriplet({
					tokens: tokens.slice(1),
					keyword,
					lineNumber,
				});
				break;
			default: {
				// A data row: three floats. Anything else is a malformed keyword.
				const r = Number(tokens[0]);
				const g = Number(tokens[1]);
				const b = Number(tokens[2]);
				if (
					tokens.length < 3 ||
					!isFiniteNumber(r) ||
					!isFiniteNumber(g) ||
					!isFiniteNumber(b)
				) {
					throw new Error(
						`Invalid .cube: unrecognized line ${lineNumber}: "${line}"`,
					);
				}
				data.push(r, g, b);
				break;
			}
		}
	}

	if (size === null) {
		throw new Error("Invalid .cube: missing LUT_3D_SIZE");
	}

	const expectedRows = size * size * size;
	const actualRows = data.length / 3;
	if (actualRows !== expectedRows) {
		throw new Error(
			`Invalid .cube: expected ${expectedRows} data rows for LUT_3D_SIZE ${size}, got ${actualRows}`,
		);
	}

	return {
		kind: "3d",
		title,
		size,
		domainMin,
		domainMax,
		data: Float32Array.from(data),
	};
}

/**
 * Bake a parsed 3D LUT into a tiled 2D atlas (horizontal strip of blue slices).
 */
export function bakeLutAtlas({ lut }: { lut: CubeLut3D }): LutAtlas {
	const { size, data } = lut;
	const width = size * size;
	const height = size;
	const pixels = new Uint8ClampedArray(width * height * 4);

	for (let b = 0; b < size; b++) {
		for (let g = 0; g < size; g++) {
			for (let r = 0; r < size; r++) {
				// `.cube` ordering: red fastest, then green, then blue.
				const src = ((b * size + g) * size + r) * 3;
				const x = b * size + r;
				const y = g;
				const dst = (y * width + x) * 4;
				pixels[dst] = data[src] * 255;
				pixels[dst + 1] = data[src + 1] * 255;
				pixels[dst + 2] = data[src + 2] * 255;
				pixels[dst + 3] = 255;
			}
		}
	}

	return {
		size,
		width,
		height,
		pixels,
		domainMin: lut.domainMin,
		domainMax: lut.domainMax,
	};
}

const BASE64_CHUNK = 0x8000;

function bytesToBase64({ bytes }: { bytes: Uint8ClampedArray }): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
		const chunk = bytes.subarray(i, i + BASE64_CHUNK);
		binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
	}
	return btoa(binary);
}

function base64ToBytes({ base64 }: { base64: string }): Uint8ClampedArray {
	const binary = atob(base64);
	const bytes = new Uint8ClampedArray(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

/** Serialize a baked atlas into a compact JSON string for an effect param. */
export function serializeLut({
	atlas,
	name,
}: {
	atlas: LutAtlas;
	name: string;
}): string {
	const payload: SerializedLut = {
		name,
		size: atlas.size,
		width: atlas.width,
		height: atlas.height,
		domainMin: atlas.domainMin,
		domainMax: atlas.domainMax,
		pixelsBase64: bytesToBase64({ bytes: atlas.pixels }),
	};
	return JSON.stringify(payload);
}

export interface DeserializedLut {
	name: string;
	size: number;
	width: number;
	height: number;
	domainMin: [number, number, number];
	domainMax: [number, number, number];
	pixels: Uint8ClampedArray;
}

/** Reconstruct a baked atlas from a serialized param string. */
export function deserializeLut({
	serialized,
}: {
	serialized: string;
}): DeserializedLut {
	const payload = JSON.parse(serialized) as SerializedLut;
	const pixels = base64ToBytes({ base64: payload.pixelsBase64 });
	const expected = payload.width * payload.height * 4;
	if (pixels.length !== expected) {
		throw new Error(
			`Corrupt LUT data: expected ${expected} bytes, got ${pixels.length}`,
		);
	}
	return {
		name: payload.name,
		size: payload.size,
		width: payload.width,
		height: payload.height,
		domainMin: payload.domainMin,
		domainMax: payload.domainMax,
		pixels,
	};
}

/**
 * Convenience: parse `.cube` text and return the param string plus display name.
 */
export function cubeTextToLutParam({
	text,
	fileName,
}: {
	text: string;
	fileName: string;
}): { serialized: string; name: string } {
	const lut = parseCubeLut({ text });
	const atlas = bakeLutAtlas({ lut });
	const name = lut.title || fileName.replace(/\.cube$/i, "");
	return { serialized: serializeLut({ atlas, name }), name };
}

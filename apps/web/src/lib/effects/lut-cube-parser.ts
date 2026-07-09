/**
 * Parser for Adobe/Iridas `.cube` 3D LUT files.
 *
 * The format is intentionally simple:
 *   TITLE "My Look"                (optional)
 *   LUT_3D_SIZE 33                 (required — the LUT is size^3 RGB triples)
 *   DOMAIN_MIN 0.0 0.0 0.0         (optional, defaults to 0)
 *   DOMAIN_MAX 1.0 1.0 1.0         (optional, defaults to 1)
 *   # comment lines start with '#' and blank lines are ignored
 *   r g b                          (size^3 data rows, red fastest-varying)
 *   ...
 *
 * Reference: the Adobe .cube spec (public, widely documented format) — this
 * parser is written from that spec, not ported from any third-party codebase.
 */

export interface Cube3DLut {
	/** Grid resolution per axis — the LUT holds size^3 RGB triples. */
	size: number;
	/**
	 * RGB triples in file order (red fastest-varying, then green, then blue),
	 * normalized into [0,1] using DOMAIN_MIN/DOMAIN_MAX. Length = size^3 * 3.
	 */
	data: Float32Array;
	title?: string;
}

const MIN_LUT_SIZE = 2;
const MAX_LUT_SIZE = 128;

/** Parses `.cube` file text into a `Cube3DLut`. Throws on malformed input. */
export function parseCubeLut(text: string): Cube3DLut {
	let size = 0;
	let domainMin: [number, number, number] = [0, 0, 0];
	let domainMax: [number, number, number] = [1, 1, 1];
	let title: string | undefined;
	const values: number[] = [];

	const lines = text.split(/\r?\n/);
	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;

		if (line.startsWith("TITLE")) {
			const match = line.match(/^TITLE\s+"(.*)"$/);
			title = match?.[1];
			continue;
		}
		if (line.startsWith("LUT_3D_SIZE")) {
			const parts = line.split(/\s+/);
			size = Number.parseInt(parts[1], 10);
			continue;
		}
		if (line.startsWith("LUT_1D_SIZE")) {
			throw new Error("Invalid .cube file: 1D LUTs are not supported, only 3D LUTs (LUT_3D_SIZE)");
		}
		if (line.startsWith("DOMAIN_MIN")) {
			const [, ...nums] = line.split(/\s+/).map(Number);
			if (nums.length >= 3) domainMin = [nums[0], nums[1], nums[2]];
			continue;
		}
		if (line.startsWith("DOMAIN_MAX")) {
			const [, ...nums] = line.split(/\s+/).map(Number);
			if (nums.length >= 3) domainMax = [nums[0], nums[1], nums[2]];
			continue;
		}
		// Any other non-empty, non-comment line is expected to be a "r g b" data row.
		const parts = line.split(/\s+/).map(Number);
		if (parts.length >= 3 && parts.slice(0, 3).every((n) => !Number.isNaN(n))) {
			values.push(parts[0], parts[1], parts[2]);
		}
	}

	if (!Number.isFinite(size) || size < MIN_LUT_SIZE || size > MAX_LUT_SIZE) {
		throw new Error(`Invalid .cube file: missing or out-of-range LUT_3D_SIZE (got ${size})`);
	}

	const expectedValues = size * size * size * 3;
	if (values.length !== expectedValues) {
		throw new Error(
			`Invalid .cube file: expected ${expectedValues} RGB values for LUT_3D_SIZE ${size}, found ${values.length}`,
		);
	}

	const range: [number, number, number] = [
		domainMax[0] - domainMin[0],
		domainMax[1] - domainMin[1],
		domainMax[2] - domainMin[2],
	];

	const data = new Float32Array(expectedValues);
	for (let i = 0; i < size * size * size; i++) {
		for (let c = 0; c < 3; c++) {
			const raw = values[i * 3 + c];
			const normalized = range[c] !== 0 ? (raw - domainMin[c]) / range[c] : raw;
			data[i * 3 + c] = Math.min(1, Math.max(0, normalized));
		}
	}

	return { size, data, title };
}

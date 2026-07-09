/**
 * Color-scopes measurement engine.
 *
 * Framework-free, dependency-free, and unit-testable. Every entry point takes
 * raw RGBA pixel data (`Uint8ClampedArray` + width/height, e.g. from a 2D
 * canvas `getImageData()`) and returns plain typed-array results the UI layer
 * can draw with Canvas2D, or summary statistics the auto color-correction
 * pipeline uses to derive real `color-adjust` params.
 *
 * All functions downsample via a configurable pixel `stride` (sample every Nth
 * pixel) so callers can trade accuracy for speed when sampling a live preview.
 *
 * Luma coefficients match the `color-adjust` shader (Rec. 709):
 *   Y = 0.2126 R + 0.7152 G + 0.0722 B
 */

export const LUMA_R = 0.2126;
export const LUMA_G = 0.7152;
export const LUMA_B = 0.0722;

/** RGBA pixel source shared by every scope function. */
export interface PixelSource {
	/** RGBA bytes, length === width * height * 4. */
	data: Uint8ClampedArray;
	width: number;
	height: number;
	/**
	 * Sample every Nth pixel (>= 1). A stride of 1 reads every pixel; higher
	 * values are cheaper. Defaults to 1 (input is expected to be pre-downsampled).
	 */
	stride?: number;
}

// --------------------------------------------------------------------------
// Histograms
// --------------------------------------------------------------------------

export interface ChannelHistograms {
	/** 256-bin counts for each channel. */
	r: Uint32Array;
	g: Uint32Array;
	b: Uint32Array;
	luma: Uint32Array;
	/** Number of pixels actually sampled (after stride). */
	sampleCount: number;
	/** Largest single-bin count across R/G/B (for normalizing a draw). */
	maxRgbBin: number;
	/** Largest single-bin count in the luma histogram. */
	maxLumaBin: number;
}

function clampStride(stride: number | undefined): number {
	if (!stride || stride < 1 || !Number.isFinite(stride)) return 1;
	return Math.floor(stride);
}

/** Compute per-channel (R, G, B, luma) 256-bin histograms. */
export function computeHistograms({
	data,
	width,
	height,
	stride,
}: PixelSource): ChannelHistograms {
	const r = new Uint32Array(256);
	const g = new Uint32Array(256);
	const b = new Uint32Array(256);
	const luma = new Uint32Array(256);

	const pixelStride = clampStride(stride);
	const step = pixelStride * 4;
	const total = width * height * 4;
	let sampleCount = 0;

	for (let i = 0; i < total; i += step) {
		const rv = data[i];
		const gv = data[i + 1];
		const bv = data[i + 2];
		r[rv]++;
		g[gv]++;
		b[bv]++;
		// Round to nearest bin; matches the shader's luma weighting.
		const y = (LUMA_R * rv + LUMA_G * gv + LUMA_B * bv + 0.5) | 0;
		luma[y < 0 ? 0 : y > 255 ? 255 : y]++;
		sampleCount++;
	}

	let maxRgbBin = 0;
	let maxLumaBin = 0;
	for (let bin = 0; bin < 256; bin++) {
		if (r[bin] > maxRgbBin) maxRgbBin = r[bin];
		if (g[bin] > maxRgbBin) maxRgbBin = g[bin];
		if (b[bin] > maxRgbBin) maxRgbBin = b[bin];
		if (luma[bin] > maxLumaBin) maxLumaBin = luma[bin];
	}

	return { r, g, b, luma, sampleCount, maxRgbBin, maxLumaBin };
}

// --------------------------------------------------------------------------
// Summary statistics (drive auto color-correction)
// --------------------------------------------------------------------------

export interface ChannelStats {
	/** First / last non-empty bin, normalized 0..1. */
	min: number;
	max: number;
	/** Intensity-weighted mean, normalized 0..1. */
	mean: number;
	/** Median (50th percentile), normalized 0..1. */
	median: number;
	/** 1st-percentile black point, normalized 0..1. */
	blackPoint: number;
	/** 99th-percentile white point, normalized 0..1. */
	whitePoint: number;
	/** Fraction of samples fully crushed (bin 0), 0..1. */
	clipLow: number;
	/** Fraction of samples fully blown (bin 255), 0..1. */
	clipHigh: number;
}

/** Derive per-channel statistics from a single 256-bin histogram. */
export function summarizeHistogram({
	histogram,
	sampleCount,
}: {
	histogram: Uint32Array;
	sampleCount: number;
}): ChannelStats {
	if (sampleCount <= 0) {
		return {
			min: 0,
			max: 0,
			mean: 0,
			median: 0,
			blackPoint: 0,
			whitePoint: 0,
			clipLow: 0,
			clipHigh: 0,
		};
	}

	let min = -1;
	let max = 0;
	let weighted = 0;
	for (let bin = 0; bin < 256; bin++) {
		const count = histogram[bin];
		if (count === 0) continue;
		if (min < 0) min = bin;
		max = bin;
		weighted += bin * count;
	}
	if (min < 0) min = 0;

	const percentile = (p: number): number => {
		const threshold = sampleCount * p;
		let cumulative = 0;
		for (let bin = 0; bin < 256; bin++) {
			cumulative += histogram[bin];
			if (cumulative >= threshold) return bin;
		}
		return 255;
	};

	return {
		min: min / 255,
		max: max / 255,
		mean: weighted / sampleCount / 255,
		median: percentile(0.5) / 255,
		blackPoint: percentile(0.01) / 255,
		whitePoint: percentile(0.99) / 255,
		clipLow: histogram[0] / sampleCount,
		clipHigh: histogram[255] / sampleCount,
	};
}

export interface ScopeSummary {
	r: ChannelStats;
	g: ChannelStats;
	b: ChannelStats;
	luma: ChannelStats;
	/**
	 * White-balance temperature estimate: normalized (blueMean - redMean),
	 * roughly -1 (warm cast) .. +1 (cool/blue cast). Positive means the frame
	 * leans blue and wants warming.
	 */
	temperatureEstimate: number;
	/**
	 * Green/magenta tint estimate: normalized (greenMean - (redMean+blueMean)/2),
	 * positive means a green cast that wants magenta correction.
	 */
	tintEstimate: number;
	sampleCount: number;
}

/** Compute the full summary-statistics bundle used by auto color-correction. */
export function computeScopeSummary(source: PixelSource): ScopeSummary {
	const histograms = computeHistograms(source);
	const { sampleCount } = histograms;
	const r = summarizeHistogram({ histogram: histograms.r, sampleCount });
	const g = summarizeHistogram({ histogram: histograms.g, sampleCount });
	const b = summarizeHistogram({ histogram: histograms.b, sampleCount });
	const luma = summarizeHistogram({ histogram: histograms.luma, sampleCount });

	return {
		r,
		g,
		b,
		luma,
		temperatureEstimate: b.mean - r.mean,
		tintEstimate: g.mean - (r.mean + b.mean) / 2,
		sampleCount,
	};
}

// --------------------------------------------------------------------------
// Waveform (x = column, y = brightness) — luma + RGB parade
// --------------------------------------------------------------------------

export interface Waveform {
	/** Output column count (image is bucketed into this many columns). */
	columns: number;
	/** Vertical resolution (intensity levels, 0 = bottom/black .. levels-1 = top/white). */
	levels: number;
	/** Density map, indexed `column * levels + level`. */
	luma: Uint32Array;
	r: Uint32Array;
	g: Uint32Array;
	b: Uint32Array;
	/** Peak density across all four maps (for normalizing brightness on draw). */
	max: number;
}

/**
 * Build a classic vertical waveform: for each sampled pixel, the column bucket
 * (image x) accumulates a count at the row matching the pixel's intensity.
 * Produces a luma waveform plus per-channel R/G/B parade maps.
 */
export function computeWaveform({
	data,
	width,
	height,
	stride,
	columns = Math.min(width, 256),
	levels = 256,
}: PixelSource & { columns?: number; levels?: number }): Waveform {
	const outCols = Math.max(1, columns);
	const outLevels = Math.max(2, levels);
	const luma = new Uint32Array(outCols * outLevels);
	const r = new Uint32Array(outCols * outLevels);
	const g = new Uint32Array(outCols * outLevels);
	const b = new Uint32Array(outCols * outLevels);

	const pixelStride = clampStride(stride);
	const levelScale = (outLevels - 1) / 255;
	const colScale = outCols / width;

	for (let y = 0; y < height; y += pixelStride) {
		const rowOffset = y * width * 4;
		for (let x = 0; x < width; x += pixelStride) {
			const i = rowOffset + x * 4;
			const rv = data[i];
			const gv = data[i + 1];
			const bv = data[i + 2];
			const col = Math.min(outCols - 1, (x * colScale) | 0);
			const base = col * outLevels;
			const yv = LUMA_R * rv + LUMA_G * gv + LUMA_B * bv;
			luma[base + ((yv * levelScale + 0.5) | 0)]++;
			r[base + ((rv * levelScale + 0.5) | 0)]++;
			g[base + ((gv * levelScale + 0.5) | 0)]++;
			b[base + ((bv * levelScale + 0.5) | 0)]++;
		}
	}

	let max = 0;
	for (let i = 0; i < luma.length; i++) {
		if (luma[i] > max) max = luma[i];
		if (r[i] > max) max = r[i];
		if (g[i] > max) max = g[i];
		if (b[i] > max) max = b[i];
	}

	return { columns: outCols, levels: outLevels, luma, r, g, b, max };
}

// --------------------------------------------------------------------------
// Vectorscope (chroma density on the Cb/Cr plane)
// --------------------------------------------------------------------------

export interface VectorscopeTarget {
	label: string;
	/** Normalized plot position, 0..1 on each axis (0.5,0.5 = neutral center). */
	x: number;
	y: number;
	/** Hue angle in radians (atan2), for drawing graticule spokes. */
	angle: number;
	/** Distance from center, 0..~0.5. */
	radius: number;
}

export interface Vectorscope {
	/** Square density-map edge length in cells. */
	size: number;
	/** Density map, indexed `row * size + col`; center is neutral gray. */
	density: Uint32Array;
	/** Peak density (for normalizing brightness on draw). */
	max: number;
	/** Standard 75%-bar color targets for the graticule overlay. */
	targets: VectorscopeTarget[];
	sampleCount: number;
}

/** BT.709 Cb/Cr for a normalized (0..1) RGB triple. Returns values in -0.5..0.5. */
function rgbToCbCr(
	rN: number,
	gN: number,
	bN: number,
): { cb: number; cr: number } {
	const y = LUMA_R * rN + LUMA_G * gN + LUMA_B * bN;
	const cb = (0.5 * (bN - y)) / (1 - LUMA_B);
	const cr = (0.5 * (rN - y)) / (1 - LUMA_R);
	return { cb, cr };
}

function makeTarget(
	label: string,
	rN: number,
	gN: number,
	bN: number,
): VectorscopeTarget {
	const { cb, cr } = rgbToCbCr(rN, gN, bN);
	// Plot: +Cb → right, +Cr → up (screen y grows downward, so subtract).
	const x = 0.5 + cb;
	const y = 0.5 - cr;
	return {
		label,
		x,
		y,
		angle: Math.atan2(cr, cb),
		radius: Math.hypot(cb, cr),
	};
}

// 75% color-bar primaries/secondaries — the broadcast vectorscope graticule.
const BAR = 0.75;
export const VECTORSCOPE_TARGETS: VectorscopeTarget[] = [
	makeTarget("R", BAR, 0, 0),
	makeTarget("Yl", BAR, BAR, 0),
	makeTarget("G", 0, BAR, 0),
	makeTarget("Cy", 0, BAR, BAR),
	makeTarget("B", 0, 0, BAR),
	makeTarget("Mg", BAR, 0, BAR),
];

/**
 * Accumulate a chroma-density map on the Cb/Cr plane. Neutral (gray) pixels
 * land at the center; saturated pixels push toward their hue's target.
 */
export function computeVectorscope({
	data,
	width,
	height,
	stride,
	size = 256,
}: PixelSource & { size?: number }): Vectorscope {
	const edge = Math.max(16, size);
	const density = new Uint32Array(edge * edge);
	const pixelStride = clampStride(stride);
	const step = pixelStride * 4;
	const total = width * height * 4;
	let sampleCount = 0;

	for (let i = 0; i < total; i += step) {
		const rN = data[i] / 255;
		const gN = data[i + 1] / 255;
		const bN = data[i + 2] / 255;
		const { cb, cr } = rgbToCbCr(rN, gN, bN);
		// Map -0.5..0.5 → 0..edge-1.
		let col = ((0.5 + cb) * (edge - 1) + 0.5) | 0;
		let row = ((0.5 - cr) * (edge - 1) + 0.5) | 0;
		if (col < 0) col = 0;
		else if (col >= edge) col = edge - 1;
		if (row < 0) row = 0;
		else if (row >= edge) row = edge - 1;
		density[row * edge + col]++;
		sampleCount++;
	}

	let max = 0;
	for (let i = 0; i < density.length; i++) {
		if (density[i] > max) max = density[i];
	}

	return {
		size: edge,
		density,
		max,
		targets: VECTORSCOPE_TARGETS,
		sampleCount,
	};
}

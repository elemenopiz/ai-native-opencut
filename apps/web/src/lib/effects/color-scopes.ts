/**
 * Real Canvas2D color measurement engine.
 *
 * Downsamples a video/image frame to a small canvas, reads it back with
 * `getImageData`, and computes the statistics auto color-correction needs:
 * per-channel percentile black/white points, shadow/highlight clip %, a luma
 * histogram, per-zone (shadow/mid/highlight) mean RGB, warm/cool + green/
 * magenta balance, mean saturation, and a hue histogram.
 *
 * This is our own implementation built from standard color-science building
 * blocks (percentile levels, zone means, a simple channel-balance metric) —
 * it is not derived from, or a port of, any third-party engine.
 */

export interface RgbColor {
	r: number;
	g: number;
	b: number;
}

export interface ColorZoneMeans {
	shadows: RgbColor;
	midtones: RgbColor;
	highlights: RgbColor;
}

export interface ColorMeasurement {
	/** Number of (non-transparent) pixels sampled. */
	sampleCount: number;
	/** Per-channel low-percentile value in [0,1] — used as the black point. */
	blackPoint: RgbColor;
	/** Per-channel high-percentile value in [0,1] — used as the white point. */
	whitePoint: RgbColor;
	/** % of sampled pixels with luma at/near 0 (crushed shadows). */
	clippedShadowPct: number;
	/** % of sampled pixels with luma at/near 255 (blown highlights). */
	clippedHighlightPct: number;
	/** 256-bucket luma histogram, normalized 0..1 against its tallest bucket. */
	lumaHistogram: number[];
	/** Mean RGB (0..1) within the shadow / midtone / highlight luma bands. */
	zones: ColorZoneMeans;
	/** Positive => warmer/redder cast, negative => cooler/bluer cast. Roughly [-1, 1]. */
	warmCoolBalance: number;
	/** Positive => greener cast, negative => magenta cast. Roughly [-1, 1]. */
	greenMagentaBalance: number;
	/** Mean HSL saturation across sampled pixels, in [0,1]. */
	meanSaturation: number;
	/** Hue histogram (`hueBucketCount` buckets spanning 0-360deg), normalized 0..1. */
	hueHistogram: number[];
}

export interface MeasureColorOptions {
	/** Longest-side cap (px) for the downsample used to measure. Default 160. */
	maxSampleDimension?: number;
	/** Number of hue histogram buckets. Default 24 (15deg each). */
	hueBucketCount?: number;
	/** [low, high] percentile used for black/white point estimation. Default [2, 98]. */
	percentiles?: [number, number];
}

interface ResolvedMeasureColorOptions {
	maxSampleDimension: number;
	hueBucketCount: number;
	percentiles: [number, number];
}

const DEFAULT_OPTIONS: ResolvedMeasureColorOptions = {
	maxSampleDimension: 160,
	hueBucketCount: 24,
	percentiles: [2, 98],
};

const SHADOW_LUMA_MAX = 85;
const HIGHLIGHT_LUMA_MIN = 170;
const CLIP_LUMA_MARGIN = 2;

function rgbToHueSaturation(r: number, g: number, b: number): { h: number; s: number } {
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const l = (max + min) / 2;
	if (max === min) return { h: 0, s: 0 };

	const d = max - min;
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

	let h: number;
	if (max === r) {
		h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
	} else if (max === g) {
		h = ((b - r) / d + 2) * 60;
	} else {
		h = ((r - g) / d + 4) * 60;
	}
	return { h, s };
}

/** Finds the value (normalized 0..1) at `percentile` in a 256-bucket histogram. */
function percentileFromHistogram({
	histogram,
	total,
	percentile,
}: {
	histogram: Uint32Array;
	total: number;
	percentile: number;
}): number {
	if (total <= 0) return percentile <= 50 ? 0 : 1;
	const target = (percentile / 100) * total;
	let cumulative = 0;
	for (let bin = 0; bin < histogram.length; bin++) {
		cumulative += histogram[bin];
		if (cumulative >= target) {
			return bin / (histogram.length - 1);
		}
	}
	return 1;
}

/**
 * Downsamples `source` onto an offscreen canvas and reads back its pixels.
 * Capped to `maxDimension` on the longest side so measurement stays fast
 * regardless of source resolution.
 */
export function sampleFrameToImageData({
	source,
	sourceWidth,
	sourceHeight,
	maxDimension = DEFAULT_OPTIONS.maxSampleDimension,
}: {
	source: CanvasImageSource;
	sourceWidth: number;
	sourceHeight: number;
	maxDimension?: number;
}): ImageData {
	if (sourceWidth <= 0 || sourceHeight <= 0) {
		throw new Error("sampleFrameToImageData: invalid source dimensions");
	}

	const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
	const width = Math.max(1, Math.round(sourceWidth * scale));
	const height = Math.max(1, Math.round(sourceHeight * scale));

	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	if (!ctx) {
		throw new Error("sampleFrameToImageData: 2D canvas context unavailable");
	}
	ctx.drawImage(source, 0, 0, width, height);
	return ctx.getImageData(0, 0, width, height);
}

/**
 * Measures color statistics directly from pixel data. Pure — no DOM/canvas
 * dependency — so it's straightforward to unit test.
 */
export function measureColorFromImageData(
	imageData: ImageData,
	options: MeasureColorOptions = {},
): ColorMeasurement {
	const opts: ResolvedMeasureColorOptions = { ...DEFAULT_OPTIONS, ...options };
	const { data } = imageData;

	const rHist = new Uint32Array(256);
	const gHist = new Uint32Array(256);
	const bHist = new Uint32Array(256);
	const lumaHist = new Uint32Array(256);
	const hueHist = new Float64Array(opts.hueBucketCount);

	const zoneSums = {
		shadows: { r: 0, g: 0, b: 0, count: 0 },
		midtones: { r: 0, g: 0, b: 0, count: 0 },
		highlights: { r: 0, g: 0, b: 0, count: 0 },
	};

	let warmCoolSum = 0;
	let greenMagentaSum = 0;
	let saturationSum = 0;
	let clippedShadow = 0;
	let clippedHighlight = 0;
	let sampled = 0;

	for (let i = 0; i < data.length; i += 4) {
		const alpha = data[i + 3];
		if (alpha < 8) continue; // skip fully/mostly transparent pixels

		const r = data[i];
		const g = data[i + 1];
		const b = data[i + 2];

		rHist[r]++;
		gHist[g]++;
		bHist[b]++;

		const luma = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
		lumaHist[luma]++;

		if (luma <= CLIP_LUMA_MARGIN) clippedShadow++;
		if (luma >= 255 - CLIP_LUMA_MARGIN) clippedHighlight++;

		const zone =
			luma < SHADOW_LUMA_MAX ? zoneSums.shadows : luma < HIGHLIGHT_LUMA_MIN ? zoneSums.midtones : zoneSums.highlights;
		zone.r += r;
		zone.g += g;
		zone.b += b;
		zone.count++;

		warmCoolSum += (r - b) / 255;
		greenMagentaSum += (g - (r + b) / 2) / 255;

		const { h, s } = rgbToHueSaturation(r / 255, g / 255, b / 255);
		saturationSum += s;
		const bucket = Math.min(opts.hueBucketCount - 1, Math.floor((h / 360) * opts.hueBucketCount));
		hueHist[bucket]++;

		sampled++;
	}

	const zoneMean = (zone: { r: number; g: number; b: number; count: number }): RgbColor =>
		zone.count > 0
			? { r: zone.r / zone.count / 255, g: zone.g / zone.count / 255, b: zone.b / zone.count / 255 }
			: { r: 0, g: 0, b: 0 };

	const [lowPct, highPct] = opts.percentiles;
	const blackPoint: RgbColor = {
		r: percentileFromHistogram({ histogram: rHist, total: sampled, percentile: lowPct }),
		g: percentileFromHistogram({ histogram: gHist, total: sampled, percentile: lowPct }),
		b: percentileFromHistogram({ histogram: bHist, total: sampled, percentile: lowPct }),
	};
	const whitePoint: RgbColor = {
		r: percentileFromHistogram({ histogram: rHist, total: sampled, percentile: highPct }),
		g: percentileFromHistogram({ histogram: gHist, total: sampled, percentile: highPct }),
		b: percentileFromHistogram({ histogram: bHist, total: sampled, percentile: highPct }),
	};

	const maxLumaBucket = Math.max(1, ...Array.from(lumaHist));
	const maxHueBucket = Math.max(1, ...Array.from(hueHist));

	return {
		sampleCount: sampled,
		blackPoint,
		whitePoint,
		clippedShadowPct: sampled > 0 ? (clippedShadow / sampled) * 100 : 0,
		clippedHighlightPct: sampled > 0 ? (clippedHighlight / sampled) * 100 : 0,
		lumaHistogram: Array.from(lumaHist, (count) => count / maxLumaBucket),
		zones: {
			shadows: zoneMean(zoneSums.shadows),
			midtones: zoneMean(zoneSums.midtones),
			highlights: zoneMean(zoneSums.highlights),
		},
		warmCoolBalance: sampled > 0 ? warmCoolSum / sampled : 0,
		greenMagentaBalance: sampled > 0 ? greenMagentaSum / sampled : 0,
		meanSaturation: sampled > 0 ? saturationSum / sampled : 0,
		hueHistogram: Array.from(hueHist, (count) => count / maxHueBucket),
	};
}

/** Convenience wrapper: downsamples `source` and measures it in one call. */
export function measureColor({
	source,
	sourceWidth,
	sourceHeight,
	options,
}: {
	source: CanvasImageSource;
	sourceWidth: number;
	sourceHeight: number;
	options?: MeasureColorOptions;
}): ColorMeasurement {
	const imageData = sampleFrameToImageData({
		source,
		sourceWidth,
		sourceHeight,
		maxDimension: options?.maxSampleDimension,
	});
	return measureColorFromImageData(imageData, options);
}

export interface AutoColorAdjustments {
	brightness: number;
	contrast: number;
	saturation: number;
	temperature: number;
}

/** Valid ranges for the `color-adjust` effect's params (see color-adjust.ts). */
const SHADER_RANGES = {
	brightness: { min: -0.5, max: 0.5 },
	contrast: { min: 0.2, max: 3 },
	saturation: { min: 0, max: 3 },
	temperature: { min: -1, max: 1 },
} as const;

/** A tighter working range used before the final shader-range clamp, so a
 *  single very flat/noisy clip can't swing the correction to an extreme. */
const SATURATION_GAIN_RANGE = { min: 0.4, max: 2.2 };
const TARGET_MEAN_SATURATION = 0.45;

function clampRange(value: number, range: { min: number; max: number }): number {
	return Math.min(range.max, Math.max(range.min, value));
}

/**
 * Derives `color-adjust` effect params directly from measured statistics —
 * this is the real "auto" in auto color-correction:
 *
 *  - contrast/brightness stretch the measured luma black/white points so the
 *    2nd percentile maps to ~0 and the 98th percentile maps to ~1, matching
 *    the shader's own order of operations: `(rgb + brightness - 0.5) * contrast + 0.5`.
 *  - temperature neutralizes the measured warm/cool (R vs B) cast.
 *  - saturation is nudged toward a healthy target based on measured mean
 *    HSL saturation (boosts flat/washed-out footage, tones down oversaturated).
 *
 * The `color-adjust` effect has no green/magenta (tint) control, so
 * `greenMagentaBalance` is measured but intentionally not applied here.
 * Vignette is left untouched — it's a framing choice, not a color-cast fix.
 */
export function deriveAutoColorAdjustments(measurement: ColorMeasurement): AutoColorAdjustments {
	const lumaBlack =
		0.2126 * measurement.blackPoint.r + 0.7152 * measurement.blackPoint.g + 0.0722 * measurement.blackPoint.b;
	const lumaWhite =
		0.2126 * measurement.whitePoint.r + 0.7152 * measurement.whitePoint.g + 0.0722 * measurement.whitePoint.b;

	const spread = Math.max(0.05, lumaWhite - lumaBlack);
	const contrast = clampRange(1 / spread, SHADER_RANGES.contrast);

	// Solve for the brightness that maps lumaBlack -> 0 at the chosen contrast.
	const brightness = clampRange(0.5 - lumaBlack - 0.5 / contrast, SHADER_RANGES.brightness);

	// Shader applies rgb.r += temperature*0.1; rgb.b -= temperature*0.1 — a
	// 0.2*temperature difference between R and B. Solve for the temperature
	// that cancels the measured (R - B) difference.
	const temperature = clampRange(-measurement.warmCoolBalance / 0.2, SHADER_RANGES.temperature);

	const saturationGain = TARGET_MEAN_SATURATION / Math.max(0.05, measurement.meanSaturation);
	const saturation = clampRange(clampRange(saturationGain, SATURATION_GAIN_RANGE), SHADER_RANGES.saturation);

	return { brightness, contrast, saturation, temperature };
}

// Median-cut color quantization: reduces an RGBA frame to a palette of at
// most `maxColors` RGB entries plus one palette-index byte per pixel.
//
// Clean-room implementation of the classic median-cut algorithm (Paul
// Heckbert, "Color Image Quantization for Frame Buffer Display", 1982) —
// written from the general algorithm description, not from any existing
// GIF encoder's source.
//
// ALPHA POLICY (documented per task contract): alpha is ignored entirely.
// Every pixel is treated as "fully composited" — its RGB channels are
// quantized as-is regardless of the alpha value. This is the right choice
// for this module's actual inputs (canvas/video frame snapshots, which are
// already opaque in practice) and it avoids introducing artificial black
// pixels for frames that happen to carry semi-transparent alpha. Callers
// that truly need transparency compositing should pre-composite onto a
// background before calling addFrame.
//
// DITHERING POLICY (documented per task contract): none. Each pixel is
// assigned to the palette entry of the median-cut bucket its exact color
// falls into (the bucket's population-weighted average color). Because
// median-cut buckets are built to be small in color-space extent, bucket
// membership already approximates "nearest palette color" without an
// additional exhaustive nearest-neighbor search. This keeps quantization
// O(pixels) rather than O(pixels * paletteSize) and is fine for
// short-lived timeline-export GIFs; a perceptual disadvantage vs. ordered
// dithering is banding on smooth gradients, traded for speed and
// determinism.

export interface QuantizeResult {
	/** RGB palette entries, 1..maxColors long (never empty, never padded). */
	palette: Array<[number, number, number]>;
	/** One palette index per pixel, row-major, length = width * height. */
	indices: Uint8Array;
}

interface WeightedColor {
	r: number;
	g: number;
	b: number;
	count: number;
	/** Packed 0xRRGGBB key, used to build the final pixel->index lookup. */
	key: number;
}

interface Bucket {
	colors: WeightedColor[];
	totalCount: number;
}

function packKey(r: number, g: number, b: number): number {
	return (r << 16) | (g << 8) | b;
}

/** Sum of (count * value) for one channel across a bucket's colors. */
function weightedChannelSum(
	colors: WeightedColor[],
	channel: "r" | "g" | "b",
): number {
	let sum = 0;
	for (const c of colors) sum += c[channel] * c.count;
	return sum;
}

function bucketAverageColor(bucket: Bucket): [number, number, number] {
	const r = Math.round(
		weightedChannelSum(bucket.colors, "r") / bucket.totalCount,
	);
	const g = Math.round(
		weightedChannelSum(bucket.colors, "g") / bucket.totalCount,
	);
	const b = Math.round(
		weightedChannelSum(bucket.colors, "b") / bucket.totalCount,
	);
	return [r, g, b];
}

/** Widest channel (max - min) in the bucket, the axis median-cut splits on. */
function widestChannel(colors: WeightedColor[]): "r" | "g" | "b" {
	let minR = 255;
	let maxR = 0;
	let minG = 255;
	let maxG = 0;
	let minB = 255;
	let maxB = 0;
	for (const c of colors) {
		if (c.r < minR) minR = c.r;
		if (c.r > maxR) maxR = c.r;
		if (c.g < minG) minG = c.g;
		if (c.g > maxG) maxG = c.g;
		if (c.b < minB) minB = c.b;
		if (c.b > maxB) maxB = c.b;
	}
	const rangeR = maxR - minR;
	const rangeG = maxG - minG;
	const rangeB = maxB - minB;
	if (rangeR >= rangeG && rangeR >= rangeB) return "r";
	if (rangeG >= rangeB) return "g";
	return "b";
}

/** Splits a bucket in two at its population-weighted median along `channel`. */
function splitBucket(bucket: Bucket): [Bucket, Bucket] {
	const channel = widestChannel(bucket.colors);
	const sorted = [...bucket.colors].sort((a, b) => a[channel] - b[channel]);
	const half = bucket.totalCount / 2;
	let cumulative = 0;
	let splitAt = sorted.length - 1;
	for (let i = 0; i < sorted.length; i++) {
		cumulative += sorted[i].count;
		if (cumulative >= half) {
			splitAt = i;
			break;
		}
	}
	// Guarantee both sides are non-empty even if one color dominates the
	// bucket's population (splitAt landing on the last index).
	const cutIndex = Math.min(Math.max(splitAt, 0), sorted.length - 2);
	const left = sorted.slice(0, cutIndex + 1);
	const right = sorted.slice(cutIndex + 1);
	const sumCount = (arr: WeightedColor[]) =>
		arr.reduce((s, c) => s + c.count, 0);
	return [
		{ colors: left, totalCount: sumCount(left) },
		{ colors: right, totalCount: sumCount(right) },
	];
}

export function medianCutQuantize(
	data: Uint8ClampedArray,
	pixelCount: number,
	maxColors = 256,
): QuantizeResult {
	const clampedMax = Math.max(1, Math.min(256, maxColors));

	// Pass 1: tally unique colors (alpha ignored, see policy note above).
	const uniqueByKey = new Map<number, WeightedColor>();
	for (let i = 0; i < pixelCount; i++) {
		const offset = i * 4;
		const r = data[offset];
		const g = data[offset + 1];
		const b = data[offset + 2];
		const key = packKey(r, g, b);
		const existing = uniqueByKey.get(key);
		if (existing) {
			existing.count++;
		} else {
			uniqueByKey.set(key, { r, g, b, count: 1, key });
		}
	}
	const uniqueColors = Array.from(uniqueByKey.values());

	// Fast path: frame already fits within the palette budget losslessly
	// (e.g. solid-color frames) — skip bucket splitting entirely.
	if (uniqueColors.length <= clampedMax) {
		const palette: Array<[number, number, number]> = uniqueColors.map((c) => [
			c.r,
			c.g,
			c.b,
		]);
		const keyToIndex = new Map<number, number>();
		uniqueColors.forEach((c, idx) => keyToIndex.set(c.key, idx));
		const indices = new Uint8Array(pixelCount);
		for (let i = 0; i < pixelCount; i++) {
			const offset = i * 4;
			const key = packKey(data[offset], data[offset + 1], data[offset + 2]);
			// biome-ignore lint/style/noNonNullAssertion: key was just tallied above
			indices[i] = keyToIndex.get(key)!;
		}
		return { palette, indices };
	}

	// Pass 2: median-cut split until we have `clampedMax` buckets (or no
	// bucket can be split any further, i.e. every bucket is a single color).
	const buckets: Bucket[] = [{ colors: uniqueColors, totalCount: pixelCount }];
	while (buckets.length < clampedMax) {
		let splitIndex = -1;
		let splitScore = -1;
		for (let i = 0; i < buckets.length; i++) {
			if (buckets[i].colors.length <= 1) continue;
			// Prefer splitting the highest-population bucket first — keeps
			// visually dominant colors well represented in the palette.
			if (buckets[i].totalCount > splitScore) {
				splitScore = buckets[i].totalCount;
				splitIndex = i;
			}
		}
		if (splitIndex === -1) break; // every bucket is down to one color
		const [left, right] = splitBucket(buckets[splitIndex]);
		buckets.splice(splitIndex, 1, left, right);
	}

	const palette: Array<[number, number, number]> =
		buckets.map(bucketAverageColor);
	const keyToIndex = new Map<number, number>();
	buckets.forEach((bucket, idx) => {
		for (const c of bucket.colors) keyToIndex.set(c.key, idx);
	});

	const indices = new Uint8Array(pixelCount);
	for (let i = 0; i < pixelCount; i++) {
		const offset = i * 4;
		const key = packKey(data[offset], data[offset + 1], data[offset + 2]);
		// biome-ignore lint/style/noNonNullAssertion: every unique color was assigned to exactly one bucket above
		indices[i] = keyToIndex.get(key)!;
	}

	return { palette, indices };
}

/**
 * Frame-sampling browser adapter for the visual derivations (shot changes,
 * motion energy, head/tail black-bars).
 *
 * Uses the SAME technique as the CLIP embedding indexer's frame sampler
 * (`services/search/embedding-service.ts`'s `sampleVideoFrames`: an
 * `HTMLVideoElement` seeked to fixed timestamps + a 2D canvas read) rather
 * than inventing a second decode path — but this module is NOT that one
 * wired together, because `embedding-service.ts` / `use-embedding-indexer.ts`
 * are owned by another workstream. This is ONE pass per asset that computes
 * everything all three visual derivations need (luma histogram, vertical
 * strip means, horizontal band means) in a single seek-and-read per sampled
 * timestamp — see `visual-analysis.ts` for the orchestration.
 *
 * Deliberately sampled at ~1 sample/sec (matches the storage-discipline
 * requirement for the motion-energy timeseries) and at a tiny analysis
 * resolution (ANALYSIS_WIDTH px wide) — cheap enough that a 1-hour video is
 * ~3600 canvas reads of a few hundred bytes each, not 3600 JPEG encodes.
 */

import {
	LUMA_HISTOGRAM_BUCKETS,
	STRIP_COUNT,
	type FrameSample,
} from "./frame-sample-types";

/** Sampling cadence in seconds — ~1 Hz, per the storage-discipline requirement. */
export const SAMPLE_INTERVAL_SEC = 1;
/** Hard ceiling on sampled frames regardless of media length (caps a multi-hour file's pass). */
export const MAX_SAMPLES = 3600;
/** Analysis frame width in px — only luma statistics are needed, so this stays tiny. */
const ANALYSIS_WIDTH = 64;

function computeFrameSample(
	imageData: Uint8ClampedArray,
	width: number,
	height: number,
	timestampSec: number,
): FrameSample {
	const histogram = new Array(LUMA_HISTOGRAM_BUCKETS).fill(0);
	const stripSums = new Array(STRIP_COUNT).fill(0);
	const stripCounts = new Array(STRIP_COUNT).fill(0);
	const bandSums = [0, 0, 0];
	const bandCounts = [0, 0, 0];

	let lumaSum = 0;
	const pixelCount = width * height;
	const bucketWidth = 256 / LUMA_HISTOGRAM_BUCKETS;

	for (let y = 0; y < height; y++) {
		const band = y < height / 3 ? 0 : y < (height * 2) / 3 ? 1 : 2;
		for (let x = 0; x < width; x++) {
			const idx = (y * width + x) * 4;
			// Rec. 601 luma from RGB (ignore alpha — canvas frames are opaque here).
			const luma =
				0.299 * imageData[idx] +
				0.587 * imageData[idx + 1] +
				0.114 * imageData[idx + 2];
			lumaSum += luma;

			const bucket = Math.min(
				LUMA_HISTOGRAM_BUCKETS - 1,
				Math.floor(luma / bucketWidth),
			);
			histogram[bucket]++;

			const strip = Math.min(
				STRIP_COUNT - 1,
				Math.floor((x / width) * STRIP_COUNT),
			);
			stripSums[strip] += luma;
			stripCounts[strip]++;

			bandSums[band] += luma;
			bandCounts[band]++;
		}
	}

	return {
		timestampSec,
		meanLuma: pixelCount > 0 ? lumaSum / pixelCount : 0,
		lumaHistogram: histogram.map((count) =>
			pixelCount > 0 ? count / pixelCount : 0,
		),
		stripMeans: stripSums.map((sum, i) =>
			stripCounts[i] > 0 ? sum / stripCounts[i] : 0,
		),
		bandMeans: bandSums.map((sum, i) =>
			bandCounts[i] > 0 ? sum / bandCounts[i] : 0,
		) as [number, number, number],
	};
}

/**
 * Sample a video URL at a fixed cadence and compute a compact `FrameSample`
 * per timestamp. Mirrors `embedding-service.ts`'s `sampleVideoFrames` seek
 * loop (video.currentTime → onseeked → canvas draw), swapping the JPEG
 * blob output for the in-memory luma statistics the visual derivations need.
 */
export async function sampleVideoFrameStats(
	url: string,
	options?: { intervalSec?: number; maxSamples?: number },
): Promise<FrameSample[]> {
	const intervalSec = options?.intervalSec ?? SAMPLE_INTERVAL_SEC;
	const maxSamples = options?.maxSamples ?? MAX_SAMPLES;

	return new Promise((resolve, reject) => {
		const video = document.createElement("video");
		video.crossOrigin = "anonymous";
		video.muted = true;
		video.preload = "auto";

		const timeout = setTimeout(() => {
			video.src = "";
			reject(new Error("frame sampling timed out"));
		}, 60_000);

		const samples: FrameSample[] = [];

		video.onloadedmetadata = () => {
			const duration = video.duration;
			if (!duration || !Number.isFinite(duration)) {
				clearTimeout(timeout);
				reject(new Error("video duration unavailable"));
				return;
			}
			const step = Math.max(intervalSec, duration / maxSamples);
			const timestamps: number[] = [];
			for (let t = 0; t < duration; t += step) {
				timestamps.push(t);
				if (timestamps.length >= maxSamples) break;
			}
			if (timestamps.length === 0) timestamps.push(0);

			const canvas = document.createElement("canvas");
			const ratio = video.videoHeight / video.videoWidth || 9 / 16;
			canvas.width = ANALYSIS_WIDTH;
			canvas.height = Math.max(1, Math.round(ANALYSIS_WIDTH * ratio));
			const ctx = canvas.getContext("2d", { willReadFrequently: true });
			if (!ctx) {
				clearTimeout(timeout);
				reject(new Error("canvas 2D context unavailable"));
				return;
			}

			const captureNext = (idx: number) => {
				if (idx >= timestamps.length) {
					clearTimeout(timeout);
					resolve(samples);
					return;
				}
				video.currentTime = timestamps[idx];
			};

			video.onseeked = () => {
				try {
					ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
					const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
					samples.push(
						computeFrameSample(
							data,
							canvas.width,
							canvas.height,
							video.currentTime,
						),
					);
				} catch (err) {
					clearTimeout(timeout);
					reject(err instanceof Error ? err : new Error("frame read failed"));
					return;
				}
				captureNext(samples.length);
			};

			captureNext(0);
		};

		video.onerror = () => {
			clearTimeout(timeout);
			reject(new Error("video element failed to load"));
		};

		video.src = url;
	});
}

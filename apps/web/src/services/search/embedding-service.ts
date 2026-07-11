/**
 * Frame sampler + embedding orchestrator.
 *
 * Given a video/image MediaAsset, samples N frames using the same HTML video
 * element + canvas approach as `use-filmstrip.ts` (no WebCodecs dependency),
 * batches them through the embedding seam (`embeddings`, currently backed by
 * the in-browser CLIP worker), and persists L2-normalized vectors to the
 * IndexedDB embedding store.
 *
 * Nothing here touches the network: frames are embedded on-device (the CLIP
 * worker only downloads model weights, once) and vectors live entirely in
 * IndexedDB, keeping the privacy-first promise intact.
 *
 * Callers of `embeddings.embedImages` should pre-downscale blobs to ~224px —
 * CLIP resizes to 224 internally, so anything larger just wastes worker
 * message bandwidth and decode memory. Video frames are sampled at
 * SAMPLE_WIDTH already; image assets are downscaled in `sampleImageFrame`.
 */

import { embeddings, filterToCurrentModel } from "@/lib/local-ai/embeddings";
import {
	getAllEmbeddings,
	getEmbedding,
	saveEmbedding,
	setStatus,
} from "@/services/search/embedding-store";
import {
	DEFAULT_SAMPLE_INTERVAL_SEC,
	DUPLICATE_THRESHOLD,
	type EmbeddingFrame,
	type EmbeddingStatus,
	type IndexingProgress,
	type MediaEmbedding,
	ZERO_SHOT_LABELS,
	type ZeroShotTag,
} from "@/lib/search/embedding-types";
import type { MediaAsset } from "@/types/assets";

/**
 * Max frames per worker batch. The CLIP client serializes requests anyway,
 * but batching bounds the structured-clone message size and keeps progress
 * reporting per-batch instead of one long silent embed.
 */
const BATCH_SIZE = 8;
/** Hard ceiling on sampled frames regardless of media length. */
const MAX_FRAMES = 120;
/** Sampling width in px; CLIP resizes internally so 224 is plenty. */
const SAMPLE_WIDTH = 224;

/** Sample N still frames from a video at a fixed interval. */
async function sampleVideoFrames(
	url: string,
	intervalSec: number,
	maxFrames: number,
	onProgress?: (fraction: number) => void,
): Promise<{ blob: Blob; timestampSec: number }[]> {
	return new Promise((resolve, reject) => {
		const video = document.createElement("video");
		video.crossOrigin = "anonymous";
		video.muted = true;
		video.preload = "auto";

		const timeout = setTimeout(() => {
			video.src = "";
			reject(new Error("frame sampling timed out"));
		}, 30_000);

		const frames: { blob: Blob; timestampSec: number }[] = [];

		video.onloadedmetadata = () => {
			const duration = video.duration;
			if (!duration || !Number.isFinite(duration)) {
				clearTimeout(timeout);
				reject(new Error("video duration unavailable"));
				return;
			}
			const step = Math.max(intervalSec, duration / maxFrames);
			const timestamps: number[] = [];
			for (let t = step * 0.5; t < duration; t += step) {
				timestamps.push(t);
				if (timestamps.length >= maxFrames) break;
			}
			if (timestamps.length === 0) timestamps.push(Math.min(0.1, duration / 2));

			const captureNext = (idx: number) => {
				if (idx >= timestamps.length) {
					clearTimeout(timeout);
					resolve(frames);
					return;
				}
				video.currentTime = timestamps[idx];
			};

			video.onseeked = () => {
				const canvas = document.createElement("canvas");
				const ratio = video.videoHeight / video.videoWidth || 9 / 16;
				canvas.width = SAMPLE_WIDTH;
				canvas.height = Math.round(SAMPLE_WIDTH * ratio);
				const ctx = canvas.getContext("2d");
				if (!ctx) {
					clearTimeout(timeout);
					reject(new Error("canvas 2D context unavailable"));
					return;
				}
				ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
				canvas.toBlob(
					(blob) => {
						if (blob) {
							frames.push({ blob, timestampSec: video.currentTime });
							onProgress?.(frames.length / timestamps.length);
						}
						captureNext(frames.length);
					},
					"image/jpeg",
					0.6,
				);
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

/**
 * Downscale an image blob to SAMPLE_WIDTH before embedding — full-resolution
 * originals would be structured-cloned into the worker just for CLIP to shrink
 * them to 224px anyway. Falls back to the original blob when canvas decoding
 * is unavailable or fails (the worker can decode originals fine, just slower).
 */
async function downscaleImageBlob(blob: Blob): Promise<Blob> {
	if (
		typeof createImageBitmap !== "function" ||
		typeof document === "undefined"
	) {
		return blob;
	}
	try {
		const bitmap = await createImageBitmap(blob);
		try {
			const canvas = document.createElement("canvas");
			const ratio = bitmap.height / bitmap.width || 9 / 16;
			canvas.width = SAMPLE_WIDTH;
			canvas.height = Math.round(SAMPLE_WIDTH * ratio);
			const ctx = canvas.getContext("2d");
			if (!ctx) return blob;
			// White matte first: JPEG has no alpha, and transparent PNGs would
			// otherwise composite to black — further from CLIP's training data.
			ctx.fillStyle = "#fff";
			ctx.fillRect(0, 0, canvas.width, canvas.height);
			ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
			const scaled = await new Promise<Blob | null>((resolve) =>
				canvas.toBlob(resolve, "image/jpeg", 0.6),
			);
			return scaled ?? blob;
		} finally {
			// Free the bitmap's pixel memory on every exit path, throws included.
			bitmap.close();
		}
	} catch {
		return blob;
	}
}

/** Sample a single frame from an image MediaAsset (no seeking needed). */
async function sampleImageFrame(
	url: string,
): Promise<{ blob: Blob; timestampSec: number }> {
	const resp = await fetch(url);
	const blob = await resp.blob();
	return { blob: await downscaleImageBlob(blob), timestampSec: 0 };
}

/**
 * Batch a list of frame blobs through the embedding backend.
 * `onProgress` receives the fraction of frames embedded after each batch.
 * Exported for tests.
 */
export async function embedBatches(
	frames: { blob: Blob; timestampSec: number }[],
	onProgress?: (fraction: number) => void,
): Promise<EmbeddingFrame[]> {
	const out: EmbeddingFrame[] = [];
	for (let i = 0; i < frames.length; i += BATCH_SIZE) {
		const slice = frames.slice(i, i + BATCH_SIZE);
		const vectors = await embeddings.embedImages(slice.map((f) => f.blob));
		for (let j = 0; j < vectors.length; j++) {
			out.push({
				timestampSec: slice[j].timestampSec,
				vector: vectors[j],
			});
		}
		onProgress?.(Math.min(1, (i + slice.length) / frames.length));
	}
	return out;
}

/**
 * Zero-shot label prompt template. CLIP was trained on captions, so "a photo
 * of X" scores markedly better than the bare label word.
 */
function labelPrompt(label: string): string {
	return `a photo of ${label}`;
}

/** How many top-scoring labels to keep as auto-tags. */
const ZERO_SHOT_TOP_K = 5;

let labelVectorsPromise: Promise<Float32Array[]> | null = null;

/**
 * Embed the static ZERO_SHOT_LABELS once per session and reuse the vectors
 * for every asset. On failure the cache is cleared so the next asset retries
 * instead of pinning a rejected promise forever.
 */
function getLabelVectors(): Promise<Float32Array[]> {
	if (!labelVectorsPromise) {
		labelVectorsPromise = embeddings
			.embedTexts(ZERO_SHOT_LABELS.map(labelPrompt))
			.catch((err) => {
				labelVectorsPromise = null;
				throw err;
			});
	}
	return labelVectorsPromise;
}

/**
 * Rank the candidate labels against one frame vector. Both sides are
 * L2-normalized, so a dot product is the cosine similarity.
 */
function zeroShotTagsForFrame(
	frameVector: Float32Array,
	labelVectors: Float32Array[],
): ZeroShotTag[] {
	return labelVectors
		.map((labelVector, i) => {
			let dot = 0;
			for (let k = 0; k < labelVector.length; k++) {
				dot += labelVector[k] * frameVector[k];
			}
			return { label: ZERO_SHOT_LABELS[i], score: dot };
		})
		.sort((a, b) => b.score - a.score)
		.slice(0, ZERO_SHOT_TOP_K);
}

/**
 * Index one media asset for visual search.
 *
 * Steps: mark indexing → sample frames → batch embed → zero-shot tag → persist.
 * Skips assets that can't be sampled (audio, missing URL) and assets that are
 * already indexed for the current model.
 */
export async function indexMedia(
	media: MediaAsset,
	options?: {
		intervalSec?: number;
		onProgress?: (p: IndexingProgress) => void;
		modelName?: string;
	},
): Promise<MediaEmbedding | null> {
	const intervalSec = options?.intervalSec ?? DEFAULT_SAMPLE_INTERVAL_SEC;
	// Defaulting to the active backend's model name invalidates every embedding
	// produced by the retired open_clip backend: its "ViT-B-32" vectors live in
	// a different space than the Xenova/OpenAI weights, so the model-name check
	// below re-indexes those assets instead of ever mixing vector spaces.
	const modelName = options?.modelName ?? embeddings.modelName;
	const report = (p: IndexingProgress) => {
		options?.onProgress?.(p);
		setStatus({
			mediaId: media.id,
			state: "indexing",
			progress: p.progress,
			phase: p.phase,
		} satisfies EmbeddingStatus).catch(() => undefined);
	};

	if (!media.url) {
		const skipped: EmbeddingStatus = {
			mediaId: media.id,
			state: "skipped",
			reason: "no source URL",
		};
		await setStatus(skipped).catch(() => undefined);
		options?.onProgress?.({ mediaId: media.id, phase: "done", progress: 1 });
		return null;
	}

	const existing = await getEmbedding(media.id).catch(() => undefined);
	if (existing && existing.modelName === modelName) {
		options?.onProgress?.({ mediaId: media.id, phase: "done", progress: 1 });
		return existing;
	}

	try {
		report({ mediaId: media.id, phase: "sampling", progress: 0 });
		const isVideo = media.type === "video";
		const sampled = isVideo
			? await sampleVideoFrames(media.url, intervalSec, MAX_FRAMES, (frac) =>
					report({
						mediaId: media.id,
						phase: "sampling",
						progress: frac * 0.4,
					}),
				)
			: media.type === "image"
				? [await sampleImageFrame(media.url)]
				: [];

		if (sampled.length === 0) {
			const skipped: EmbeddingStatus = {
				mediaId: media.id,
				state: "skipped",
				reason: "audio assets are not indexable",
			};
			await setStatus(skipped);
			options?.onProgress?.({ mediaId: media.id, phase: "done", progress: 1 });
			return null;
		}

		report({ mediaId: media.id, phase: "embedding", progress: 0.4 });
		const frames = await embedBatches(sampled, (frac) =>
			report({
				mediaId: media.id,
				phase: "embedding",
				progress: 0.4 + frac * 0.5,
			}),
		);

		// Zero-shot auto-tags: score the cached label vectors against the first
		// frame's embedding (already computed above — no extra image encode).
		let tags: ZeroShotTag[] = [];
		try {
			if (frames.length > 0) {
				tags = zeroShotTagsForFrame(frames[0].vector, await getLabelVectors());
			}
		} catch {
			tags = [];
		}

		const record: MediaEmbedding = {
			id: media.id,
			mediaId: media.id,
			frames,
			createdAt: Date.now(),
			modelName,
			tags,
		};
		await saveEmbedding(record);
		await setStatus({
			mediaId: media.id,
			state: "indexed",
			frameCount: frames.length,
			createdAt: record.createdAt,
		});
		options?.onProgress?.({ mediaId: media.id, phase: "done", progress: 1 });
		return record;
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		await setStatus({ mediaId: media.id, state: "error", error });
		options?.onProgress?.({
			mediaId: media.id,
			phase: "error",
			progress: 1,
			error,
		});
		return null;
	}
}

/**
 * Index many media assets sequentially. Sequential on purpose: the CLIP
 * worker runs one embed at a time and the user is editing — we don't want to
 * starve the main thread or pile up frame blobs in the worker's queue.
 */
export async function indexMediaBatch(
	mediaList: MediaAsset[],
	options?: {
		intervalSec?: number;
		onProgress?: (
			mediaId: string,
			fraction: number,
			phase: IndexingProgress["phase"],
		) => void;
		onAssetComplete?: (mediaId: string, record: MediaEmbedding | null) => void;
	},
): Promise<void> {
	for (const media of mediaList) {
		await indexMedia(media, {
			intervalSec: options?.intervalSec,
			onProgress: (p) => options?.onProgress?.(p.mediaId, p.progress, p.phase),
		}).then((record) => options?.onAssetComplete?.(media.id, record));
	}
}

/** Mean of an asset's frame vectors, L2-normalized — a single "signature" vector. */
function meanVector(frames: EmbeddingFrame[]): Float32Array | null {
	if (frames.length === 0) return null;
	const dim = frames[0].vector.length;
	const out = new Float32Array(dim);
	for (const f of frames) {
		for (let i = 0; i < dim; i++) out[i] += f.vector[i];
	}
	const inv = 1 / frames.length;
	let norm = 0;
	for (let i = 0; i < dim; i++) {
		out[i] *= inv;
		norm += out[i] * out[i];
	}
	norm = Math.sqrt(norm) || 1;
	for (let i = 0; i < dim; i++) out[i] /= norm;
	return out;
}

export interface DuplicatePair {
	mediaIdA: string;
	mediaIdB: string;
	/** Cosine similarity of mean frame vectors. */
	score: number;
}

/**
 * Find near-duplicate media assets by comparing mean frame embeddings.
 *
 * O(n²) over the indexed assets — fine for typical bin sizes (hundreds of
 * clips). For very large libraries this should move into a worker, but the
 * privacy-first design keeps it client-side regardless.
 */
export async function findDuplicates(
	threshold: number = DUPLICATE_THRESHOLD,
): Promise<DuplicatePair[]> {
	// Skip records from a retired vector space (pre-migration model): their
	// cosines against current-model vectors are meaningless, and stale-vs-stale
	// pairs would vanish anyway once the background re-index rewrites them.
	const all = filterToCurrentModel(await getAllEmbeddings());
	const sigs = all
		.map((m) => ({ mediaId: m.mediaId, vec: meanVector(m.frames) }))
		.filter((s): s is { mediaId: string; vec: Float32Array } => s.vec !== null);

	const pairs: DuplicatePair[] = [];
	for (let i = 0; i < sigs.length; i++) {
		for (let j = i + 1; j < sigs.length; j++) {
			let dot = 0;
			const a = sigs[i].vec;
			const b = sigs[j].vec;
			for (let k = 0; k < a.length; k++) dot += a[k] * b[k];
			if (dot >= threshold) {
				pairs.push({
					mediaIdA: sigs[i].mediaId,
					mediaIdB: sigs[j].mediaId,
					score: dot,
				});
			}
		}
	}
	return pairs.sort((a, b) => b.score - a.score);
}

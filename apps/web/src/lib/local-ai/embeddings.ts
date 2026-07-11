/**
 * Backend-swappable embedding seam.
 *
 * Consumers (embedding-service, indexer hooks) call this interface, never the
 * CLIP worker client directly, so a hosted-API backend can slot in later for
 * users who prefer speed over strict locality — swap the adapter, keep every
 * call site. Face embeddings are deliberately EXCLUDED from any future server
 * flip: they are biometric data and must always be computed on-device.
 */

import {
	LOCAL_CLIP_MODEL_NAME,
	type LocalClipProgress,
	localClip,
} from "./local-clip";

/**
 * Seam-level progress vocabulary. An alias today (the local CLIP worker is the
 * only backend), but consumers and future backends must import THIS name so
 * the progress contract lives with the seam, not with one implementation.
 */
export type EmbeddingProgress = LocalClipProgress;

export interface EmbeddingBackend {
	/** Embed texts into L2-normalized vectors (one per input, in order). */
	embedTexts(
		texts: string[],
		onProgress?: (progress: EmbeddingProgress) => void,
	): Promise<Float32Array[]>;
	/** Embed image blobs into L2-normalized vectors (one per input, in order). */
	embedImages(
		blobs: Blob[],
		onProgress?: (progress: EmbeddingProgress) => void,
	): Promise<Float32Array[]>;
	/**
	 * Provenance tag stored on embeddings. Distinct per vector space: vectors
	 * from different backends/weights must never be compared against each
	 * other, and a model-name mismatch is what triggers re-indexing.
	 */
	readonly modelName: string;
}

/**
 * The one shipping backend: the in-browser CLIP worker. Methods read the
 * `localClip` binding at call time (not captured at module eval) so tests
 * that mock the local-clip module see the delegation.
 */
export const embeddings: EmbeddingBackend = {
	embedTexts: (texts, onProgress) => localClip.embedTexts(texts, onProgress),
	embedImages: (blobs, onProgress) => localClip.embedImages(blobs, onProgress),
	modelName: LOCAL_CLIP_MODEL_NAME,
};

/**
 * Drop records whose vectors were produced by a retired backend. During the
 * re-index window IndexedDB holds a mix of old "ViT-B-32" (laion2b-space) and
 * current records; cosines across vector spaces are meaningless, so every
 * query-side consumer (visual search, findDuplicates, Director searchMedia)
 * must filter through here before ranking.
 */
export function filterToCurrentModel<T extends { modelName: string }>(
	records: T[],
): T[] {
	return records.filter((record) => record.modelName === embeddings.modelName);
}

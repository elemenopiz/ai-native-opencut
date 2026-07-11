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

export interface EmbeddingBackend {
	/** Embed texts into L2-normalized vectors (one per input, in order). */
	embedTexts(
		texts: string[],
		onProgress?: (progress: LocalClipProgress) => void,
	): Promise<Float32Array[]>;
	/** Embed image blobs into L2-normalized vectors (one per input, in order). */
	embedImages(
		blobs: Blob[],
		onProgress?: (progress: LocalClipProgress) => void,
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

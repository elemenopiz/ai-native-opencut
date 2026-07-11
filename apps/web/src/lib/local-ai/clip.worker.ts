/**
 * On-device CLIP embedding worker.
 *
 * Runs the CLIP dual encoder (ONNX) entirely in the browser via
 * Transformers.js — WebGPU-accelerated when available, WASM otherwise. Text
 * and image requests share one cached model bundle, so nothing but the
 * (one-time, browser-cached) weight download ever touches the network.
 *
 * Messaging contract (see local-clip.ts for the main-thread half):
 *   in : { kind: "texts",  payload: { texts: string[] }, modelId, device }
 *        { kind: "images", payload: { blobs: Blob[] },   modelId, device }
 *   out: { type: "load-progress", payload }   — model download / init updates
 *        { type: "result", payload: { vectors: number[][] } }
 *        { type: "error", message }
 */

import {
	AutoProcessor,
	AutoTokenizer,
	CLIPTextModelWithProjection,
	CLIPVisionModelWithProjection,
	env,
	RawImage,
} from "@huggingface/transformers";

// Weights are pulled from the HF hub (then cached by the browser). We never
// look for models on the local server, so this stays a pure client feature.
env.allowLocalModels = false;

/** Minimal structural view of the dedicated-worker global (avoids webworker/DOM lib clashes). */
type WorkerScope = {
	postMessage(message: unknown): void;
	onmessage: ((event: MessageEvent) => void) | null;
};
const ctx = self as unknown as WorkerScope;

type ClipRequest =
	| {
			kind: "texts";
			payload: { texts: string[] };
			modelId: string;
			device: "webgpu" | "wasm";
	  }
	| {
			kind: "images";
			payload: { blobs: Blob[] };
			modelId: string;
			device: "webgpu" | "wasm";
	  };

type ClipModels = {
	// biome-ignore lint/suspicious/noExplicitAny: Transformers.js types drift across minor versions.
	tokenizer: any;
	// biome-ignore lint/suspicious/noExplicitAny: Transformers.js types drift across minor versions.
	processor: any;
	// biome-ignore lint/suspicious/noExplicitAny: Transformers.js types drift across minor versions.
	textModel: any;
	// biome-ignore lint/suspicious/noExplicitAny: Transformers.js types drift across minor versions.
	visionModel: any;
};

// Cache the model bundle across requests so re-embedding doesn't re-download.
let models: ClipModels | null = null;
let loadedKey = "";

const postProgress = (payload: unknown) => {
	ctx.postMessage({ type: "load-progress", payload });
};

async function ensureModels(
	modelId: string,
	device: "webgpu" | "wasm",
): Promise<ClipModels> {
	const key = `${modelId}@${device}`;
	if (models && loadedKey === key) return models;

	if (models) {
		await models.textModel.dispose?.().catch(() => undefined);
		await models.visionModel.dispose?.().catch(() => undefined);
		models = null;
	}

	// q8 keeps both encoders small and is accurate enough for retrieval on
	// either backend; CLIP is tiny next to Whisper so one dtype fits all.
	const modelOptions = {
		device,
		dtype: "q8",
		progress_callback: postProgress,
		// biome-ignore lint/suspicious/noExplicitAny: option bags are loosely typed upstream.
	} as any;

	const [tokenizer, processor, textModel, visionModel] = await Promise.all([
		AutoTokenizer.from_pretrained(modelId, { progress_callback: postProgress }),
		AutoProcessor.from_pretrained(modelId, {
			progress_callback: postProgress,
			// biome-ignore lint/suspicious/noExplicitAny: option bags are loosely typed upstream.
		} as any),
		CLIPTextModelWithProjection.from_pretrained(modelId, modelOptions),
		CLIPVisionModelWithProjection.from_pretrained(modelId, modelOptions),
	]);

	models = { tokenizer, processor, textModel, visionModel };
	loadedKey = key;
	return models;
}

/** L2-normalize each vector so consumers can use plain dot-product cosine. */
function l2Normalize(vectors: number[][]): number[][] {
	return vectors.map((vector) => {
		let sumSquares = 0;
		for (const value of vector) sumSquares += value * value;
		const norm = Math.sqrt(sumSquares);
		if (norm === 0) return vector.slice();
		return vector.map((value) => value / norm);
	});
}

async function embedTexts(bundle: ClipModels, texts: string[]) {
	const inputs = await bundle.tokenizer(texts, {
		padding: true,
		truncation: true,
	});
	const output = await bundle.textModel(inputs);
	return output.text_embeds.tolist() as number[][];
}

async function embedImages(bundle: ClipModels, blobs: Blob[]) {
	const images = await Promise.all(
		blobs.map((blob) => RawImage.fromBlob(blob)),
	);
	const inputs = await bundle.processor(images);
	const output = await bundle.visionModel(inputs);
	return output.image_embeds.tolist() as number[][];
}

ctx.onmessage = async (event: MessageEvent) => {
	const req = event.data as ClipRequest;
	try {
		const bundle = await ensureModels(req.modelId, req.device);
		const vectors =
			req.kind === "texts"
				? await embedTexts(bundle, req.payload.texts)
				: await embedImages(bundle, req.payload.blobs);
		ctx.postMessage({
			type: "result",
			payload: { vectors: l2Normalize(vectors) },
		});
	} catch (err) {
		ctx.postMessage({
			type: "error",
			message: err instanceof Error ? err.message : String(err),
		});
	}
};

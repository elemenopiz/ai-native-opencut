/**
 * On-device Whisper worker.
 *
 * Runs OpenAI Whisper (ONNX) entirely in the browser via Transformers.js —
 * WebGPU-accelerated when available, WASM otherwise. The main thread decodes
 * the media file to a 16 kHz mono Float32Array and hands it here; nothing but
 * the (one-time, cached) model-weight download ever touches the network.
 *
 * Messaging contract (see local-whisper.ts for the main-thread half):
 *   in : { modelId, device, audio, language?, returnTimestamps, chunkLengthS, strideLengthS }
 *   out: { type: "load-progress", payload }   — model download / init updates
 *        { type: "status", stage: "transcribing" }
 *        { type: "result", payload }           — { text, chunks? }
 *        { type: "error", message }
 */

import { pipeline, env } from "@huggingface/transformers";

// Weights are pulled from the HF hub (then cached by the browser). We never
// look for models on the local server, so this stays a pure client feature.
env.allowLocalModels = false;

// Serve the ONNX-runtime wasm SAME-ORIGIN from /onnx/ (vendored by
// scripts/copy-onnx-runtime.mjs) instead of transformers' default third-party
// jsDelivr CDN. Setting wasmPaths before the first pipeline() call suppresses
// that default (transformers only injects the CDN path when wasmPaths is unset).
// This removes a runtime dependency on jsDelivr — when it was slow, rate-limited,
// blocked (corporate/regional networks), or down, ORT init threw a bare
// "network error" and transcription failed with no working fallback on prod.
if (env.backends?.onnx?.wasm) {
	env.backends.onnx.wasm.wasmPaths = `${self.location.origin}/onnx/`;
}

/** Minimal structural view of the dedicated-worker global (avoids webworker/DOM lib clashes). */
type WorkerScope = {
	postMessage(message: unknown): void;
	onmessage: ((event: MessageEvent) => void) | null;
};
const ctx = self as unknown as WorkerScope;

type TranscribeRequest = {
	modelId: string;
	device: "webgpu" | "wasm";
	audio: Float32Array;
	language?: string;
	returnTimestamps: "word" | boolean;
	chunkLengthS: number;
	strideLengthS: number;
};

// Cache the pipeline across requests so re-transcribing doesn't re-download.
// biome-ignore lint/suspicious/noExplicitAny: Transformers.js pipeline type drifts across minor versions.
let transcriber: any = null;
let loadedKey = "";

async function ensurePipeline(modelId: string, device: "webgpu" | "wasm") {
	const key = `${modelId}@${device}`;
	if (transcriber && loadedKey === key) return transcriber;

	if (transcriber) {
		await transcriber.dispose?.().catch(() => undefined);
		transcriber = null;
	}

	// q4 decoder is the sweet spot on WebGPU; q8 keeps the WASM path smaller.
	const dtype =
		device === "webgpu"
			? { encoder_model: "fp32", decoder_model_merged: "q4" }
			: { encoder_model: "fp32", decoder_model_merged: "q8" };

	transcriber = await pipeline("automatic-speech-recognition", modelId, {
		device,
		// biome-ignore lint/suspicious/noExplicitAny: dtype map keys are model-file specific.
		dtype: dtype as any,
		progress_callback: (payload: unknown) => {
			ctx.postMessage({ type: "load-progress", payload });
		},
	});
	loadedKey = key;
	return transcriber;
}

ctx.onmessage = async (event: MessageEvent) => {
	const req = event.data as TranscribeRequest;
	try {
		const model = await ensurePipeline(req.modelId, req.device);
		ctx.postMessage({ type: "status", stage: "transcribing" });

		const output = await model(req.audio, {
			return_timestamps: req.returnTimestamps,
			chunk_length_s: req.chunkLengthS,
			stride_length_s: req.strideLengthS,
			language: req.language,
			task: "transcribe",
			// biome-ignore lint/suspicious/noExplicitAny: ASR call options are loosely typed upstream.
		} as any);

		ctx.postMessage({ type: "result", payload: output });
	} catch (err) {
		ctx.postMessage({
			type: "error",
			message: err instanceof Error ? err.message : String(err),
		});
	}
};

export {};

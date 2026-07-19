/**
 * On-device Whisper transcription (main-thread orchestrator).
 *
 * Decodes a media File to 16 kHz mono PCM, then drives the Whisper worker
 * (Transformers.js, WebGPU with WASM fallback) to produce word-level
 * transcript segments — the same `TranscriptionResult` shape the server
 * `/api/transcribe` route returns, so callers can swap this in transparently.
 * No audio leaves the device; only the model weights are fetched (once) and
 * cached by the browser.
 */

import {
	DEFAULT_CHUNK_LENGTH_SECONDS,
	DEFAULT_STRIDE_SECONDS,
	TRANSCRIPTION_MODELS,
} from "@/constants/transcription-constants";
import { type LocalAIDevice, pickDevice } from "@/lib/local-ai/device";
import { WorkerSlot } from "@/lib/local-ai/worker-slot";
import { DECODE_SAMPLE_RATE, decodeToMono16k } from "@/lib/media/decode-audio";
import type {
	TranscriptionResult,
	TranscriptionSegment,
	TranscriptionWord,
} from "@/types/ai";

export interface LocalTranscriptionResult extends TranscriptionResult {
	/** Marks results produced in-browser (vs. the server engines). */
	engine: "whisper-local";
}

export interface LocalWhisperProgress {
	stage: "decoding" | "loading-model" | "transcribing";
	/** 0..1 within the current stage. */
	progress: number;
	message?: string;
}

export interface LocalWhisperOptions {
	/** Registry model id (e.g. "whisper-small"); defaults per device. */
	model?: string;
	/** ISO code, or undefined to auto-detect. */
	language?: string;
	onProgress?: (progress: LocalWhisperProgress) => void;
}

/** A segment before it's assigned a stable id. */
type DraftSegment = {
	text: string;
	start: number;
	end: number;
	words: TranscriptionWord[];
};

/**
 * True when the browser can run Whisper locally at all. WebGPU is *preferred*
 * but not required — we fall back to WASM — so this only checks for the Worker
 * + Web Audio primitives every supported browser has.
 */
export function isLocalWhisperSupported(): boolean {
	if (typeof window === "undefined") return false;
	const hasAudio =
		typeof window.AudioContext !== "undefined" ||
		// biome-ignore lint/suspicious/noExplicitAny: Safari prefix.
		typeof (window as any).webkitAudioContext !== "undefined";
	return typeof Worker !== "undefined" && hasAudio;
}

function resolveModelId(
	model: string | undefined,
	device: LocalAIDevice,
): string {
	if (model) {
		const match = TRANSCRIPTION_MODELS.find(
			(m) => m.id === model && m.engine === "whisper" && m.huggingFaceId,
		);
		if (match) return match.huggingFaceId;
	}
	// WebGPU can comfortably run "small"; on the slower WASM path prefer "tiny".
	return device === "webgpu"
		? "onnx-community/whisper-small"
		: "onnx-community/whisper-tiny";
}

interface WhisperChunk {
	text: string;
	timestamp: [number | null, number | null];
}

/**
 * Convert Whisper's phrase-level chunks into transcript segments.
 *
 * We request segment- (not word-) level timestamps because the standard
 * `onnx-community/whisper-*` ONNX exports don't carry the cross-attentions
 * word alignment needs. Per-word timings are synthesized by splitting each
 * phrase evenly across its span — the same approach the caption UI already
 * uses when the server omits word data.
 */
function chunksToDraftSegments(chunks: WhisperChunk[]): DraftSegment[] {
	const segments: DraftSegment[] = [];
	let lastEnd = 0;

	for (const chunk of chunks) {
		const rawStart = chunk.timestamp[0];
		const rawEnd = chunk.timestamp[1];
		const start = typeof rawStart === "number" ? rawStart : lastEnd;
		let end = typeof rawEnd === "number" ? rawEnd : start;
		if (end < start) end = start;
		lastEnd = Math.max(lastEnd, end);

		const text = (chunk.text ?? "").trim();
		if (!text) continue;

		const tokens = text.split(/\s+/).filter(Boolean);
		const span = end - start;
		const per = tokens.length > 0 ? span / tokens.length : 0;
		const words: TranscriptionWord[] = tokens.map((word, i) => ({
			word,
			start: start + i * per,
			end: start + (i + 1) * per,
			confidence: 0.9,
		}));

		segments.push({ text, start, end, words });
	}

	return segments;
}

/** When timestamps are unavailable, emit a single draft segment. */
function fallbackDraft(text: string): DraftSegment[] {
	const clean = text.trim();
	if (!clean) return [];
	return [{ text: clean, start: 0, end: 0, words: [] }];
}

// Warm-worker slot: keeps one worker so re-transcribes skip model reload, and
// idle-unloads it after IDLE_UNLOAD_MS so Whisper's model memory is released
// once the user is done transcribing — the next use recreates the worker
// exactly like first use (weights reload from the browser Cache API).
const workerSlot = new WorkerSlot({
	createWorker: () =>
		new Worker(new URL("./whisper.worker.ts", import.meta.url), {
			type: "module",
		}),
});

/**
 * Transcribe a media File entirely on-device. Resolves to the same
 * `TranscriptionResult` shape as the server route (with word timings and an
 * `engine` marker). Throws on decode/model/runtime failure so callers can fall
 * back to a server engine when one is available.
 *
 * Deliberately NOT gated on the editor-priority scheduler (unlike LocalClip):
 * transcription is an explicit user action with a visible progress UI — the
 * user is actively waiting on it — and it's a single-shot request per file,
 * so a dispatch-time gate could only delay the start, never yield mid-run.
 */
export async function transcribeLocally(
	file: File,
	options: LocalWhisperOptions = {},
): Promise<LocalTranscriptionResult> {
	const device = pickDevice();
	const modelId = resolveModelId(options.model, device);

	options.onProgress?.({ stage: "decoding", progress: 0 });
	const audio = await decodeToMono16k(file);
	const durationSec = audio.length / DECODE_SAMPLE_RATE;
	options.onProgress?.({ stage: "loading-model", progress: 0 });

	// `pickDevice()` selects "webgpu" whenever `navigator.gpu` exists on the
	// API surface — it doesn't confirm a real adapter is obtainable (see
	// src/lib/local-ai/device.ts). Browsers that expose the API but can't
	// actually get a working adapter/device (GPU blocklisted, hardware
	// acceleration disabled, some VM/remote-desktop Chromes) throw once
	// `pipeline()` tries to initialize it. Keep a spare copy of the decoded
	// audio so a same-worker WASM retry is possible if that happens — cloud
	// deploys have no server engine to fall back to, so without this retry
	// that whole class of browser has no working path to on-device Whisper.
	const retryAudio = device === "webgpu" ? audio.slice() : null;

	// Hold the warm worker for the duration of the transcribe; releasing when
	// it settles starts the idle-unload countdown (see WorkerSlot).
	const activeWorker = workerSlot.acquire();
	let extraAcquire = false;

	let output: { text?: string; chunks?: WhisperChunk[] };
	try {
		try {
			output = await runOnWorker(activeWorker, audio, {
				modelId,
				device,
				language: options.language,
				onProgress: options.onProgress,
			});
		} catch (err) {
			if (!retryAudio) throw err;
			// The worker may have been recycled (crashed) by runOnWorker's error
			// handler above — acquire() transparently hands back the still-warm
			// worker if it survived, or spawns a fresh one if it didn't.
			extraAcquire = true;
			const retryWorker = workerSlot.acquire();
			const wasmModelId = resolveModelId(options.model, "wasm");
			output = await runOnWorker(retryWorker, retryAudio, {
				modelId: wasmModelId,
				device: "wasm",
				language: options.language,
				onProgress: options.onProgress,
			});
		}
	} finally {
		workerSlot.release();
		if (extraAcquire) workerSlot.release();
	}

	const drafts =
		output.chunks && output.chunks.length > 0
			? chunksToDraftSegments(output.chunks)
			: fallbackDraft(output.text ?? "");

	const segments: TranscriptionSegment[] = drafts.map((draft, index) => ({
		id: index,
		text: draft.text,
		start: draft.start,
		end: draft.end,
		words: draft.words,
	}));

	options.onProgress?.({ stage: "transcribing", progress: 1 });

	return {
		segments,
		language: options.language ?? "en",
		duration: durationSec,
		engine: "whisper-local",
	};
}

/** Post one transcription request and await its result on the given worker. */
function runOnWorker(
	activeWorker: Worker,
	audio: Float32Array,
	options: {
		modelId: string;
		device: LocalAIDevice;
		language?: string;
		onProgress?: LocalWhisperOptions["onProgress"];
	},
): Promise<{ text?: string; chunks?: WhisperChunk[] }> {
	return new Promise<{ text?: string; chunks?: WhisperChunk[] }>(
		(resolve, reject) => {
			const onMessage = (event: MessageEvent) => {
				const data = event.data as {
					type: string;
					payload?: unknown;
					message?: string;
					stage?: string;
				};
				if (data.type === "load-progress") {
					const p = data.payload as {
						status?: string;
						progress?: number;
						file?: string;
					};
					if (p?.status === "progress" && typeof p.progress === "number") {
						options.onProgress?.({
							stage: "loading-model",
							progress: Math.min(1, p.progress / 100),
							message: p.file,
						});
					}
				} else if (data.type === "status" && data.stage === "transcribing") {
					options.onProgress?.({ stage: "transcribing", progress: 0 });
				} else if (data.type === "result") {
					cleanup();
					resolve(data.payload as { text?: string; chunks?: WhisperChunk[] });
				} else if (data.type === "error") {
					cleanup();
					reject(new Error(data.message || "on-device transcription failed"));
				}
			};
			// An ErrorEvent means the worker script itself died — recycle it so
			// the next transcribe gets a live worker instead of a dead warm one.
			const onError = (event: ErrorEvent) => {
				cleanup();
				workerSlot.recycle(activeWorker);
				reject(new Error(event.message || "whisper worker crashed"));
			};
			// Structured-clone failure: the channel is unreliable, treat like a
			// crash (same as LocalClip) so the transcribe rejects instead of
			// hanging on a result that can never be delivered.
			const onMessageError = () => {
				cleanup();
				workerSlot.recycle(activeWorker);
				reject(new Error("whisper worker message could not be deserialized"));
			};
			function cleanup() {
				activeWorker.removeEventListener("message", onMessage);
				activeWorker.removeEventListener("error", onError);
				activeWorker.removeEventListener("messageerror", onMessageError);
			}

			activeWorker.addEventListener("message", onMessage);
			activeWorker.addEventListener("error", onError);
			activeWorker.addEventListener("messageerror", onMessageError);
			activeWorker.postMessage(
				{
					modelId: options.modelId,
					device: options.device,
					audio,
					language: options.language,
					returnTimestamps: true,
					chunkLengthS: DEFAULT_CHUNK_LENGTH_SECONDS,
					strideLengthS: DEFAULT_STRIDE_SECONDS,
				},
				// Transfer the PCM buffer (zero-copy) — we don't reuse it after.
				[audio.buffer],
			);
		},
	);
}

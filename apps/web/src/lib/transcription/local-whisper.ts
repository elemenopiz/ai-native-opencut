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
import type {
	TranscriptionResult,
	TranscriptionSegment,
	TranscriptionWord,
} from "@/types/ai";

const SAMPLE_RATE = 16000;

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

function pickDevice(): "webgpu" | "wasm" {
	// biome-ignore lint/suspicious/noExplicitAny: navigator.gpu missing from older lib.dom.
	return (navigator as any).gpu ? "webgpu" : "wasm";
}

function resolveModelId(
	model: string | undefined,
	device: "webgpu" | "wasm",
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

/** Decode any supported media File to a mono 16 kHz Float32Array. */
async function decodeToMono16k(file: File): Promise<Float32Array> {
	const arrayBuffer = await file.arrayBuffer();
	const AudioCtor =
		window.AudioContext ||
		// biome-ignore lint/suspicious/noExplicitAny: Safari prefix.
		(window as any).webkitAudioContext;
	const decodeCtx = new AudioCtor();
	let audioBuffer: AudioBuffer;
	try {
		audioBuffer = await decodeCtx.decodeAudioData(arrayBuffer);
	} finally {
		decodeCtx.close?.();
	}

	if (
		audioBuffer.sampleRate === SAMPLE_RATE &&
		audioBuffer.numberOfChannels === 1
	) {
		return audioBuffer.getChannelData(0).slice();
	}

	// Downmix to mono + resample to 16 kHz by rendering through an offline graph.
	const frames = Math.max(1, Math.ceil(audioBuffer.duration * SAMPLE_RATE));
	const offline = new OfflineAudioContext(1, frames, SAMPLE_RATE);
	const source = offline.createBufferSource();
	source.buffer = audioBuffer;
	source.connect(offline.destination);
	source.start();
	const rendered = await offline.startRendering();
	return rendered.getChannelData(0).slice();
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

// Keep one warm worker for the session so re-transcribes skip model reload.
let worker: Worker | null = null;
function getWorker(): Worker {
	if (!worker) {
		worker = new Worker(new URL("./whisper.worker.ts", import.meta.url), {
			type: "module",
		});
	}
	return worker;
}

/**
 * Transcribe a media File entirely on-device. Resolves to the same
 * `TranscriptionResult` shape as the server route (with word timings and an
 * `engine` marker). Throws on decode/model/runtime failure so callers can fall
 * back to a server engine when one is available.
 */
export async function transcribeLocally(
	file: File,
	options: LocalWhisperOptions = {},
): Promise<LocalTranscriptionResult> {
	const device = pickDevice();
	const modelId = resolveModelId(options.model, device);

	options.onProgress?.({ stage: "decoding", progress: 0 });
	const audio = await decodeToMono16k(file);
	const durationSec = audio.length / SAMPLE_RATE;
	options.onProgress?.({ stage: "loading-model", progress: 0 });

	const activeWorker = getWorker();

	const output = await new Promise<{ text?: string; chunks?: WhisperChunk[] }>(
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
			const onError = (event: ErrorEvent) => {
				cleanup();
				reject(new Error(event.message || "whisper worker crashed"));
			};
			function cleanup() {
				activeWorker.removeEventListener("message", onMessage);
				activeWorker.removeEventListener("error", onError);
			}

			activeWorker.addEventListener("message", onMessage);
			activeWorker.addEventListener("error", onError);
			activeWorker.postMessage(
				{
					modelId,
					device,
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

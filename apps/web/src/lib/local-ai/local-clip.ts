/**
 * On-device CLIP embeddings (main-thread orchestrator).
 *
 * Drives the CLIP worker (Transformers.js, WebGPU with WASM fallback) to
 * embed texts and image blobs into the same 512-dim space, entirely
 * in-browser. Only the model weights are fetched (once) and cached by the
 * browser; no asset pixels or queries leave the device.
 *
 * Requests are serialized: the worker runs one embed at a time, so callers
 * queue behind each other on a single warm worker instead of racing its
 * message channel. Each queued request additionally waits for the editor to
 * be idle (see scheduler.ts) so inference never competes with playback or
 * export for the GPU, and the warm worker is unloaded after an idle stretch
 * (see worker-slot.ts) so model memory is released.
 */

import { pickDevice } from "./device";
import { type LocalAIScheduler, localAIScheduler } from "./scheduler";
import type { Timers } from "./timers";
import { WorkerSlot } from "./worker-slot";

export const LOCAL_CLIP_MODEL_ID = "Xenova/clip-vit-base-patch32";

/**
 * Model name stored on embeddings produced by this path. Deliberately
 * distinct from the server-side "ViT-B-32" so mixed-provenance vectors are
 * never compared against each other despite the shared architecture.
 */
export const LOCAL_CLIP_MODEL_NAME = "clip-vit-b32-web";

export interface LocalClipProgress {
	stage: "loading-model" | "embedding";
	/** 0..1 within the current stage. */
	progress: number;
	message?: string;
}

type OnProgress = (progress: LocalClipProgress) => void;

/** Request half of the worker contract (see clip.worker.ts). */
type ClipWorkPayload =
	| { kind: "texts"; payload: { texts: string[] } }
	| { kind: "images"; payload: { blobs: Blob[] } };

export class LocalClip {
	/** Tail of the request chain — each new request awaits the previous one. */
	private queue: Promise<unknown> = Promise.resolve();
	/** Warm-worker lifecycle (creation, crash recycle, idle unload). */
	private readonly slot: WorkerSlot;
	/** Editor-priority gate awaited before dispatching each queued request. */
	private readonly scheduler: Pick<LocalAIScheduler, "waitForIdle">;

	constructor(
		opts: {
			createWorker?: () => Worker;
			scheduler?: Pick<LocalAIScheduler, "waitForIdle">;
			idleUnloadMs?: number;
			timers?: Timers;
		} = {},
	) {
		// Injectable factory/scheduler/timers so tests can drive the client with
		// fakes; the worker default is the same bundler-visible URL pattern
		// local-whisper uses.
		this.slot = new WorkerSlot({
			createWorker:
				opts.createWorker ??
				(() =>
					new Worker(new URL("./clip.worker.ts", import.meta.url), {
						type: "module",
					})),
			idleUnloadMs: opts.idleUnloadMs,
			timers: opts.timers,
		});
		this.scheduler = opts.scheduler ?? localAIScheduler;
	}

	/** Embed texts into L2-normalized CLIP vectors (one per input, in order). */
	embedTexts(
		texts: string[],
		onProgress?: OnProgress,
	): Promise<Float32Array[]> {
		return this.enqueue({ kind: "texts", payload: { texts } }, onProgress);
	}

	/** Embed image blobs into L2-normalized CLIP vectors (one per input, in order). */
	embedImages(blobs: Blob[], onProgress?: OnProgress): Promise<Float32Array[]> {
		return this.enqueue({ kind: "images", payload: { blobs } }, onProgress);
	}

	private enqueue(
		work: ClipWorkPayload,
		onProgress?: OnProgress,
	): Promise<Float32Array[]> {
		const run = this.queue.then(async () => {
			// The editor owns the GPU: hold each queued embed until playback/
			// scrubbing/export goes idle. The gate sits between serialized
			// requests, so an in-flight embed is never aborted — the editor
			// going busy mid-request just holds whatever is queued behind it.
			await this.scheduler.waitForIdle();
			return this.request(work, onProgress);
		});
		// Keep the chain alive after failures so the next request still runs.
		this.queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private async request(
		work: ClipWorkPayload,
		onProgress?: OnProgress,
	): Promise<Float32Array[]> {
		// Hold the warm worker for the duration of the request; releasing when
		// it settles starts the idle-unload countdown (see WorkerSlot).
		const activeWorker = this.slot.acquire();
		try {
			return await this.dispatch(activeWorker, work, onProgress);
		} finally {
			this.slot.release();
		}
	}

	private dispatch(
		activeWorker: Worker,
		work: ClipWorkPayload,
		onProgress?: OnProgress,
	): Promise<Float32Array[]> {
		return new Promise<Float32Array[]>((resolve, reject) => {
			const onMessage = (event: MessageEvent) => {
				const data = event.data as {
					type: string;
					payload?: unknown;
					message?: string;
				};
				if (data.type === "load-progress") {
					const p = data.payload as {
						status?: string;
						progress?: number;
						file?: string;
					};
					if (p?.status === "progress" && typeof p.progress === "number") {
						onProgress?.({
							stage: "loading-model",
							progress: Math.min(1, p.progress / 100),
							message: p.file,
						});
					}
				} else if (data.type === "result") {
					cleanup();
					const { vectors } = data.payload as { vectors: number[][] };
					onProgress?.({ stage: "embedding", progress: 1 });
					resolve(vectors.map((vector) => Float32Array.from(vector)));
				} else if (data.type === "error") {
					cleanup();
					reject(new Error(data.message || "on-device embedding failed"));
				}
			};
			// An ErrorEvent means the worker script itself died — recycle it so
			// the next request gets a live worker instead of hanging.
			const onError = (event: ErrorEvent) => {
				cleanup();
				this.slot.recycle(activeWorker);
				reject(new Error(event.message || "clip worker crashed"));
			};
			// Structured-clone failure: the channel is unreliable, treat like a crash.
			const onMessageError = () => {
				cleanup();
				this.slot.recycle(activeWorker);
				reject(new Error("clip worker message could not be deserialized"));
			};
			function cleanup() {
				activeWorker.removeEventListener("message", onMessage);
				activeWorker.removeEventListener("error", onError);
				activeWorker.removeEventListener("messageerror", onMessageError);
			}

			activeWorker.addEventListener("message", onMessage);
			activeWorker.addEventListener("error", onError);
			activeWorker.addEventListener("messageerror", onMessageError);
			onProgress?.({ stage: "loading-model", progress: 0 });
			activeWorker.postMessage({
				...work,
				modelId: LOCAL_CLIP_MODEL_ID,
				device: pickDevice(),
			});
		});
	}
}

/** Module singleton — one warm worker shared across the app session. */
export const localClip = new LocalClip();

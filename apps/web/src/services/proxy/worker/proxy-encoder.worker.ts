/**
 * Proxy-encoder worker: runs part 1's canvas-agnostic encode core
 * (`runProxyEncode`, ../proxy-generator.ts) against an `OffscreenCanvas`
 * instead of a DOM `<canvas>`, so the per-frame decode+draw+encode loop no
 * longer blocks the main thread.
 *
 * Messaging contract: see proxy-encoder-types.ts. No SharedArrayBuffer — the
 * `File` in `start` and the `File` result both clone fine over postMessage.
 *
 * Cancellation: `AbortSignal` cannot cross the worker boundary, so this
 * worker owns its own `AbortController` and aborts it when a `cancel`
 * message arrives; the aborted signal is what's passed into
 * `runProxyEncode`, whose existing abort semantics (`output.cancel()` then
 * throw `"Proxy generation cancelled"` — see proxy-generator.ts) do the rest
 * unmodified.
 */
import { runProxyEncode } from "../proxy-generator";
import type {
	ProxyEncoderInboundMessage,
	ProxyEncoderOutboundMessage,
} from "./proxy-encoder-types";

/**
 * Minimal structural view of the dedicated-worker global (same pattern as
 * compositor.worker.ts / clip.worker.ts / whisper.worker.ts — avoids the
 * webworker/dom lib clash since tsconfig's "lib" is dom-only).
 */
type WorkerScope = {
	postMessage(message: ProxyEncoderOutboundMessage): void;
	onmessage: ((event: MessageEvent<ProxyEncoderInboundMessage>) => void) | null;
};
const ctx = self as unknown as WorkerScope;

/** The in-flight job's own AbortController, aborted on a `cancel` message. */
let activeAbortController: AbortController | null = null;

ctx.onmessage = (event: MessageEvent<ProxyEncoderInboundMessage>) => {
	const msg = event.data;
	switch (msg.type) {
		case "start": {
			const controller = new AbortController();
			activeAbortController = controller;

			runProxyEncode({
				file: msg.file,
				resolution: msg.resolution,
				signal: controller.signal,
				// The core already throttles onProgress (every 5th frame, plus a
				// final 1) — forward every call as-is, no extra throttling here.
				onProgress: (progress) => {
					ctx.postMessage({ type: "progress", progress });
				},
				createCanvas: (width, height) => new OffscreenCanvas(width, height),
			})
				.then((result) => {
					ctx.postMessage({ type: "result", result });
				})
				.catch((error: unknown) => {
					ctx.postMessage({
						type: "error",
						message: error instanceof Error ? error.message : String(error),
					});
				})
				.finally(() => {
					if (activeAbortController === controller) {
						activeAbortController = null;
					}
				});
			break;
		}
		case "cancel": {
			activeAbortController?.abort();
			break;
		}
	}
};

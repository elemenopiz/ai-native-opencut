/**
 * Main-thread controller for the proxy-encoder worker. Owns the per-job
 * Worker instance and translates the same inputs `generateProxy()` already
 * takes (file, resolution, onProgress, signal) into the worker's
 * start/cancel message protocol (see proxy-encoder-types.ts), so existing
 * call sites can adopt `generateProxyOffThread` as a drop-in.
 *
 * Public API is frozen — do not rename `isWorkerProxyEncodeSupported` or
 * `generateProxyOffThread`, or change their signatures. Downstream code
 * (MediaManager) is written directly against this shape.
 *
 * Lifecycle: unlike the long-lived compositor worker (compositor-controller.ts),
 * this spawns a dedicated Worker per proxy-generation job and terminates it
 * in a `finally` once the job settles (result, error, or cancel) — the
 * simplest correct lifecycle for a one-shot, job-shaped task with no shared
 * state across calls.
 */
import { generateProxy } from "../proxy-generator";
import type {
	ProxyGenerateOptions,
	ProxyGenerateResult,
} from "../proxy-generator";
import type {
	ProxyEncoderInboundMessage,
	ProxyEncoderOutboundMessage,
} from "./proxy-encoder-types";

/**
 * Preserves the exact error the main-thread core throws on cancellation
 * (proxy-generator.ts's `runProxyEncode`), so callers (media-manager's catch
 * logic) see identical behavior regardless of which path ran.
 */
const CANCELLED_MESSAGE = "Proxy generation cancelled";

/** How long to wait for the worker's own cancellation error after a `cancel`
 * message before giving up and settling from the controller side. Normal
 * operation resolves well under this: the core checks `signal.aborted` once
 * per frame and posts its own "Proxy generation cancelled" error message,
 * which settles the promise immediately (see the "error" case below) — this
 * timer only fires if the worker is stuck (e.g. hung inside a single
 * decode/encode call with no per-frame checkpoint to observe the abort). */
const CANCEL_GRACE_MS = 250;

/**
 * Capability detection. Checked, in order:
 *  - `typeof window === "undefined"` → false (SSR-safe; this module may be
 *    imported by code that also runs on the server).
 *  - `typeof Worker === "undefined"` → false (no dedicated Worker support).
 *  - `typeof OffscreenCanvas === "undefined"` → false (the worker draws into
 *    an OffscreenCanvas; without it there is nothing to hand runProxyEncode).
 *  - `typeof VideoEncoder === "undefined"` → false. This checks WebCodecs on
 *    the MAIN thread as a pragmatic proxy for "the worker will have it too":
 *    every browser that ships WebCodecs also exposes it inside a dedicated
 *    Worker scope, and every browser that ships OffscreenCanvas + Worker but
 *    not WebCodecs (there are none in practice — WebCodecs and
 *    OffscreenCanvas shipped together in Chromium) would already fail the
 *    OffscreenCanvas check above. Probing `VideoEncoder` inside an actual
 *    worker would require spinning one up just to ask, which defeats the
 *    point of a cheap synchronous capability check.
 */
export function isWorkerProxyEncodeSupported(): boolean {
	if (typeof window === "undefined") return false;
	if (typeof Worker === "undefined") return false;
	if (typeof OffscreenCanvas === "undefined") return false;
	if (typeof VideoEncoder === "undefined") return false;
	return true;
}

/**
 * Runs proxy generation off the main thread when the environment supports
 * it, falling back to the existing main-thread `generateProxy()` path
 * (byte-identical behavior to before this change) otherwise. See the
 * module doc for the frozen-API contract.
 */
export function generateProxyOffThread(
	options: ProxyGenerateOptions,
): Promise<ProxyGenerateResult> {
	if (!isWorkerProxyEncodeSupported()) {
		return generateProxy(options);
	}

	// Already aborted before we even started: match generateProxy's own
	// already-aborted behavior (it still runs the core, which throws on its
	// first per-frame check) by rejecting immediately with the same message,
	// without spinning up a worker at all.
	if (options.signal?.aborted) {
		return Promise.reject(new Error(CANCELLED_MESSAGE));
	}

	let worker: Worker;
	try {
		worker = new Worker(new URL("./proxy-encoder.worker.ts", import.meta.url), {
			type: "module",
		});
	} catch {
		// The Worker constructor itself failing (e.g. blocked by CSP, module
		// workers unsupported despite passing the capability checks above)
		// means the environment genuinely can't do this — fall back once
		// rather than surfacing a boot-time error to the caller.
		return generateProxy(options);
	}

	return new Promise<ProxyGenerateResult>((resolve, reject) => {
		let settled = false;
		let cancelled = false;
		let receivedAnyMessage = false;
		let cancelGraceTimer: ReturnType<typeof setTimeout> | null = null;

		const cleanup = () => {
			worker.onmessage = null;
			worker.onerror = null;
			if (cancelGraceTimer !== null) {
				clearTimeout(cancelGraceTimer);
				cancelGraceTimer = null;
			}
			if (options.signal) {
				options.signal.removeEventListener("abort", onAbort);
			}
			worker.terminate();
		};

		const settleResolve = (result: ProxyGenerateResult) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(result);
		};

		const settleReject = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};

		function onAbort() {
			if (settled || cancelled) return;
			cancelled = true;
			const cancelMsg: ProxyEncoderInboundMessage = { type: "cancel" };
			worker.postMessage(cancelMsg);
			// The worker's own abort check should reject via the "error" message
			// path below almost immediately; this is only a backstop in case it
			// never responds (see CANCEL_GRACE_MS doc).
			cancelGraceTimer = setTimeout(() => {
				settleReject(new Error(CANCELLED_MESSAGE));
			}, CANCEL_GRACE_MS);
		}

		if (options.signal) {
			options.signal.addEventListener("abort", onAbort, { once: true });
		}

		worker.onmessage = (event: MessageEvent<ProxyEncoderOutboundMessage>) => {
			receivedAnyMessage = true;
			const msg = event.data;
			switch (msg.type) {
				case "progress":
					options.onProgress?.(msg.progress);
					break;
				case "result":
					// A "result" racing in after we already posted "cancel" (the
					// job finished just before the cancel was observed) still wins
					// as a cancellation from the caller's perspective — the caller
					// asked to cancel and should see that outcome, not a silently
					// succeeded job it can't do anything with.
					if (cancelled) {
						settleReject(new Error(CANCELLED_MESSAGE));
					} else {
						settleResolve(msg.result);
					}
					break;
				case "error":
					// Prefer the caller-facing cancellation shape/message over
					// whatever the worker's catch produced once a cancel is in
					// flight — parity with the main-thread path's single error
					// shape on cancel (it's very likely already exactly this
					// message, since runProxyEncode throws it verbatim, but this
					// guarantees it regardless of timing).
					settleReject(new Error(cancelled ? CANCELLED_MESSAGE : msg.message));
					break;
			}
		};

		worker.onerror = (event: ErrorEvent) => {
			if (cancelled) {
				settleReject(new Error(CANCELLED_MESSAGE));
				return;
			}
			if (!receivedAnyMessage) {
				// Nothing has come back yet: this is a boot-time failure (e.g. the
				// worker module failed to load) rather than a mid-encode failure
				// — the core always reports mid-encode failures through the typed
				// "error" message (worker-side try/catch), never by throwing
				// through to onerror. Fall back to the main-thread path once.
				settled = true;
				cleanup();
				generateProxy(options).then(resolve, reject);
				return;
			}
			settleReject(new Error(event.message || "Proxy worker error"));
		};

		const startMsg: ProxyEncoderInboundMessage = {
			type: "start",
			file: options.file,
			resolution: options.resolution,
		};
		worker.postMessage(startMsg);
	});
}

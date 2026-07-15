/**
 * Shared message protocol for the proxy-encoder worker. Imported by BOTH the
 * main thread (proxy-encoder-controller.ts) and the worker
 * (proxy-encoder.worker.ts), so it must stay free of DOM- or
 * worker-global-scope-only APIs — plain types only (mirrors the split in
 * ../../renderer/worker/compositor-types.ts).
 *
 * `File` and `ProxyResolution` (a string literal union) are both
 * structured-clone-safe, so `start` carries them directly with no transfer
 * gymnastics. `cancel` carries no payload: `AbortSignal` cannot cross the
 * worker boundary, so the controller translates its own `AbortSignal` into
 * this message, and the worker maintains its own `AbortController` that it
 * aborts on receipt (see proxy-encoder.worker.ts).
 */
import type { ProxyResolution } from "@/services/storage/types";
import type { ProxyGenerateResult } from "../proxy-generator";

export type ProxyEncoderInboundMessage =
	| { type: "start"; file: File; resolution: ProxyResolution }
	| { type: "cancel" };

export type ProxyEncoderOutboundMessage =
	| { type: "progress"; progress: number }
	| { type: "result"; result: ProxyGenerateResult }
	| { type: "error"; message: string };

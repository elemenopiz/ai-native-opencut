/**
 * Shared device selection for in-browser AI workers (Whisper, CLIP).
 *
 * WebGPU is *preferred* but never required — every worker has a WASM
 * fallback — so feature checks here only gate on primitives every supported
 * browser has (Workers). Model-specific requirements (e.g. Web Audio for
 * Whisper) stay with their feature modules.
 */

export type LocalAIDevice = "webgpu" | "wasm";

/**
 * Pick the best execution device for a Transformers.js worker.
 * Accepts the navigator so tests can exercise both branches.
 */
export function pickDevice(nav: Navigator = navigator): LocalAIDevice {
	// biome-ignore lint/suspicious/noExplicitAny: navigator.gpu missing from older lib.dom.
	return (nav as any).gpu ? "webgpu" : "wasm";
}

/**
 * True when the browser can run local AI workers at all (client-side with
 * Worker support). Individual features may layer extra checks on top.
 */
export function isLocalAISupported(): boolean {
	if (typeof window === "undefined") return false;
	return typeof Worker !== "undefined";
}

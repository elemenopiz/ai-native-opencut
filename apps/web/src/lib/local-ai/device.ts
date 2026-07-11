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
 * Accepts the environment's globals so tests can exercise every branch;
 * zero-arg calls read the real globals.
 */
export function isLocalAISupported(
	env: { window?: unknown; Worker?: unknown } = {
		window: typeof window === "undefined" ? undefined : window,
		Worker: typeof Worker === "undefined" ? undefined : Worker,
	},
): boolean {
	if (env.window === undefined) return false;
	return env.Worker !== undefined;
}

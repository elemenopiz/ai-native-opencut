/**
 * Backend registry — the single lookup table the router and UI read.
 *
 * Adapters call `registerBackend()` at module load (via the `video/` and
 * `image/` index barrels, imported once through `register-all.ts`). Everything
 * else asks the registry — never imports a concrete adapter — so adding a
 * provider is one file + one `registerBackend` call, no other edits.
 */

import type {
	BackendId,
	GenerationBackend,
	GenerationModality,
} from "@/lib/studio/backends/types";

const backends = new Map<BackendId, GenerationBackend>();

/** Register a backend. Later registration of the same id wins (test overrides). */
export function registerBackend(backend: GenerationBackend): void {
	backends.set(backend.id, backend);
}

export function getBackend(id: BackendId): GenerationBackend | undefined {
	return backends.get(id);
}

/** All registered backends, regardless of availability. */
export function allBackends(): GenerationBackend[] {
	return [...backends.values()];
}

/** Backends whose provider keys are actually configured right now. */
export function availableBackends(
	modality?: GenerationModality,
): GenerationBackend[] {
	return allBackends().filter(
		(b) =>
			b.isAvailable() && (modality === undefined || b.modality === modality),
	);
}

/**
 * The always-on default per modality — the backend we fall back to when nothing
 * better is available/configured. Today: Seedance (video), Gemini Flash Image
 * (image — the same GEMINI_API_KEY as the Director brain, so one key funds both).
 * A stable id keeps the router deterministic even as partner adapters come and go.
 */
export const DEFAULT_BACKEND_ID: Record<GenerationModality, BackendId> = {
	video: "byteplus-seedance",
	image: "google-nano-banana",
};

export function defaultBackend(
	modality: GenerationModality,
): GenerationBackend | undefined {
	return getBackend(DEFAULT_BACKEND_ID[modality]);
}

/**
 * Image backend registration barrel.
 *
 * Every image adapter is registered here. Gemini Flash Image (Nano Banana) is
 * the live default; the partner adapters below are real, complete code that
 * stays inert until their provider keys are set (`isAvailable() === false`).
 * To add one: create `./<provider>.ts` implementing `GenerationBackend`,
 * import it, and call `registerBackend` — no other file changes.
 */

import { registerBackend } from "@/lib/studio/backends/registry";
import { openaiGptImageBackend } from "@/lib/studio/backends/image/openai-gpt-image";
import { bflFluxBackend } from "@/lib/studio/backends/image/bfl-flux";
import { ideogramBackend } from "@/lib/studio/backends/image/ideogram";
import { googleImagenBackend } from "@/lib/studio/backends/image/google-imagen";
import { googleNanoBananaBackend } from "@/lib/studio/backends/image/google-nano-banana";
import { higgsfieldGptImageBackend } from "@/lib/studio/backends/image/higgsfield-gpt-image";
import { higgsfieldNanoBananaBackend } from "@/lib/studio/backends/image/higgsfield-nano-banana";
import { higgsfieldSoulBackend } from "@/lib/studio/backends/image/higgsfield-soul";

export function registerImageBackends(): void {
	registerBackend(googleNanoBananaBackend);

	// ── Additional image backends (env-gated, real API contracts) ──────────────
	// Each is real, complete code that stays inert until its provider key is set.
	registerBackend(openaiGptImageBackend);
	registerBackend(bflFluxBackend);
	registerBackend(ideogramBackend);
	registerBackend(googleImagenBackend);

	// ── Higgsfield-hosted image models ────────────────────────────────────────
	// Doubly gated: the shared HIGGSFIELD_CREDENTIALS *and* a per-model
	// HIGGSFIELD_*_ENDPOINT holding the REST path an operator confirmed in the
	// console. Registering them here is safe precisely because of that second
	// gate — configuring Higgsfield VIDEO does not silently enlist three image
	// backends with guessed endpoint paths into the router. See
	// `higgsfield-client.ts` for the rationale. Note these three are ASYNC
	// (submit → poll), unlike every other image adapter above.
	registerBackend(higgsfieldGptImageBackend);
	registerBackend(higgsfieldNanoBananaBackend);
	registerBackend(higgsfieldSoulBackend);
}

/**
 * Image backend registration barrel.
 *
 * Every image adapter is registered here. GPT Image is the live default; the
 * partner adapters below are real, complete code that stays inert until their
 * provider keys are set (`isAvailable() === false`). To add one: create
 * `./<provider>.ts` implementing `GenerationBackend`, import it, and call
 * `registerBackend` — no other file changes.
 */

import { registerBackend } from "@/lib/studio/backends/registry";
import { openaiGptImageBackend } from "@/lib/studio/backends/image/openai-gpt-image";
import { bflFluxBackend } from "@/lib/studio/backends/image/bfl-flux";
import { ideogramBackend } from "@/lib/studio/backends/image/ideogram";
import { googleImagenBackend } from "@/lib/studio/backends/image/google-imagen";
import { googleNanoBananaBackend } from "@/lib/studio/backends/image/google-nano-banana";

export function registerImageBackends(): void {
	registerBackend(openaiGptImageBackend);

	// ── Additional image backends (env-gated, real API contracts) ──────────────
	// Each is real, complete code that stays inert until its provider key is set.
	registerBackend(bflFluxBackend);
	registerBackend(ideogramBackend);
	registerBackend(googleImagenBackend);
	registerBackend(googleNanoBananaBackend);
}

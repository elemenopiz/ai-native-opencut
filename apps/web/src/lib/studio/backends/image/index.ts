/**
 * Image backend registration barrel.
 *
 * Only Google-backed adapters are registered for the beta — the only image
 * provider key currently funded. OpenAI GPT Image, BFL Flux, and Ideogram are
 * real, complete adapters (see their file headers) but are kept out of the
 * registry entirely so they can never be selected, regardless of whether a
 * stray unfunded key exists in the env. Re-add their `registerBackend` calls
 * once a provider is actually funded.
 */

import { registerBackend } from "@/lib/studio/backends/registry";
import { googleImagenBackend } from "@/lib/studio/backends/image/google-imagen";
import { googleNanoBananaBackend } from "@/lib/studio/backends/image/google-nano-banana";

export function registerImageBackends(): void {
	registerBackend(googleNanoBananaBackend);
	registerBackend(googleImagenBackend);
}

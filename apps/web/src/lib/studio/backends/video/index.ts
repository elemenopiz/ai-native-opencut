/**
 * Video backend registration barrel.
 *
 * Only Google- and Seedance-backed adapters are registered for the beta —
 * those are the only provider keys currently funded. Kling, Runway, Luma, and
 * Pika are real, complete adapters (see their file headers) but are kept out
 * of the registry entirely so they can never be selected, regardless of
 * whether a stray unfunded key exists in the env. Re-add their
 * `registerBackend` calls once a provider is actually funded.
 */

import { registerBackend } from "@/lib/studio/backends/registry";
import { byteplusSeedanceBackend } from "@/lib/studio/backends/video/byteplus-seedance";
import { googleVeoBackend } from "@/lib/studio/backends/video/google-veo";
import { googleVeoFastBackend } from "@/lib/studio/backends/video/google-veo-fast";

export function registerVideoBackends(): void {
	registerBackend(byteplusSeedanceBackend);
	registerBackend(googleVeoBackend);
	registerBackend(googleVeoFastBackend);
}

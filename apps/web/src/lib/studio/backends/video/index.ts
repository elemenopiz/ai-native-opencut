/**
 * Video backend registration barrel.
 *
 * Every video adapter is registered here. Seedance is the live default; the
 * partner adapters below are real, complete code that stays inert until their
 * provider keys are set (`isAvailable() === false`). To add one: create
 * `./<provider>.ts` implementing `GenerationBackend`, import it, and call
 * `registerBackend` — no other file changes.
 */

import { registerBackend } from "@/lib/studio/backends/registry";
import { byteplusSeedanceBackend } from "@/lib/studio/backends/video/byteplus-seedance";
import { googleVeoBackend } from "@/lib/studio/backends/video/google-veo";
import { googleVeoFastBackend } from "@/lib/studio/backends/video/google-veo-fast";
import { klingBackend } from "@/lib/studio/backends/video/kling";
import { lumaBackend } from "@/lib/studio/backends/video/luma";
import { pikaBackend } from "@/lib/studio/backends/video/pika";
import { runwayBackend } from "@/lib/studio/backends/video/runway";

export function registerVideoBackends(): void {
	registerBackend(byteplusSeedanceBackend);

	// ── Additional video backends (env-gated, real API contracts) ──────────────
	// Each is real, complete code that stays inert until its provider key(s)
	// are set — see the file header of each adapter for the exact endpoints
	// targeted and any UNVERIFIED fields to confirm against a live account.
	registerBackend(klingBackend);
	registerBackend(googleVeoBackend);
	registerBackend(googleVeoFastBackend);
	registerBackend(runwayBackend);
	registerBackend(lumaBackend);
	registerBackend(pikaBackend);
}

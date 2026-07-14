/**
 * One-shot backend initialization. Import `ensureBackendsRegistered()` from any
 * server entry that resolves a backend (the generate route, cost estimation) and
 * call it before touching the registry. Idempotent — safe to call repeatedly.
 */

import { registerVideoBackends } from "@/lib/studio/backends/video";
import { registerImageBackends } from "@/lib/studio/backends/image";
import { registerAudioBackends } from "@/lib/studio/backends/audio";

let registered = false;

export function ensureBackendsRegistered(): void {
	if (registered) return;
	registerVideoBackends();
	registerImageBackends();
	registerAudioBackends();
	registered = true;
}

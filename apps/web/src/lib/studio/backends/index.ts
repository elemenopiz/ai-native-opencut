/**
 * Public surface of the routed GenerationBackend layer.
 *
 * The unified generator stays the single front door; consumers import from here
 * and never touch a concrete adapter. Call `ensureBackendsRegistered()` first
 * (server side), then `routeSlot()` to pick a backend and `normalizeSeedLock()`
 * to hold identity across whichever backend was chosen.
 */

export * from "@/lib/studio/backends/types";
export {
	registerBackend,
	getBackend,
	allBackends,
	availableBackends,
	defaultBackend,
	DEFAULT_BACKEND_ID,
} from "@/lib/studio/backends/registry";
export { routeSlot, inferIntent } from "@/lib/studio/backends/router";
export type { RouteInput, RouteResult } from "@/lib/studio/backends/router";
export {
	normalizeSeedLock,
	type NormalizedRequest,
	type IdentityMechanism,
} from "@/lib/studio/backends/seed-lock";
export {
	toTakeCost,
	sumCredits,
	formatCredits,
	relativeCostTier,
} from "@/lib/studio/backends/cost";
export { ensureBackendsRegistered } from "@/lib/studio/backends/register-all";

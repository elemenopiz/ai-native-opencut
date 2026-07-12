/**
 * Closed-beta access gate constants, shared by the proxy (cookie check on
 * every page request) and POST /api/beta-gate (server-side code check +
 * cookie mint). Pure module — safe to import from edge and node runtimes.
 *
 * The shared 4-digit code lives in env `BETA_ACCESS_CODE` (falls back to the
 * default below). Rotating it invalidates every existing access cookie.
 */

export const BETA_COOKIE = "byorn_beta_access";

const DEFAULT_BETA_CODE = "6715";

export function betaAccessCode(): string {
	return process.env.BETA_ACCESS_CODE || DEFAULT_BETA_CODE;
}

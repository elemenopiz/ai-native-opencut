/**
 * Shared timeout wrapper for every outbound fetch in lib/studio.
 *
 * Serverless functions die at the platform wall-clock cap; a provider that
 * never answers must fail OUR way (a catchable error well before the cap),
 * not by letting the whole invocation hang. `AbortSignal.timeout` is used
 * instead of a manual AbortController + setTimeout so the signal stays armed
 * while the BODY is read too — `res.json()` / `res.arrayBuffer()` on a stalled
 * stream abort just like a stalled connect.
 *
 * (The studio media proxy's `pinnedFetch` in ssrf-guard.ts keeps its own
 * socket-level timeout — it can't use standard fetch because it pins DNS.)
 */

/** Default for submit/poll JSON round-trips. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** For calls that legitimately carry media bytes (downloads, inline-b64
 *  image generation) — these can be slow without being stuck. */
export const MEDIA_TIMEOUT_MS = 120_000;

export interface FetchTimeoutInit extends RequestInit {
	/** Whole-request budget (connect + headers + body). Default 30s. */
	timeoutMs?: number;
}

export async function fetchWithTimeout(
	input: string | URL,
	init: FetchTimeoutInit = {},
): Promise<Response> {
	const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, ...rest } = init;
	const timeout = AbortSignal.timeout(timeoutMs);
	// Combine with a caller-provided signal when the runtime supports it; the
	// timeout wins otherwise (it is the reason this wrapper exists).
	const combined =
		signal && typeof AbortSignal.any === "function"
			? AbortSignal.any([signal, timeout])
			: timeout;
	try {
		return await fetch(input, { ...rest, signal: combined });
	} catch (err) {
		if (timeout.aborted) {
			// Deliberately omits the URL: provider/media URLs can carry presigned
			// credentials and these messages flow into client-visible errors.
			throw new Error(`fetch timed out after ${timeoutMs}ms`);
		}
		throw err;
	}
}

import { toast } from "sonner";

/**
 * Centralized HTTP 401 handling for client-side API calls.
 *
 * A logged-out user hitting a gated route (paid AI generation, the studio board,
 * the LLM relay, etc.) would otherwise see a silent failure. {@link handleUnauthorized}
 * turns any 401 into a visible login prompt: a toast plus a global
 * `byorn:unauthorized` event that {@link SessionExpiredListener} (mounted once in
 * the root layout) converts into a router push to `/login`, preserving the
 * current location as the post-login return target.
 *
 * LOOP GUARD: requests to the auth endpoints themselves (`/api/auth/*`) are
 * ignored — a failed sign-in must not itself pop the login flow. A short debounce
 * collapses a burst of concurrent 401s (e.g. several in-flight generations, or a
 * background poll loop) into a single prompt.
 */

const AUTH_ENDPOINT_PREFIX = "/api/auth";

/** Global event that {@link SessionExpiredListener} subscribes to. */
export const UNAUTHORIZED_EVENT = "byorn:unauthorized";

/** Collapse a burst of concurrent 401s into a single prompt. */
const DEBOUNCE_MS = 10_000;

let lastPromptAt = 0;

function pathnameOf(url: string): string | null {
	try {
		return new URL(url, window.location.origin).pathname;
	} catch {
		return null;
	}
}

/**
 * Inspect a fetch `Response`; when it is a 401 from a non-auth endpoint, surface
 * the login flow (toast + `byorn:unauthorized` event). Returns `true` when the
 * response was unauthorized (so callers may branch on it), `false` otherwise.
 * Safe to call from any client code path; a no-op on the server.
 */
export function handleUnauthorized(response: Response, url: string): boolean {
	if (response.status !== 401) return false;
	// The login flow is a browser concern; never act on the server.
	if (typeof window === "undefined") return true;

	// Loop guard: a 401 from the auth endpoints themselves (a bad sign-in) must
	// not itself trigger the login redirect.
	const path = pathnameOf(url);
	if (path?.startsWith(AUTH_ENDPOINT_PREFIX)) return true;

	const now = Date.now();
	if (now - lastPromptAt < DEBOUNCE_MS) return true;
	lastPromptAt = now;

	toast.error("Please sign in to continue", {
		description: "Your session has expired or you are not signed in.",
	});
	window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
	return true;
}

function urlString(input: RequestInfo | URL): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	return input.url;
}

/**
 * Drop-in `fetch` wrapper that routes every response through
 * {@link handleUnauthorized}. Use for calls to our own gated API routes so a 401
 * consistently surfaces the login prompt. Returns the untouched `Response` — the
 * body is never read here, so callers keep full control of parsing.
 */
export async function apiFetch(
	input: RequestInfo | URL,
	init?: RequestInit,
): Promise<Response> {
	const response = await fetch(input, init);
	handleUnauthorized(response, urlString(input));
	return response;
}

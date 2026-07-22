import { toast } from "sonner";

/**
 * Centralized HTTP 401 handling for client-side API calls.
 *
 * A logged-out user hitting a gated route (paid AI generation, the studio board,
 * the LLM relay, etc.) would otherwise see a silent failure. {@link handleUnauthorized}
 * turns a 401 into a visible login prompt: a toast plus a global
 * `byorn:unauthorized` event that {@link SessionExpiredListener} (mounted once in
 * the root layout) converts into a router push to `/signup`, preserving the
 * current location as the post-login return target.
 *
 * TWO MODES, via {@link ApiFetchOptions.on401}:
 *  - "prompt" (default): the behavior above. Use for user-initiated calls
 *    (clicking Generate, promoting a take, sharing a project, ...) — a 401
 *    there is the actual money-moment signal the login prompt exists for.
 *  - "silent": still returns `true` so callers can branch on the 401, but
 *    never toasts, never dispatches the event, and never touches the
 *    debounce clock. Use for background hydration (loading history/board
 *    state on editor mount) — an anonymous user 401ing there is the normal
 *    steady state, not an error, and must not evict the user from the
 *    editor they haven't asked to leave. If the session really has expired,
 *    that surfaces on the next *user-initiated* (prompt-mode) 401 instead.
 *
 * LOOP GUARD: requests to the auth endpoints themselves (`/api/auth/*`) are
 * ignored — a failed sign-in must not itself pop the login flow. A short debounce
 * collapses a burst of concurrent prompt-mode 401s (e.g. several in-flight
 * generations) into a single prompt. Silent-mode 401s never count toward or
 * reset this debounce.
 */

const AUTH_ENDPOINT_PREFIX = "/api/auth";

/** Global event that {@link SessionExpiredListener} subscribes to. */
export const UNAUTHORIZED_EVENT = "byorn:unauthorized";

/** Collapse a burst of concurrent prompt-mode 401s into a single prompt. */
const DEBOUNCE_MS = 10_000;

let lastPromptAt = 0;

export type On401Mode = "prompt" | "silent";

export interface ApiFetchOptions {
	/** See the mode breakdown in the file-level doc comment above. Defaults to "prompt". */
	on401?: On401Mode;
}

/**
 * Extract a URL's pathname. The base is an arbitrary fixed placeholder, not
 * the real origin — we only ever inspect `.pathname`, and `URL` ignores the
 * base entirely for already-absolute inputs, so this works identically for
 * relative app routes and full URLs without requiring a DOM `window` (keeps
 * this — and everything built on it — unit-testable headlessly).
 */
function pathnameOf(url: string): string | null {
	try {
		return new URL(url, "http://localhost").pathname;
	} catch {
		return null;
	}
}

function isAuthEndpoint(url: string): boolean {
	const path = pathnameOf(url);
	return path?.startsWith(AUTH_ENDPOINT_PREFIX) ?? false;
}

/**
 * Pure decision: given a 401's URL and call options, plus the current time
 * and the last-prompt timestamp, should this 401 actually surface the login
 * prompt? Encapsulates silent-mode, the `/api/auth` loop guard, and the
 * debounce window in one place so it can be unit tested directly without a
 * DOM or fake timers.
 */
export function shouldPromptFor401(
	url: string,
	opts: ApiFetchOptions | undefined,
	now: number,
	lastPromptAtValue: number,
): boolean {
	if ((opts?.on401 ?? "prompt") === "silent") return false;
	if (isAuthEndpoint(url)) return false;
	return now - lastPromptAtValue >= DEBOUNCE_MS;
}

/**
 * Inspect a fetch `Response`; when it is a 401, and `opts.on401` is not
 * "silent", surface the login flow (toast + `byorn:unauthorized` event)
 * subject to the loop guard and debounce. Returns `true` whenever the
 * response was unauthorized — regardless of mode — so callers may branch on
 * it (e.g. treat it as "not logged in, skip this fetch's data"). `false`
 * otherwise. Safe to call from any client code path; a no-op on the server.
 */
export function handleUnauthorized(
	response: Response,
	url: string,
	opts?: ApiFetchOptions,
): boolean {
	if (response.status !== 401) return false;
	// The login flow is a browser concern; never act on the server.
	if (typeof window === "undefined") return true;

	const now = Date.now();
	if (!shouldPromptFor401(url, opts, now, lastPromptAt)) return true;

	lastPromptAt = now;

	// An invitation, not an error: the app is public and anonymous editing is
	// the normal state — this is the first sign-in touchpoint for an
	// account-gated action. (AI is for existing early-access accounts;
	// AiAccessNotice surfaces that inline before a call ever gets here.)
	toast("Sign in to continue", {
		description:
			"Editing is free and stays on your device. Some features need an account.",
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
 *
 * Pass `{ on401: "silent" }` for background/non-critical calls (e.g. hydrating
 * state on mount) where a 401 is an expected, unremarkable outcome for an
 * anonymous user and must not evict them from what they're doing. See the
 * mode breakdown in the file-level doc comment above. Defaults to "prompt",
 * so every existing call site is unaffected.
 */
export async function apiFetch(
	input: RequestInfo | URL,
	init?: RequestInit,
	opts?: ApiFetchOptions,
): Promise<Response> {
	const response = await fetch(input, init);
	handleUnauthorized(response, urlString(input), opts);
	return response;
}

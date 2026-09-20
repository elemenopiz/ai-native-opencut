/**
 * Failure classification for the generation boundary.
 *
 * A generation attempt can fail in categorically different ways, and the RIGHT
 * response differs per category: a 503 should be retried, a moderation rejection
 * should be rephrased, a malformed request should be surfaced to the user
 * immediately. Historically the Director only had an opaque error STRING to work
 * with, so every failure looked the same — a dead slot. This module turns a raw
 * error (an HTTP status and/or a message) into a structured
 * {@link GenerationFailure} whose `class` drives `director-api.ts`'s
 * self-correcting recovery loop.
 *
 * It is PURE: no I/O, no timers — just pattern-matching over what the provider
 * told us, so it is trivially unit-testable and shared by the executor boundary
 * (`studio-executor.ts`) and the Director's fallback path.
 */

import type { FailureClass, GenerationFailure } from "./types";

// Ordered, case-insensitive signals. SAFETY is checked first because a
// moderation rejection is frequently delivered as an otherwise-normal 400/422.
// `ip_detected` (Higgsfield's other documented terminal content-policy
// status, alongside `nsfw`) plus its plain-English kin — a public figure,
// trademark, branded character, or recognizable likeness in the prompt — are
// TERMINAL, not retryable: rephrasing is the only route, since the same
// prompt will trip the filter again on retry. Without a pattern here it fell
// through to the retryable "unknown" class and burned extra attempts against
// a request that could never succeed.
const SAFETY_RE =
	/\b(safety|moderation|moderat\w*|content[\s_-]?polic\w*|flagged|nsfw|not[\s_-]?safe|blocked|prohibit\w*|disallow\w*|violat\w*|sensitive|explicit|sexual|graphic content|policy violation|rejected by|ip[\s_-]?detected|intellectual property|public figure|trademark\w*|branded character|recognizable likeness|copyrighted character)\b/i;
const TIMEOUT_RE =
	/\b(timeout|timed[\s_-]?out|etimedout|deadline exceeded|took too long|request timed)\b/i;
// Retryable provider hiccups (network + overload + rate limiting).
const TRANSIENT_RE =
	/\b(network|fetch failed|failed to fetch|econnreset|econnrefused|enotfound|socket hang up|temporarily unavailable|service unavailable|overloaded|rate[\s_-]?limit\w*|too many requests|try again|retry)\b/i;
// Non-retryable bad requests (the caller sent something the provider refuses).
const INVALID_RE =
	/\b(invalid|unsupported|malformed|bad request|unprocessable|must be a|is required|missing required|unknown field|not a valid)\b/i;
const EMPTY_RE =
	/\b(no media|empty result|no output|returned nothing|zero frames|no result|produced no)\b/i;

/** Distinct, user-safe copy per class (kept out of the raw provider text). */
const MESSAGE: Record<FailureClass, string> = {
	provider: "The generation provider returned an error.",
	timeout: "The generation timed out before finishing.",
	safety: "The prompt was rejected by the content-safety filter.",
	empty: "The provider finished but returned no media.",
	unknown: "The generation failed for an unrecognized reason.",
};

function make(
	cls: FailureClass,
	retryable: boolean,
	opts: { status?: number; detail?: string; message?: string } = {},
): GenerationFailure {
	return {
		class: cls,
		message: opts.message ?? MESSAGE[cls],
		retryable,
		...(opts.status != null ? { status: opts.status } : {}),
		...(opts.detail ? { detail: opts.detail } : {}),
	};
}

/**
 * Classify a raw generation failure into a structured {@link GenerationFailure}.
 *
 * Precedence: an explicit `empty` flag wins; then the HTTP `status` (the most
 * reliable signal a provider gives); then message pattern-matching. A safety
 * signal in the message overrides a generic 4xx, because moderation rejections
 * are commonly returned as 400/422.
 */
export function classifyFailure(input: {
	/** Raw error (Error, string, or anything stringifiable). */
	error?: unknown;
	/** HTTP/provider status code, when known. */
	status?: number;
	/** Set when the call "succeeded" but yielded no media. */
	empty?: boolean;
}): GenerationFailure {
	const detail =
		input.error instanceof Error
			? input.error.message
			: input.error != null
				? String(input.error)
				: undefined;
	const status = input.status;

	if (input.empty) {
		return make("empty", true, { status, detail });
	}

	const text = detail ?? "";

	// A safety signal in the text takes precedence over any status code.
	if (SAFETY_RE.test(text)) {
		return make("safety", false, { status, detail });
	}

	// Status-driven classification (most reliable when present).
	if (status != null) {
		if (status === 408 || status === 504) {
			return make("timeout", true, { status, detail });
		}
		if (status === 451) {
			return make("safety", false, { status, detail });
		}
		if (status === 429 || status >= 500) {
			return make("provider", true, { status, detail });
		}
		if (status >= 400) {
			// A non-safety 4xx is a bad request: unrecoverable, escalate.
			return make("provider", false, {
				status,
				detail,
				message: "The request was rejected as invalid by the provider.",
			});
		}
	}

	// Message-driven fallback.
	if (TIMEOUT_RE.test(text)) return make("timeout", true, { status, detail });
	if (EMPTY_RE.test(text)) return make("empty", true, { status, detail });
	if (TRANSIENT_RE.test(text))
		return make("provider", true, { status, detail });
	if (INVALID_RE.test(text)) {
		return make("provider", false, {
			status,
			detail,
			message: "The request was rejected as invalid by the provider.",
		});
	}

	// Nothing matched — treat as unknown, worth one cautious retry.
	return make("unknown", true, { status, detail });
}

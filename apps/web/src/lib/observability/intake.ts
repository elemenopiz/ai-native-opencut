/**
 * Client-error intake: payload validation + secret redaction.
 *
 * Pure module (no Next.js imports) so the abuse-safety logic of
 * `/api/telemetry/error` is unit-testable in isolation. The route zod-parses
 * the body with {@link clientErrorSchema}, then runs every string through
 * {@link redactSecrets} before anything is logged — browser error messages and
 * stacks can accidentally embed URLs with `?token=`, JWTs, or raw keys.
 */

import { z } from "zod";

/** Hard cap on the raw request body. Real error payloads are a few KB. */
export const MAX_BODY_BYTES = 32 * 1024;

/**
 * Shape a browser is allowed to report. Everything optional except `message`;
 * lengths capped so a hostile client can't stuff megabytes into one field
 * (belt to the body-size suspenders).
 */
export const clientErrorSchema = z.object({
	message: z.string().min(1).max(4_000),
	name: z.string().max(200).optional(),
	stack: z.string().max(12_000).optional(),
	componentStack: z.string().max(8_000).optional(),
	digest: z.string().max(200).optional(),
	route: z.string().max(1_000).optional(),
	userAgent: z.string().max(1_000).optional(),
	source: z
		.enum([
			"window.onerror",
			"unhandledrejection",
			"global-error",
			"route-error",
			"manual",
		])
		.optional(),
});

export type ClientErrorPayload = z.infer<typeof clientErrorSchema>;

/**
 * `key=...` / `token: ...` style assignments. Redacts the VALUE, keeps the
 * key name so the log line stays diagnosable. Covers query strings, JSON-ish
 * fragments, and `Authorization: Bearer ...` headers quoted into messages.
 */
const KEY_VALUE_PATTERN =
	/\b(api[-_]?key|key|token|secret|password|passwd|credential|authorization|auth)\b(["']?\s*[=:]\s*)(bearer\s+)?["']?[^\s&"',;}]+/gi;

/**
 * Long unbroken base64/url-safe runs (JWT segments, raw API keys). 40+ chars
 * with no `/` so ordinary file paths in stack traces survive; each dot-
 * separated JWT segment matches on its own.
 */
const BASE64_RUN_PATTERN = /[A-Za-z0-9+_-]{40,}={0,2}/g;

/** Long hex runs (session ids, HMACs, sha1/sha256 digests). */
const HEX_RUN_PATTERN = /\b[a-fA-F0-9]{32,}\b/g;

/**
 * Best-effort scrub of anything secret-shaped from a single string. This is
 * abuse-safety hygiene, not a guarantee — the intake endpoint is unauthenticated
 * and its output lands in logs.
 */
export function redactSecrets(input: string): string {
	return input
		.replace(KEY_VALUE_PATTERN, "$1$2[redacted]")
		.replace(BASE64_RUN_PATTERN, "[redacted]")
		.replace(HEX_RUN_PATTERN, "[redacted]");
}

/** Apply {@link redactSecrets} to every string field of a validated payload. */
export function redactPayload(payload: ClientErrorPayload): ClientErrorPayload {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(payload)) {
		out[key] = typeof value === "string" ? redactSecrets(value) : value;
	}
	return out as ClientErrorPayload;
}

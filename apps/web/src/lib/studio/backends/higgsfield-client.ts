/**
 * Shared Higgsfield transport — auth, submit/poll plumbing, and status mapping
 * for EVERY Higgsfield adapter: the video adapter (`video/higgsfield.ts`) and
 * every non-video one (the three image models in `image/`, plus
 * `audio/higgsfield-seed-audio.ts`).
 *
 * HISTORY: this file used to live at `image/higgsfield-client.ts`. It started
 * as a copy of plumbing `video/higgsfield.ts` already had, written before
 * there was a second Higgsfield modality, then got its own file when the
 * image adapters landed — but under a file-ownership boundary that put
 * `backends/video/**` and the `backends/` root off-limits, so the shared code
 * landed in the one directory it could, with a documented follow-up to hoist
 * it. That follow-up is this move: the file now lives at
 * `backends/higgsfield-client.ts`, next to `cost.ts` / `seed-lock.ts`, and
 * `video/higgsfield.ts` imports it too instead of carrying its own duplicate
 * copy of auth/status/error handling. Behavior is unchanged — this was a pure
 * relocation plus the error-shape fix described below.
 *
 * WHAT IS VERIFIED HERE
 * The auth scheme and the request/response envelope are carried over verbatim
 * from `video/higgsfield.ts`'s original plumbing, which derived them by
 * reading the official SDK source (`@higgsfield/client` v0.2.6): one
 * credential string in `key-id:key-secret` form sent as `Authorization: Key
 * ${keyId}:${keySecret}`; submit is `POST /<endpoint-path>` with the input
 * object as the JSON body directly (NOT wrapped in a `params` key); poll is
 * `GET /requests/{request_id}/status`; both answer with the same
 * `{ status, request_id, status_url, cancel_url, images?, video? }` shape.
 *
 * A later live probe (2026-09-19, unfunded API key against
 * `https://api.higgsfield.ai`, cross-checked against the official reference
 * at open.higgsfield.ai) additionally confirmed: the REST path shape is
 * `/{vendor}/{model}/{tier}/{task?}` — a TIER segment, not a task verb — and
 * TWO validation-error shapes exist and must both be handled:
 *   - the video endpoint (`bytedance/seedance-2.5/text-to-video`) answers
 *     `400` with JSON-schema style `{"detail": "resolution: '…' is not one
 *     of […]"}`;
 *   - `higgsfield-ai/soul/v2/standard` (see `image/higgsfield-soul.ts`)
 *     answers `422` with FastAPI style `[{type, loc, msg?}]` — a bare array
 *     at the response root, not wrapped in an object.
 * `higgsfieldHttpErrorMessage` below reads both. Previously it only read
 * `body.error ?? body.message`, which is present in NEITHER shape — a real
 * validation failure from either endpoint came back as a bare
 * "Higgsfield validation error (422)" with no indication of what was wrong.
 *
 * WHAT IS NOT VERIFIED
 * The per-model ENDPOINT PATHS for the three still-gated adapters (GPT Image,
 * Nano Banana, Seed Audio) — see each adapter file; two of the three are now
 * MEASURED 404s, not just unverified. And the audio result field remains
 * unverified. Higgsfield's own public repos (the `higgsfield` CLI and the
 * agent-skills repo) document the CLI surface, where a model is a flat id
 * like `gpt_image_2_5`; our adapters post to REST endpoint PATHS
 * (`<vendor>/<model>/<tier>/<task?>`), a different surface. Nothing in those
 * repos maps one to the other, so most of the paths in this codebase are
 * constructed or probed, not documented. That is exactly why every
 * non-video adapter refuses to report `isAvailable()` until an operator
 * supplies a confirmed path via its own env var — see `higgsfieldEndpoint()`.
 *
 * CUSTOMER-FACING ERROR HYGIENE: the standing rule for this app is that
 * customer surfaces never show raw technical errors, provider internals, env
 * var names, or paths in their PRIMARY copy (see e.g. `reference-fetch.ts`'s
 * `ReferenceFetchError`, which throws one fixed generic message and logs the
 * real detail server-side instead). `higgsfieldHttpErrorMessage` below keeps
 * that spirit for the validation-error case specifically: the message that
 * reaches `SubmitResult.error`/`PollResult.error` (and from there a customer
 * surface, per `settle-generation.ts`'s "friendly label only" rule) carries a
 * SHORT, human-safe phrase derived from the validation shape (e.g. "prompt is
 * required"), never the raw `loc`/`type` JSON or the provider's full
 * validation sentence verbatim; the complete raw body is logged server-side
 * via `logger.warn` for whoever debugs it next.
 *
 * DELIBERATE: no `@higgsfield/client` SDK, same reason as always — its
 * `subscribe()` helper blocks and polls internally, which cannot satisfy the
 * `submit()`/`poll()` split the router needs (return a `jobId` now, let the
 * caller choose its own polling cadence).
 */

import { webEnv } from "@byorn/env/web";
import { logger } from "@/lib/observability/logger";
import { fetchWithTimeout } from "@/lib/studio/fetch-timeout";
import type {
	JobStatus,
	PollResult,
	SubmitResult,
} from "@/lib/studio/backends/types";
import type { ImageSize } from "@/lib/studio/image-generator";

const DEFAULT_BASE = "https://api.higgsfield.ai";

export function higgsfieldBase(): string {
	return webEnv.HIGGSFIELD_BASE_URL || DEFAULT_BASE;
}

export interface HiggsfieldCredentials {
	keyId: string;
	keySecret: string;
}

/**
 * `HIGGSFIELD_CREDENTIALS` is the single "key-id:key-secret" string, split on
 * the first `:`. `undefined` when unset or malformed (not exactly 2 non-empty
 * parts) — callers treat that as "not configured" and stay inert. One rule
 * shared by every Higgsfield modality (video included), so one key configures
 * all of them identically.
 */
export function higgsfieldCredentialParts(): HiggsfieldCredentials | undefined {
	const raw = webEnv.HIGGSFIELD_CREDENTIALS;
	if (!raw) return undefined;
	const parts = raw.split(":");
	if (parts.length !== 2) return undefined;
	const [keyId, keySecret] = parts;
	if (!keyId || !keySecret) return undefined;
	return { keyId, keySecret };
}

/**
 * The confirmed REST endpoint path for one model, or `undefined`.
 *
 * This is the enable gate for every non-video Higgsfield adapter, and it is
 * deliberately STRICTER than "is the API key set". `HIGGSFIELD_CREDENTIALS` is
 * already set by anyone using the Higgsfield VIDEO backend; if these adapters
 * went live on that key alone, the moment video was configured the router would
 * start handing `broll-still` / `character-still` slots to an image backend
 * whose endpoint path we GUESSED — producing 404s in front of a customer, in a
 * product whose standing rule is that customers never see technical errors.
 *
 * So an operator must paste the path they confirmed into the model's own env
 * var before the adapter reports available. The built-in `fallback` kept next
 * to each adapter is documentation of our best guess (or, for Soul, a VERIFIED
 * path — see `image/higgsfield-soul.ts`) and is NOT used to satisfy
 * availability on its own.
 *
 * Returns the path with a guaranteed leading `/` (the SDK prefixes one if
 * absent; we do the same).
 */
export function higgsfieldEndpoint(configured: string): string | undefined {
	const trimmed = configured.trim();
	if (!trimmed) return undefined;
	return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/** Both halves of "configured": credentials AND a confirmed endpoint path. */
export function higgsfieldReady(configured: string): boolean {
	return (
		Boolean(higgsfieldCredentialParts()) &&
		Boolean(higgsfieldEndpoint(configured))
	);
}

// ─── Status mapping ─────────────────────────────────────────────────────────
// SDK's status union is 'queued' | 'in_progress' | 'completed' | 'failed' |
// 'nsfw'. `canceled`/`cancelled` are handled defensively even though the SDK's
// type union omits them — the live API may still send one.
export function mapHiggsfieldStatus(s: string | undefined): JobStatus {
	switch (s) {
		case "completed":
			return "completed";
		case "in_progress":
			return "processing";
		case "queued":
			return "pending";
		case "failed":
		case "nsfw":
		case "canceled":
		case "cancelled":
			return "failed";
		default:
			return "pending";
	}
}

export interface HiggsfieldResponse {
	status?: string;
	request_id?: string;
	status_url?: string;
	cancel_url?: string;
	/** CONFIRMED (SDK source): image results. */
	images?: { url: string }[];
	/** CONFIRMED (SDK source): video results. */
	video?: { url: string };
	/** UNVERIFIED: no first-party source we can reach documents what an AUDIO
	 *  job returns. Both singular and plural shapes are read defensively so a
	 *  correct render is not thrown away over a field-name guess; if neither
	 *  matches, `poll` reports `completed` with no `mediaUrl` and the caller
	 *  surfaces a normal "no media" outcome rather than crashing. */
	audio?: { url: string };
	/** @see HiggsfieldResponse.audio — UNVERIFIED. */
	audios?: { url: string }[];
	/** @see HiggsfieldResponse.audio — UNVERIFIED generic result envelope. */
	results?: { url: string }[];
	error?: string;
	message?: string;
}

/**
 * First media URL in a Higgsfield response, across every result shape we know
 * of. Ordered most- to least-confirmed so a verified field always wins over a
 * defensive guess.
 */
export function higgsfieldMediaUrl(
	data: HiggsfieldResponse,
): string | undefined {
	return (
		data.video?.url ??
		data.images?.[0]?.url ??
		data.audio?.url ??
		data.audios?.[0]?.url ??
		data.results?.[0]?.url
	);
}

// ─── Error-shape handling ───────────────────────────────────────────────────

/** One item of a FastAPI-style 422 validation array:
 *  `[{type: "missing", loc: ["body", "prompt"], msg?: "..."}]`. */
interface HiggsfieldValidationItem {
	type?: string;
	loc?: unknown[];
	msg?: string;
}

/** The LAST path segment of a validation item's `loc`, if it's a plain field
 *  name — `["body", "prompt"]` → `"prompt"`. That's the one piece of a FastAPI
 *  validation error that's genuinely useful to surface (a field name), without
 *  forwarding the whole internal `loc`/`type` structure. */
function fieldNameFrom(item: HiggsfieldValidationItem): string | undefined {
	const loc = item.loc;
	if (!Array.isArray(loc) || loc.length === 0) return undefined;
	const last = loc[loc.length - 1];
	return typeof last === "string" ? last : undefined;
}

/** Turns a FastAPI-style 422 validation array into a short, human-safe phrase
 *  — e.g. `[{type:"missing",loc:["body","prompt"]}]` → `"prompt is required"`.
 *  Returns `undefined` for a shape this can't summarize, so the caller can
 *  fall through to a generic message instead of an empty one. */
function summarizeValidationItems(items: unknown[]): string | undefined {
	const phrases = items
		.map((raw) => {
			if (!raw || typeof raw !== "object") return undefined;
			const item = raw as HiggsfieldValidationItem;
			const field = fieldNameFrom(item);
			if (!field) return undefined;
			return item.type === "missing"
				? `${field} is required`
				: `${field} is invalid`;
		})
		.filter((s): s is string => Boolean(s));
	return phrases.length > 0 ? phrases.join(", ") : undefined;
}

/**
 * Extracts a short, human-safe detail phrase from an error response body,
 * tolerating every shape a Higgsfield endpoint is known to answer with:
 *   - `{error: "..."}` / `{message: "..."}` — the shape the original
 *     plumbing assumed (still seen on some errors, e.g. 401/403).
 *   - `{detail: "a sentence"}` — the video endpoint's 400 (JSON-schema style).
 *   - `{detail: [...]}` or a bare `[...]` at the root — FastAPI's 422 array,
 *     as `higgsfield-ai/soul/v2/standard` answers it.
 * Never returns the raw validation array/object itself — only a derived
 * phrase — so a customer-facing message built from this can't leak `loc`/
 * `type` JSON. The full raw body is logged separately; see
 * `higgsfieldHttpErrorMessage`.
 */
function extractDetail(body: unknown): string | undefined {
	if (Array.isArray(body)) return summarizeValidationItems(body);
	if (!body || typeof body !== "object") return undefined;
	const obj = body as Record<string, unknown>;
	if (typeof obj.error === "string" && obj.error.trim())
		return obj.error.trim();
	if (typeof obj.message === "string" && obj.message.trim())
		return obj.message.trim();
	const detail = obj.detail;
	if (typeof detail === "string" && detail.trim()) return detail.trim();
	if (Array.isArray(detail)) return summarizeValidationItems(detail);
	return undefined;
}

/**
 * HTTP status → a human-readable, customer-safe reason: 401 auth, 403
 * not-enough-credits, 422 validation, 400 bad input. The short `detail`
 * phrase (see `extractDetail`) is appended when one could be derived; the
 * complete raw body is always logged server-side via `logger.warn` (never
 * only embedded in the returned string), so a technical validation dump never
 * becomes the only record of what actually went wrong.
 */
export function higgsfieldHttpErrorMessage(
	status: number,
	body: unknown,
): string {
	const detail = extractDetail(body);
	logger.warn("higgsfield: request failed", { status, body });
	switch (status) {
		case 401:
			return `Higgsfield auth failed (401)${detail ? `: ${detail}` : ""}`;
		case 403:
			return `Higgsfield: not enough credits (403)${detail ? `: ${detail}` : ""}`;
		case 422:
			return `Higgsfield validation error (422)${detail ? `: ${detail}` : ""}`;
		case 400:
			return `Higgsfield bad input (400)${detail ? `: ${detail}` : ""}`;
		default:
			return `Higgsfield request failed (${status})${detail ? `: ${detail}` : ""}`;
	}
}

export async function higgsfieldRequest(
	path: string,
	init: RequestInit,
): Promise<HiggsfieldResponse> {
	const creds = higgsfieldCredentialParts();
	if (!creds) {
		throw new Error("HIGGSFIELD_CREDENTIALS is not configured");
	}
	const res = await fetchWithTimeout(`${higgsfieldBase()}${path}`, {
		...init,
		headers: {
			...init.headers,
			Authorization: `Key ${creds.keyId}:${creds.keySecret}`,
			"Content-Type": "application/json",
		},
	});
	// Parsed as `unknown`, not `HiggsfieldResponse`: an error body can be a bare
	// array (the 422 validation shape) or otherwise not match the success
	// envelope's fields at all — see `extractDetail`/`higgsfieldHttpErrorMessage`.
	const raw: unknown = await res.json().catch(() => undefined);
	if (!res.ok) {
		throw new Error(higgsfieldHttpErrorMessage(res.status, raw));
	}
	return (raw ?? {}) as HiggsfieldResponse;
}

/**
 * Submit one Higgsfield job. Shared by all four non-video adapters so there is
 * a single place where the endpoint gate, the request envelope, and the
 * "never throw for a provider error" contract are enforced.
 *
 * `configuredEndpoint` is the operator-supplied path (see `higgsfieldEndpoint`)
 * — an empty value fails fast with a message naming the env var to set, rather
 * than firing a request at a guessed URL.
 */
export async function submitHiggsfieldJob(params: {
	configuredEndpoint: string;
	endpointEnvVar: string;
	/** The documented best-known path for this model, quoted in the
	 *  not-configured error so an operator knows the SHAPE they're being asked
	 *  to confirm. For most models this is still an unconfirmed guess (or a
	 *  measured 404 — see each adapter's header); for Soul it is a path
	 *  verified to exist. Either way it's documentation, never sent on the
	 *  wire unless an operator copies it into `configuredEndpoint`. */
	assumedEndpoint: string;
	body: Record<string, unknown>;
	label: string;
}): Promise<SubmitResult> {
	const { configuredEndpoint, endpointEnvVar, assumedEndpoint, body, label } =
		params;
	try {
		const path = higgsfieldEndpoint(configuredEndpoint);
		if (!path) {
			throw new Error(
				`${endpointEnvVar} is not configured — set it to the Higgsfield REST endpoint path for ${label} (documented best-known path: "${assumedEndpoint}")`,
			);
		}
		const data = await higgsfieldRequest(path, {
			method: "POST",
			body: JSON.stringify(body),
		});

		const requestId = data.request_id;
		if (!requestId) {
			return {
				jobId: "",
				status: "failed",
				error: `${label} returned no request_id`,
			};
		}

		return {
			jobId: requestId,
			status: mapHiggsfieldStatus(data.status),
			// Fast models may answer the POST already `completed` with the media
			// inline; carrying it through means the caller never has to poll for a
			// job that is already done.
			mediaUrl: higgsfieldMediaUrl(data),
		};
	} catch (err) {
		return {
			jobId: "",
			status: "failed",
			error: err instanceof Error ? err.message : `${label} submit failed`,
		};
	}
}

// ─── Image helpers ──────────────────────────────────────────────────────────

/**
 * Byorn's `ImageSize` wire type → a Higgsfield `aspect_ratio` string.
 *
 * Shared by all three image adapters here because the three ratios our wire
 * type can express (1:1, 3:2, 2:3) are in EVERY one of their documented
 * aspect-ratio enums (`gpt_image_2_5`, `nano_banana_2`, `soul_cinematic` —
 * first-party flag tables in Higgsfield's CLI repo, MODELS.md). The models'
 * fuller ratio sets differ from each other, but none of that surface is
 * reachable until `ImageSize` itself grows — and `ImageSize` lives in
 * `lib/studio/image-generator.ts`, which the persona-still path, the image
 * route, and the DB records all key off, so widening it is its own change.
 */
export function higgsfieldAspectRatio(size: ImageSize | undefined): string {
	switch (size) {
		case "1536x1024":
			return "3:2";
		case "1024x1536":
			return "2:3";
		default:
			return "1:1";
	}
}

/** Poll one Higgsfield job to a terminal state. Never throws — a transport or
 *  HTTP failure comes back as `status: "failed"` so the caller can fall back. */
export async function pollHiggsfieldJob(
	jobId: string,
	label: string,
): Promise<PollResult> {
	try {
		const data = await higgsfieldRequest(`/requests/${jobId}/status`, {
			method: "GET",
		});
		return {
			jobId,
			status: mapHiggsfieldStatus(data.status),
			mediaUrl: higgsfieldMediaUrl(data),
			error: data.error ?? data.message,
		};
	} catch (err) {
		return {
			jobId,
			status: "failed",
			error: err instanceof Error ? err.message : `${label} poll failed`,
		};
	}
}

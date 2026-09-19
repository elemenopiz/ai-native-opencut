/**
 * Shared Higgsfield transport — auth, submit/poll plumbing, and status mapping
 * for every NON-video Higgsfield adapter (the three image models in this
 * directory and `../audio/higgsfield-seed-audio.ts`).
 *
 * WHY THIS FILE EXISTS, AND WHY IT LIVES HERE
 * `video/higgsfield.ts` already contains an identical copy of this plumbing,
 * written before there was a second Higgsfield modality. The right home for
 * all of it is a single `backends/higgsfield-client.ts` sitting next to
 * `cost.ts` / `seed-lock.ts`, with the video adapter importing it too — but
 * this change was built under a file-ownership boundary that put
 * `backends/video/**` and the `backends/` root off-limits, so the shared code
 * landed in the one directory it could. FOLLOW-UP (cheap, mechanical): move
 * this file to `backends/higgsfield-client.ts`, update the four importers
 * below, and delete the duplicated helpers from `video/higgsfield.ts` so there
 * is exactly ONE copy of the auth/status contract to correct when a live
 * account finally settles the UNVERIFIED bits.
 *
 * WHAT IS VERIFIED HERE
 * The auth scheme and the request/response envelope are carried over verbatim
 * from `video/higgsfield.ts`, which derived them by reading the official SDK
 * source (`@higgsfield/client` v0.2.6): one credential string in
 * `key-id:key-secret` form sent as `Authorization: Key ${keyId}:${keySecret}`;
 * submit is `POST /<endpoint-path>` with the input object as the JSON body
 * directly (NOT wrapped in a `params` key); poll is
 * `GET /requests/{request_id}/status`; both answer with the same
 * `{ status, request_id, status_url, cancel_url, images?, video? }` shape.
 *
 * WHAT IS NOT
 * The per-model ENDPOINT PATHS and the audio result field are not confirmed by
 * any first-party source we can reach — see each adapter file. Higgsfield's own
 * public repos (the `higgsfield` CLI and the agent-skills repo) document the
 * CLI surface, where a model is a flat id like `gpt_image_2_5`; our adapters
 * post to REST endpoint PATHS (`<vendor>/<model>/<task>`), a different surface.
 * Nothing in those repos maps one to the other, so the paths below are
 * constructed, not read. That is exactly why every adapter here refuses to
 * report `isAvailable()` until an operator supplies the confirmed path via its
 * own env var — see `higgsfieldEndpoint()`.
 *
 * DELIBERATE: no `@higgsfield/client` SDK, same reason as the video adapter —
 * its `subscribe()` helper blocks and polls internally, which cannot satisfy
 * the `submit()`/`poll()` split the router needs (return a `jobId` now, let the
 * caller choose its own polling cadence).
 */

import { webEnv } from "@byorn/env/web";
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
 * parts) — callers treat that as "not configured" and stay inert. Byte-for-byte
 * the same rule as `video/higgsfield.ts`'s private `credentialParts()`, so one
 * key configures every Higgsfield modality identically.
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
 * So an operator must paste the path they confirmed in the Higgsfield console
 * into the model's own env var before the adapter reports available. The
 * built-in `fallback` is kept next to each adapter as documentation of our best
 * guess (and so flipping this gate off later is a one-line change), but it is
 * NOT used to satisfy availability.
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

/** HTTP status → a human-readable reason: 401 auth, 403 not-enough-credits,
 *  422 validation, 400 bad input. Mirrors `video/higgsfield.ts` so one provider
 *  speaks with one voice regardless of modality. */
export function higgsfieldHttpErrorMessage(
	status: number,
	body: HiggsfieldResponse,
): string {
	const detail = body.error ?? body.message;
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
	const data = (await res.json()) as HiggsfieldResponse;
	if (!res.ok) {
		throw new Error(higgsfieldHttpErrorMessage(res.status, data));
	}
	return data;
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
	/** Our unconfirmed best guess at the path, quoted in the not-configured
	 *  error so an operator knows the SHAPE they're being asked to confirm. */
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
				`${endpointEnvVar} is not configured — set it to the Higgsfield REST endpoint path for ${label} (unconfirmed guess: "${assumedEndpoint}")`,
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

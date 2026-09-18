/**
 * VIDEO adapter — Higgsfield AI, Seedance 2.5 (`bytedance/seedance-2.5/text-to-video`).
 *
 * Auth is ONE credential string in `key-id:key-secret` form (`HIGGSFIELD_CREDENTIALS`,
 * validated env schema at `@byorn/env/web`), split on `:` and sent as
 * `Authorization: Key ${keyId}:${keySecret}`. Submit is a plain `POST /<endpoint>`
 * with the input object as the JSON body directly (NOT wrapped in a `params`
 * key); poll is `GET /requests/{request_id}/status`. Both return the same shape:
 * `{ status, request_id, status_url, cancel_url, images?: [{url}], video?: {url} }`.
 * Verified by reading the official SDK source (`@higgsfield/client` v0.2.6,
 * `/home/user/higgsfield-ai/higgsfield-js`) — `api.higgsfield.ai` and
 * `docs.higgsfield.ai` are both blocked by this environment's egress proxy, so
 * none of this has been exercised against a live key. The input body's field
 * names (`prompt`/`duration`/`resolution`/`aspect_ratio`/`generate_audio`) are
 * additionally cross-checked against Higgsfield's own CLI repo
 * (github.com/higgsfield-ai/cli, MODELS.md) for the closely-related
 * `seedance_2_0` model — 2.5 itself predates that doc by two days, so those
 * names are ASSUMED STABLE across the version bump, not independently
 * verified for 2.5. `mode` is deliberately omitted (see `buildSubmitBody`)
 * because two first-party sources disagree on what it means for 2.5 and there
 * is no way to resolve that without the console. Treat every remaining
 * UNVERIFIED marker below as needing confirmation against a live account
 * before this adapter is promoted out of "inert".
 *
 * DELIBERATE: we do NOT use the `@higgsfield/client` SDK here even though it's
 * installed. Its `subscribe()` helper blocks and polls internally (submit +
 * wait-for-terminal-state as one call), which doesn't fit our `submit()` /
 * `poll()` split — the router needs to return a `jobId` immediately and let the
 * caller poll on its own cadence. So this file talks to the same raw HTTP
 * endpoints the SDK wraps, via `fetchWithTimeout`, exactly like every other
 * adapter in this directory.
 */

import { webEnv } from "@byorn/env/web";
import { costFor } from "@/lib/credits/cost-table";
import { fetchWithTimeout } from "@/lib/studio/fetch-timeout";
import type {
	BackendRequest,
	CostEstimate,
	GenerationBackend,
	JobStatus,
	PollResult,
	SubmitResult,
} from "@/lib/studio/backends/types";
import type { VideoOrientation } from "@/lib/studio/provider-adapter";

const DEFAULT_BASE = "https://api.higgsfield.ai";
const DEFAULT_MODEL = "bytedance/seedance-2.5/text-to-video";

function higgsfieldBase(): string {
	return webEnv.HIGGSFIELD_BASE_URL || DEFAULT_BASE;
}

function higgsfieldModel(): string {
	return webEnv.HIGGSFIELD_MODEL || DEFAULT_MODEL;
}

/** `HIGGSFIELD_CREDENTIALS` is the single "key-id:key-secret" string, split on
 *  the first `:`. `undefined` when unset or malformed (not exactly 2 parts) —
 *  callers treat that as "not configured" and stay inert. */
function credentialParts(): { keyId: string; keySecret: string } | undefined {
	const raw = webEnv.HIGGSFIELD_CREDENTIALS;
	if (!raw) return undefined;
	const parts = raw.split(":");
	if (parts.length !== 2) return undefined;
	const [keyId, keySecret] = parts;
	if (!keyId || !keySecret) return undefined;
	return { keyId, keySecret };
}

// ─── Aspect ratio ───────────────────────────────────────────────────────────

const RATIO_BY_ORIENTATION: Record<VideoOrientation, string> = {
	landscape: "16:9",
	portrait: "9:16",
	square: "1:1",
};

// Confirmed against MODELS.md (seedance_2_0): plain "480p" | "720p" | "1080p"
// | "4k" strings, default "720p". "4k" is deliberately withheld from our
// `capabilities.resolutions` (same cost-control precedent as Veo's withheld
// 4k and Seedance 2.0's own withheld 2k tier — see byteplus-seedance.ts).
function resolutionValue(resolution: string | undefined): string {
	return resolution ?? "720p";
}

// Seedance 2.5 renders the requested duration verbatim within [4, 30]s rather
// than snapping to a discrete set (contrast Kling's `snapDurationSec`, which
// snaps to 5|10 — see that file's header comment for why a SINGLE clamp helper
// matters). This is the ONE place `submit`, `estimateCost`, and
// `resolveDurationSec` all clamp, so the seconds we submit to Higgsfield always
// equal the seconds we bill — no second copy of the rule to drift.
const MIN_DURATION_SEC = 4;
const MAX_DURATION_SEC = 30;

function clampDurationSec(sec: number | undefined): number {
	const requested = sec ?? 5;
	return Math.min(MAX_DURATION_SEC, Math.max(MIN_DURATION_SEC, requested));
}

/**
 * Builds the raw submit body. Isolated to one function (per the task brief) so
 * these field names can be corrected in one place once a live account
 * confirms Higgsfield's actual Seedance 2.5 input schema.
 *
 * `prompt` / `duration` / `resolution` / `aspect_ratio` / `generate_audio` are
 * CONFIRMED against a first-party source — Higgsfield's own CLI repo
 * (github.com/higgsfield-ai/cli, MODELS.md, cloned at
 * /home/user/higgsfield-ai/cli) documents these exact field names for
 * `seedance_2_0`. Seedance 2.5 itself isn't in that doc (dated Sep 14; 2.5
 * shipped Sep 16), so these are ASSUMED STABLE across the 2.0→2.5 bump, not
 * independently verified for 2.5.
 *
 * `mode` is DELIBERATELY OMITTED — it's a conflict between two first-party
 * sources with no way to resolve which applies to 2.5 (console is blocked):
 * MODELS.md says Seedance 2.0's `mode` is a speed tier (`std` | `fast`); the
 * skills repo says Seedance 2.5's modes are `t2v` | `omni_reference` |
 * `video_edit` | `video_extension` (a generation-kind switch, not a speed
 * tier). Sending the wrong reading risks a 422 or a silently wrong render, so
 * we omit the field entirely and let the server-side default apply.
 *
 * Media-role fields (`start_image`, `end_image`, `image_references`,
 * `video_references`, `audio_references`) are still UNVERIFIED — named per
 * Higgsfield's model-catalog docs, not confirmed against MODELS.md (which
 * doesn't enumerate per-field media role names).
 */
function buildSubmitBody(req: BackendRequest): Record<string, unknown> {
	const body: Record<string, unknown> = {
		prompt: req.prompt,
		duration: clampDurationSec(req.duration),
		resolution: resolutionValue(req.resolution),
		aspect_ratio: RATIO_BY_ORIENTATION[req.orientation ?? "landscape"],
	};

	if (req.referenceImageUrl) body.start_image = req.referenceImageUrl;
	if (req.lastFrameUrl) body.end_image = req.lastFrameUrl;
	if (req.referenceImages && req.referenceImages.length > 0) {
		body.image_references = req.referenceImages;
	}
	if (req.referenceVideos && req.referenceVideos.length > 0) {
		body.video_references = req.referenceVideos;
	}

	if (req.seed !== undefined) body.seed = req.seed;
	// Only sent when the caller explicitly opts in/out — omitted otherwise so
	// the provider default (true, per MODELS.md) stands. See the
	// `supportsAudioToggle` docblock in backends/types.ts, which names Seedance
	// as the exact motivating case for this flag.
	if (req.generateAudio !== undefined) body.generate_audio = req.generateAudio;

	return body;
}

// ─── Status mapping ─────────────────────────────────────────────────────────
// SDK's status union is 'queued' | 'in_progress' | 'completed' | 'failed' |
// 'nsfw'. `canceled`/`cancelled` are handled defensively even though the SDK's
// type union omits them — the live API may still send one.
function mapHiggsfieldStatus(s: string | undefined): JobStatus {
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

interface HiggsfieldResponse {
	status?: string;
	request_id?: string;
	status_url?: string;
	cancel_url?: string;
	images?: { url: string }[];
	video?: { url: string };
	error?: string;
	message?: string;
}

/** HTTP status → a human-readable reason, per the task's documented ground
 *  truth: 401 auth, 403 not-enough-credits, 422 validation, 400 bad input. */
function httpErrorMessage(status: number, body: HiggsfieldResponse): string {
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

async function higgsfieldRequest(
	path: string,
	init: RequestInit,
): Promise<HiggsfieldResponse> {
	const creds = credentialParts();
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
		throw new Error(httpErrorMessage(res.status, data));
	}
	return data;
}

export const higgsfieldBackend: GenerationBackend = {
	id: "higgsfield",
	label: "Higgsfield",
	vendor: "Higgsfield AI",
	modality: "video",
	safetyTier: "partner",
	requiredEnv: ["HIGGSFIELD_CREDENTIALS"],
	capabilities: {
		resolutions: ["480p", "720p", "1080p"],
		orientations: ["landscape", "portrait", "square"],
		durationRangeSec: { min: MIN_DURATION_SEC, max: MAX_DURATION_SEC },
		supportsSeedLock: true,
		supportsOmniReference: true,
		supportsLastFrame: true,
		supportsReferenceEdits: true,
		supportsAudioToggle: true,
		intents: ["character-video", "broll-video"],
	},

	isAvailable() {
		return Boolean(credentialParts());
	},

	estimateCost(req: BackendRequest): CostEstimate {
		const seconds = clampDurationSec(req.duration);
		const credits = costFor("higgsfield", "video", {
			seconds,
			resolution: req.resolution,
		});
		return {
			credits,
			basis: `Higgsfield Seedance 2.5 ${req.resolution ?? "720p"} × ${seconds}s`,
		};
	},

	resolveDurationSec(req: BackendRequest): number {
		return clampDurationSec(req.duration);
	},

	async submit(req: BackendRequest): Promise<SubmitResult> {
		try {
			const body = buildSubmitBody(req);
			// Model id is the endpoint path; the SDK prefixes a leading `/` if
			// absent, so we do the same.
			const model = higgsfieldModel();
			const path = model.startsWith("/") ? model : `/${model}`;
			const data = await higgsfieldRequest(path, {
				method: "POST",
				body: JSON.stringify(body),
			});

			const requestId = data.request_id;
			if (!requestId) {
				return {
					jobId: "",
					status: "failed",
					error: "Higgsfield returned no request_id",
				};
			}

			return {
				jobId: requestId,
				status: mapHiggsfieldStatus(data.status),
				mediaUrl: data.video?.url ?? data.images?.[0]?.url,
			};
		} catch (err) {
			return {
				jobId: "",
				status: "failed",
				error: err instanceof Error ? err.message : "Higgsfield submit failed",
			};
		}
	},

	async poll(jobId: string): Promise<PollResult> {
		try {
			const data = await higgsfieldRequest(`/requests/${jobId}/status`, {
				method: "GET",
			});
			return {
				jobId,
				status: mapHiggsfieldStatus(data.status),
				mediaUrl: data.video?.url ?? data.images?.[0]?.url,
				error: data.error ?? data.message,
			};
		} catch (err) {
			return {
				jobId,
				status: "failed",
				error: err instanceof Error ? err.message : "Higgsfield poll failed",
			};
		}
	},
};

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
 * `/home/user/higgsfield-ai/higgsfield-js`), and — for the `resolution` enum
 * and the two HTTP validation-error shapes — by a later live probe against
 * `https://api.higgsfield.ai` with an unfunded API key (2026-09-19), cross-
 * checked against the official reference at open.higgsfield.ai. The input
 * body's field names (`prompt`/`duration`/`resolution`/`aspect_ratio`/
 * `generate_audio`) are additionally cross-checked against Higgsfield's own
 * CLI repo (github.com/higgsfield-ai/cli, MODELS.md) for the closely-related
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
 * endpoints the SDK wraps, via the shared `higgsfieldRequest` in
 * `../higgsfield-client.ts` (auth header, base URL, and the two known
 * validation-error shapes live there — one copy for every Higgsfield
 * modality, video included — rather than a second copy in this file).
 */

import { webEnv } from "@byorn/env/web";
import { costFor } from "@/lib/credits/cost-table";
import {
	higgsfieldCredentialParts,
	higgsfieldMediaUrl,
	higgsfieldRequest,
	mapHiggsfieldStatus,
} from "@/lib/studio/backends/higgsfield-client";
import type {
	BackendRequest,
	CostEstimate,
	GenerationBackend,
	PollResult,
	SubmitResult,
} from "@/lib/studio/backends/types";
import type { VideoOrientation } from "@/lib/studio/provider-adapter";

const DEFAULT_MODEL = "bytedance/seedance-2.5/text-to-video";

function higgsfieldModel(): string {
	return webEnv.HIGGSFIELD_MODEL || DEFAULT_MODEL;
}

// ─── Aspect ratio ───────────────────────────────────────────────────────────

const RATIO_BY_ORIENTATION: Record<VideoOrientation, string> = {
	landscape: "16:9",
	portrait: "9:16",
	square: "1:1",
};

// VERIFIED against a live probe of `bytedance/seedance-2.5/text-to-video`
// (cross-checked against the official reference,
// https://open.higgsfield.ai/models/bytedance/seedance-2.5/text-to-video/api-reference):
// `resolution` accepts ONLY "480p" | "720p" (default "720p") — "1080p" comes
// back HTTP 400. The earlier version of this comment extrapolated "480p" |
// "720p" | "1080p" | "4k" from the CLI's `seedance_2_0` doc; that
// extrapolation is measurably wrong for the 2.5 REST endpoint. There is no 4k
// tier to withhold here for cost control (unlike Veo/Seedance 2.0 elsewhere in
// this directory) — 2.5 simply doesn't offer one over this endpoint.
//
// `VideoResolution` (provider-adapter.ts, outside this file's scope) still
// types `resolution` as "480p" | "720p" | "1080p" — it's a shared cross-vendor
// union, not Higgsfield-specific. So a caller CAN still hand this adapter
// "1080p" (e.g. a backend explicitly pinned by id). Rather than forward a
// request we know will 400, fall back to the safe default.
function resolutionValue(resolution: string | undefined): string {
	if (resolution === "480p" || resolution === "720p") return resolution;
	return "720p";
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
 * independently verified for 2.5. `prompt`/`duration`/`resolution`/
 * `aspect_ratio` are, however, independently CONFIRMED by the 2026-09-19 live
 * probe's validation responses (see `../higgsfield-client.ts`'s header) —
 * only `generate_audio` and the media-role fields below remain unconfirmed by
 * a live account.
 *
 * `mode` is DELIBERATELY OMITTED — it's a conflict between two first-party
 * sources with no way to resolve which applies to 2.5 (console is blocked):
 * MODELS.md says Seedance 2.0's `mode` is a speed tier (`std` | `fast`); the
 * skills repo says Seedance 2.5's modes are `t2v` | `omni_reference` |
 * `video_edit` | `video_extension` (a generation-kind switch, not a speed
 * tier). The 2026-09-19 probe independently confirmed `mode` isn't even a
 * parameter on this endpoint at all — a bogus value passed validation and was
 * silently ignored — so omitting it was the right call regardless of which
 * first-party source was "right".
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

export const higgsfieldBackend: GenerationBackend = {
	id: "higgsfield",
	label: "Higgsfield",
	vendor: "Higgsfield AI",
	modality: "video",
	safetyTier: "partner",
	requiredEnv: ["HIGGSFIELD_CREDENTIALS"],
	capabilities: {
		// VERIFIED: only 480p/720p are accepted — see `resolutionValue` above.
		resolutions: ["480p", "720p"],
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
		return Boolean(higgsfieldCredentialParts());
	},

	estimateCost(req: BackendRequest): CostEstimate {
		const seconds = clampDurationSec(req.duration);
		const credits = costFor("higgsfield", "video", {
			seconds,
			resolution: req.resolution,
		});
		return {
			credits,
			// Same clamp `submit()` applies — an unsupported resolution (e.g. a
			// caller-pinned "1080p") must not be quoted in the displayed basis when
			// the actual submitted request will fall back to 720p.
			basis: `Higgsfield Seedance 2.5 ${resolutionValue(req.resolution)} × ${seconds}s`,
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
				mediaUrl: higgsfieldMediaUrl(data),
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
				mediaUrl: higgsfieldMediaUrl(data),
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

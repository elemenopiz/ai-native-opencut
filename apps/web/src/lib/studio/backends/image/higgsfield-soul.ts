/**
 * IMAGE adapter — Higgsfield AI, Soul (`higgsfield-ai/soul/v2/standard`).
 *
 * Cinematic stills: the look Higgsfield's Soul family is actually known for,
 * and the reason it is worth having alongside the two general-purpose image
 * models in this directory.
 *
 * REQUEST BODY IS NOW VERIFIED, NOT GUESSED. Earlier revisions of this file
 * carried the CLI's `soul_cinematic` flag table (`quality`, `image_references`,
 * `soul-id`) on the ASSUMPTION that CLI flags pass through as REST body keys.
 * A live oracle probe against `https://api.higgsfield.ai` (unfunded key,
 * `POST higgsfield-ai/soul/v2/standard` with a body containing one
 * guaranteed-invalid field so validation always rejects before any job is
 * created) proved that assumption wrong. Full write-up, including the raw
 * 422 error body: `apps/web/docs/higgsfield/REST-CATALOG.md` §1. The real
 * schema:
 *
 *   prompt               string, REQUIRED, no minimum length
 *   aspect_ratio         enum: 9:16, 16:9, 4:3, 3:4, 1:1, 2:3, 3:2
 *   resolution           enum: 720p, 1080p (NOT the CLI's 1.5k/2k, NOT the
 *                         video family's 480p/720p)
 *   style_id             UUID — a style-preset id; no minting endpoint found
 *   custom_reference_id  UUID — the Soul ID / persona-reference id; no
 *                         minting endpoint found (see below)
 *   seed                 integer, 1..1,000,000
 *   batch_size           literal 1 or 4 (not a general integer)
 *   enhance_prompt       boolean
 *
 * `quality` and `image_references` — this adapter's OLD field names — are
 * CONFIRMED ABSENT from the schema: the live probe sent both, with 9 other
 * fields deliberately wrong, and neither ever produced a validation error,
 * meaning the server silently drops unrecognized keys rather than rejecting
 * them (REST-CATALOG.md §1.4). That is the dangerous case, not the safe one:
 * the old body would have gone through, an image would have rendered, and
 * the caller-supplied reference image would have had ZERO effect on it,
 * with no error anywhere to say so. This revision sends only fields that are
 * confirmed real.
 *
 * WHY THERE IS NO REFERENCE IMAGE IN THE BODY ANYMORE
 * Soul's identity mechanism is `custom_reference_id` — a UUID, not an inline
 * image URL. `BackendRequest.referenceImageUrl` / `referenceImages` are plain
 * URLs, so there is nothing in today's request shape to put in that field;
 * sending a URL under `image_references` (the old guess) is confirmed to do
 * nothing (see above), so this adapter no longer pretends to carry a
 * reference at all — `supportsReferenceEdits` is `false` below, honestly.
 * Whatever endpoint mints a `custom_reference_id` from an uploaded image was
 * searched for and not found in this session (REST-CATALOG.md §5) — that is
 * the actual gap standing between this adapter and a real Soul ID / seed-lock
 * peer, not a `BackendRequest` field the way an earlier revision of this file
 * assumed.
 *
 * ASYNC, UNLIKE ITS NEIGHBOURS — see the same note in `higgsfield-gpt-image.ts`
 * for the full explanation and the two callers that assume a synchronous image
 * backend.
 *
 * WHY THIS ONE DOES NOT CLAIM `character-still`
 * With no working reference-carrying field (see above), Soul today carries no
 * identity signal at all beyond the prompt text. Claiming `character-still`
 * would let the router pick the weakest (in fact, nonexistent) identity
 * carrier for the slot that needs it most, so this adapter stays on
 * `broll-still`.
 */

import { costFor } from "@/lib/credits/cost-table";
import {
	higgsfieldAspectRatio,
	higgsfieldReady,
	pollHiggsfieldJob,
	submitHiggsfieldJob,
} from "@/lib/studio/backends/higgsfield-client";
import type {
	BackendRequest,
	CostEstimate,
	GenerationBackend,
	PollResult,
	SubmitResult,
} from "@/lib/studio/backends/types";
import type { ImageQuality } from "@/lib/studio/image-generator";
import { webEnv } from "@byorn/env/web";

// "Soul Cinematic" (`soul_cinematic`) was the earlier, wrong CLI-model-id
// guess that produced the 404s this file's header describes — the verified
// live endpoint is Soul's `v2/standard` tier, not that model, so the label
// says just "Soul" now.
const LABEL = "Higgsfield Soul";
const ENDPOINT_ENV = "HIGGSFIELD_SOUL_ENDPOINT";

/**
 * VERIFIED TO EXIST — a live probe against `https://api.higgsfield.ai` with an
 * unfunded API key hit `higgsfield-ai/soul/v2/standard` and got back HTTP 422
 * (FastAPI-style `[{type:"missing",loc:["body","prompt"]}]`), which means the
 * path resolves and request validation ran — a 404 `model_not_found` would
 * mean the path doesn't exist. The plain (non-v2) tier,
 * `higgsfield-ai/soul/standard`, ALSO returned 422/EXISTS and is a known-good
 * fallback if v2 turns out to be the wrong tier for this account. `v2` is
 * preferred here since it's the newer, presumably current Soul release.
 *
 * The earlier constant here (`ASSUMED_ENDPOINT`,
 * `higgsfield/soul-cinematic/text-to-image`) was a guess built from the CLI's
 * flat model id (`soul_cinematic`) and the wrong vendor segment — it 404s.
 * The REST path shape is `/{vendor}/{model}/{tier}/{task?}` (a TIER segment,
 * not a task verb — see e.g. `kling-video/v2.5-turbo/pro/image-to-video`),
 * which is why every `.../text-to-image` guess for Soul was wrong.
 *
 * REQUEST BODY: now VERIFIED (this file's header, REST-CATALOG.md §1) — every
 * field this adapter sends (`prompt`, `aspect_ratio`, `resolution`, `seed`) is
 * confirmed real, and the two fields it used to send (`quality`,
 * `image_references`) are confirmed to not exist. See `requiredEnv` below for
 * why the endpoint still stays behind an explicit operator gate even so.
 */
const VERIFIED_ENDPOINT = "higgsfield-ai/soul/v2/standard";

function configuredEndpoint(): string {
	return webEnv.HIGGSFIELD_SOUL_ENDPOINT;
}

/**
 * Soul's REAL `resolution` enum is `720p` | `1080p` — VERIFIED live (this
 * file's header). Byorn's `ImageQuality` maps onto it as a two-step: only
 * `high` buys the 1080p tier. Sent explicitly on every request (rather than
 * letting the provider's `720p` default stand) so the flat per-image price in
 * `cost-table.ts` always matches the tier actually rendered.
 */
function resolutionTier(quality: ImageQuality | undefined): "720p" | "1080p" {
	return quality === "high" ? "1080p" : "720p";
}

/**
 * Builds the raw submit body. Isolated to one function so it stays the single
 * place these field names live.
 *
 * VERIFIED as REST body keys (REST-CATALOG.md §1): `prompt`, `aspect_ratio`,
 * `resolution`, `seed`. `style_id`/`custom_reference_id`/`batch_size`/
 * `enhance_prompt` are also real but have no `BackendRequest` field to source
 * them from today, so they're left unset rather than guessed.
 *
 * NO REFERENCE IMAGE IS SENT — see this file's header ("why there is no
 * reference image in the body anymore"). `image_references` is CONFIRMED
 * ABSENT from this schema; sending it did nothing except look like it worked.
 */
function buildSubmitBody(req: BackendRequest): Record<string, unknown> {
	const body: Record<string, unknown> = {
		prompt: req.prompt,
		aspect_ratio: higgsfieldAspectRatio(req.size),
		resolution: resolutionTier(req.quality),
	};
	if (req.seed !== undefined) body.seed = req.seed;
	return body;
}

export const higgsfieldSoulBackend: GenerationBackend = {
	id: "higgsfield-soul",
	label: LABEL,
	vendor: "Higgsfield AI",
	modality: "image",
	safetyTier: "partner",
	// JUDGMENT CALL: both the path AND the body fields this adapter sends are
	// now VERIFIED (422, not 404, plus a field-by-field probe — see this file's
	// header and REST-CATALOG.md §1). Still not dropping ENDPOINT_ENV. What's
	// left unconfirmed is behavioral, not schema-level: no live account has
	// actually rendered an image here, so submit-then-poll's real timing,
	// pricing, and non-nsfw success rate are unknown. An operator must still
	// paste the endpoint into HIGGSFIELD_SOUL_ENDPOINT themselves before this
	// goes live — that's a much smaller remaining gap than "the field names may
	// be wrong," but it's still a gap.
	requiredEnv: ["HIGGSFIELD_CREDENTIALS", ENDPOINT_ENV],
	capabilities: {
		sizes: ["1024x1024", "1536x1024", "1024x1536"],
		qualities: ["low", "medium", "high"],
		// `seed` IS a real, verified field (1..1,000,000) and is now sent when
		// present (see `buildSubmitBody`) — but `supportsSeedLock` stays false
		// because `seed-lock.ts`'s shared `clampSeed` ceiling is 2^31-1 (the
		// "most providers" default), which would hand Soul out-of-range seeds
		// on almost every randomly-generated draft and turn every one of them
		// into a real 422. Flipping this on needs a per-backend max-seed range
		// in `seed-lock.ts`, which is outside this fix's scope.
		supportsSeedLock: false,
		// No REST field carries a reference image into this render (see the
		// header) — Soul's only image-reference mechanism, `custom_reference_id`,
		// wants a UUID this codebase has no way to mint.
		supportsOmniReference: false,
		supportsLastFrame: false,
		// FLIPPED from true: the old `image_references` body key does nothing
		// (confirmed — see header), so no reference actually reaches the model
		// today. Advertising `true` would let the router/seed-lock pick Soul for
		// a slot that needs reference-carried identity and get a prompt-only
		// render with no error to explain why identity didn't hold.
		supportsReferenceEdits: false,
		intents: ["broll-still"],
	},

	isAvailable() {
		return higgsfieldReady(configuredEndpoint());
	},

	estimateCost(req: BackendRequest): CostEstimate {
		const credits = costFor("higgsfield-soul", "image", { count: 1 });
		return { credits, basis: `${LABEL} (${resolutionTier(req.quality)})` };
	},

	submit(req: BackendRequest): Promise<SubmitResult> {
		return submitHiggsfieldJob({
			configuredEndpoint: configuredEndpoint(),
			endpointEnvVar: ENDPOINT_ENV,
			assumedEndpoint: VERIFIED_ENDPOINT,
			body: buildSubmitBody(req),
			label: LABEL,
		});
	},

	poll(jobId: string): Promise<PollResult> {
		return pollHiggsfieldJob(jobId, LABEL);
	},
};

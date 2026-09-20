/**
 * IMAGE adapter — Higgsfield AI, Soul Cinematic (`soul_cinematic`).
 *
 * Cinematic stills: the look Higgsfield's Soul family is actually known for,
 * and the reason it is worth having alongside the two general-purpose image
 * models in this directory.
 *
 * NAMING: the model id is `soul_cinematic`. An earlier brief for this work
 * called it `soul_cinema`; no such model exists. The real Soul ids are
 * `soul_cast`, `soul_cinematic`, `soul_location`, and `text2image_soul_v2`
 * (first-party list, Higgsfield CLI repo MODELS.md).
 *
 * ASYNC, UNLIKE ITS NEIGHBOURS — see the same note in `higgsfield-gpt-image.ts`
 * for the full explanation and the two callers that assume a synchronous image
 * backend.
 *
 * WHY THIS ONE DOES NOT CLAIM `character-still`
 * Soul's identity mechanism is a SOUL ID (`--soul-id` / `--custom-reference-id`,
 * a trained-persona UUID) — that is the whole point of the Soul family, and it
 * is the closest thing in the Higgsfield catalog to Byorn's seed-lock. We
 * cannot send it: `BackendRequest` has no field that carries a provider-side
 * persona id, and `backends/types.ts` is outside this change's scope. Without
 * it, identity here rests on a SINGLE reference image, which is weaker than
 * what the two sibling adapters offer (16 and 14 blended refs). Claiming
 * `character-still` would let the router pick the weakest identity carrier for
 * the slot that needs it most, so this adapter stays on `broll-still` until
 * Soul ID is plumbed. That plumbing is the highest-value follow-up on this
 * adapter — it would make Soul a real seed-lock peer.
 *
 * Flags below come from the first-party flag table for `soul_cinematic`
 * (github.com/higgsfield-ai/cli, MODELS.md): `prompt` (required),
 * `aspect_ratio`, `image_references` (single), `quality` (1.5k|2k, default 2k),
 * `soul-id`. Note `quality` here is a RESOLUTION-shaped enum, not the
 * low/medium/high enum the other two models use.
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

const LABEL = "Higgsfield Soul Cinematic";
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
 * STILL UNVERIFIED: the REQUEST BODY beyond `prompt` being required — nothing
 * first-party confirms `aspect_ratio` / `quality` / `image_references` /
 * `soul-id` as REST body keys for this endpoint specifically (they're carried
 * over from the CLI flag table for `soul_cinematic`, a different model). See
 * `requiredEnv` below for why that gap still gates this adapter off even
 * though the path itself is now confirmed live.
 */
const VERIFIED_ENDPOINT = "higgsfield-ai/soul/v2/standard";

function configuredEndpoint(): string {
	return webEnv.HIGGSFIELD_SOUL_ENDPOINT;
}

/**
 * Soul's `quality` enum is `1.5k` | `2k` — a resolution tier wearing the name
 * "quality", NOT the low/medium/high scale the other Higgsfield image models
 * use. Byorn's `ImageQuality` maps onto it as a two-step: only `high` buys the
 * 2k tier. Sent explicitly on every request (rather than letting the provider's
 * 2k default stand) so the flat per-image price in `cost-table.ts` always
 * matches the tier actually rendered.
 */
function qualityTier(quality: ImageQuality | undefined): "1.5k" | "2k" {
	return quality === "high" ? "2k" : "1.5k";
}

/**
 * Builds the raw submit body. Isolated to one function so these field names can
 * be corrected in one place once a live account confirms the REST input schema.
 *
 * UNVERIFIED as REST body keys: `prompt`, `aspect_ratio`, `quality`,
 * `image_references`. Names taken from the first-party CLI flag table on the
 * assumption flags pass through as snake_case body keys.
 *
 * `soul_id` is DELIBERATELY OMITTED — see this file's header. Unlike the
 * omitted `background`/`variant` on GPT Image, this one is a capability gap
 * worth closing, not a knob we have no opinion on.
 */
function buildSubmitBody(req: BackendRequest): Record<string, unknown> {
	const body: Record<string, unknown> = {
		prompt: req.prompt,
		aspect_ratio: higgsfieldAspectRatio(req.size),
		quality: qualityTier(req.quality),
	};

	// Documented constraint: AT MOST ONE image reference. Sending an array of
	// two is a 422, so take the first and drop the rest rather than fail the
	// render — `supportsOmniReference: false` below is the honest advertisement
	// of that limit, so a caller that needs multi-ref blending is routed to a
	// sibling adapter in the first place.
	const firstRef = [req.referenceImageUrl, ...(req.referenceImages ?? [])].find(
		(url): url is string => Boolean(url),
	);
	if (firstRef) body.image_references = [firstRef];

	return body;
}

export const higgsfieldSoulBackend: GenerationBackend = {
	id: "higgsfield-soul",
	label: LABEL,
	vendor: "Higgsfield AI",
	modality: "image",
	safetyTier: "partner",
	// JUDGMENT CALL: the endpoint path is now VERIFIED to exist (422, not 404 —
	// see VERIFIED_ENDPOINT above), which could argue for dropping ENDPOINT_ENV
	// from the gate and defaulting straight to it. Deliberately NOT doing that.
	// A confirmed path with an UNCONFIRMED body schema is still a live endpoint
	// we'd be POSTing guessed field names to — if Higgsfield's validation is
	// lenient (extra/misnamed keys silently ignored rather than 422'd), that
	// guess could be accepted and BILL A REAL CREDIT for a render built from the
	// wrong parameters (wrong aspect ratio, wrong quality tier, dropped
	// reference image). A 404 fails safe with no charge; a 200 on a wrong body
	// does not. So the gate stays: an operator must still confirm the body shape
	// (e.g. via the console or a support answer) and paste the endpoint into
	// HIGGSFIELD_SOUL_ENDPOINT themselves before this adapter goes live. Revisit
	// once the body schema is confirmed — at that point defaulting to
	// VERIFIED_ENDPOINT and dropping this gate becomes the reasonable move.
	requiredEnv: ["HIGGSFIELD_CREDENTIALS", ENDPOINT_ENV],
	capabilities: {
		sizes: ["1024x1024", "1536x1024", "1024x1536"],
		qualities: ["low", "medium", "high"],
		// A Soul ID would be the seed-lock equivalent, but we can't send one yet.
		supportsSeedLock: false,
		// Single reference only — not omni-reference in any meaningful sense.
		supportsOmniReference: false,
		supportsLastFrame: false,
		// One reference image does carry look/identity into the render, so this
		// is true — but see the header for why `character-still` is still
		// withheld from `intents`.
		supportsReferenceEdits: true,
		intents: ["broll-still"],
	},

	isAvailable() {
		return higgsfieldReady(configuredEndpoint());
	},

	estimateCost(req: BackendRequest): CostEstimate {
		const credits = costFor("higgsfield-soul", "image", { count: 1 });
		return { credits, basis: `${LABEL} (${qualityTier(req.quality)})` };
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

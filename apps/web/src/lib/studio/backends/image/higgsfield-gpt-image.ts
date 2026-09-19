/**
 * IMAGE adapter — Higgsfield AI, GPT Image 2.5 (`gpt_image_2_5`).
 *
 * Higgsfield's own recommended default for high-fidelity stills, on-image text,
 * and design work, which is why this adapter claims `text-in-image` and
 * `broll-still` rather than the character intents (Nano Banana 2 is
 * Higgsfield's character model — see `higgsfield-nano-banana.ts`).
 *
 * ASYNC, UNLIKE ITS NEIGHBOURS. Every other adapter in this directory is
 * synchronous: one round-trip returns the image and `poll()` is a no-op.
 * Higgsfield is not — images go through the SAME job queue as video
 * (`request_id` → `GET /requests/{id}/status`), so `submit()` normally returns
 * `status: "pending"` and the media arrives via `poll()`. That matters to
 * whoever wires this up: `POST /api/studio/image` and
 * `lib/studio/persona-still.ts` both currently REQUIRE `submit()` to come back
 * `completed` with a `mediaUrl` and throw otherwise, so neither can drive an
 * async image backend yet. Both files are outside this change's scope; the
 * adapter is written to the real provider shape rather than faked into a
 * blocking call, and the gap is a known, reported wiring task. (A fast render
 * that happens to be finished at POST time IS handled — `submitHiggsfieldJob`
 * carries an inline result through — so this is a gap, not a hard block.)
 *
 * Flags below come from the first-party flag table for `gpt_image_2_5` in
 * Higgsfield's CLI repo (github.com/higgsfield-ai/cli, MODELS.md): `prompt`
 * (required), `aspect_ratio`, `background`, `image_references` (≤16),
 * `quality` (low|medium|high|xhigh|max, default low), `resolution`
 * (1k|2k|4k, default 1k), `variant` (flare|sunburst). Note that table documents
 * the CLI's FLAGS, not the REST body's field names — see the endpoint note
 * below and `higgsfield-client.ts`'s header.
 */

import { costFor } from "@/lib/credits/cost-table";
import {
	higgsfieldAspectRatio,
	higgsfieldReady,
	pollHiggsfieldJob,
	submitHiggsfieldJob,
} from "@/lib/studio/backends/image/higgsfield-client";
import type {
	BackendRequest,
	CostEstimate,
	GenerationBackend,
	PollResult,
	SubmitResult,
} from "@/lib/studio/backends/types";
import type { ImageQuality } from "@/lib/studio/image-generator";
import { webEnv } from "@byorn/env/web";

const LABEL = "Higgsfield GPT Image 2.5";
const ENDPOINT_ENV = "HIGGSFIELD_GPT_IMAGE_ENDPOINT";

/**
 * UNVERIFIED — our best construction of the REST path, kept as documentation
 * and NOT used to satisfy `isAvailable()`. Higgsfield's REST endpoints are
 * `<vendor>/<model>/<task>` (the video adapter posts to
 * `bytedance/seedance-2.5/text-to-video`), and `gpt_image_2_5` is OpenAI's
 * model hosted by Higgsfield, so `openai/gpt-image-2.5/text-to-image` is the
 * shape this should take. Nothing first-party confirms the slug spelling
 * (`gpt-image-2.5` vs `gpt-image-2-5`), the vendor segment, or the task
 * segment — the public Higgsfield repos document the CLI surface, where the
 * model is the flat id `gpt_image_2_5`, which is a different surface. An
 * operator pastes the confirmed path into {@link ENDPOINT_ENV}.
 */
const ASSUMED_ENDPOINT = "openai/gpt-image-2.5/text-to-image";

function configuredEndpoint(): string {
	return webEnv.HIGGSFIELD_GPT_IMAGE_ENDPOINT;
}

/**
 * `quality` and `resolution` are two separate Higgsfield knobs; Byorn's wire
 * type has one (`ImageQuality`). Mapping keeps them in lockstep so a single
 * user-facing choice can't land on an expensive-but-low-fidelity combination.
 *
 * `xhigh` / `max` quality and the `4k` resolution tier are deliberately NOT
 * reachable — the same cost-control precedent as Veo's withheld 4k, Seedance's
 * withheld 2k, and Nano Banana Pro's withheld 4k elsewhere in this directory.
 * Exposing them would also break the flat per-image price in `cost-table.ts`,
 * which assumes one tier.
 */
function qualityFlags(quality: ImageQuality | undefined): {
	quality: string;
	resolution: string;
} {
	switch (quality) {
		case "high":
			return { quality: "high", resolution: "2k" };
		case "medium":
			return { quality: "medium", resolution: "1k" };
		default:
			return { quality: "low", resolution: "1k" };
	}
}

/**
 * Builds the raw submit body. Isolated to one function so these field names can
 * be corrected in one place once a live account confirms the REST input schema.
 *
 * UNVERIFIED (all of them, as REST body keys): `prompt`, `aspect_ratio`,
 * `quality`, `resolution`, `image_references`. The NAMES are taken from the
 * first-party CLI flag table — `--aspect_ratio`, `--quality`, `--resolution`,
 * `--image-references` — on the assumption the CLI passes its flags through as
 * snake_case body keys, which is how the video adapter's fields were derived
 * too. That assumption is the single biggest thing a funded live call would
 * settle.
 *
 * `background` (auto|opaque|transparent) and `variant` (flare|sunburst) are
 * DELIBERATELY OMITTED: `BackendRequest` has no field that expresses either,
 * and guessing a value would silently override the provider default for every
 * render. Transparency in particular is a real feature worth plumbing later —
 * it needs a new `BackendRequest` field, which lives in `backends/types.ts`.
 */
function buildSubmitBody(req: BackendRequest): Record<string, unknown> {
	const { quality, resolution } = qualityFlags(req.quality);
	const body: Record<string, unknown> = {
		prompt: req.prompt,
		aspect_ratio: higgsfieldAspectRatio(req.size),
		quality,
		resolution,
	};

	// Documented ceiling: at most 16 image references. Truncating here rather
	// than letting the provider 422 keeps a caller that over-supplies refs
	// rendering (with the first 16) instead of failing outright.
	const refs = [req.referenceImageUrl, ...(req.referenceImages ?? [])]
		.filter((url): url is string => Boolean(url))
		.slice(0, 16);
	if (refs.length > 0) body.image_references = refs;

	return body;
}

export const higgsfieldGptImageBackend: GenerationBackend = {
	id: "higgsfield-gpt-image",
	label: LABEL,
	vendor: "Higgsfield AI",
	modality: "image",
	safetyTier: "partner",
	// Both are required: the shared credential AND the confirmed endpoint path.
	// See `higgsfieldEndpoint()` in higgsfield-client.ts for why the second one
	// gates availability instead of falling back to ASSUMED_ENDPOINT.
	requiredEnv: ["HIGGSFIELD_CREDENTIALS", ENDPOINT_ENV],
	capabilities: {
		sizes: ["1024x1024", "1536x1024", "1024x1536"],
		qualities: ["low", "medium", "high"],
		// No `seed` flag in the first-party table — identity here comes from
		// reference images, not a reproducible seed.
		supportsSeedLock: false,
		// Up to 16 blended reference images — the image-modality analog of
		// omni-reference, same reading as `google-nano-banana.ts`.
		supportsOmniReference: true,
		supportsLastFrame: false,
		supportsReferenceEdits: true,
		// Higgsfield's stated strengths for this model: general stills, design,
		// and on-image TEXT. Character work routes to Nano Banana 2 instead.
		intents: ["broll-still", "text-in-image"],
	},

	isAvailable() {
		return higgsfieldReady(configuredEndpoint());
	},

	estimateCost(req: BackendRequest): CostEstimate {
		// Read straight from the server-authoritative billing table so the
		// displayed number IS the charged number (the house rule in this
		// directory — see openai-gpt-image.ts for the drift bug that motivated it).
		const credits = costFor("higgsfield-gpt-image", "image", { count: 1 });
		return {
			credits,
			basis: `${LABEL} (${qualityFlags(req.quality).resolution})`,
		};
	},

	submit(req: BackendRequest): Promise<SubmitResult> {
		return submitHiggsfieldJob({
			configuredEndpoint: configuredEndpoint(),
			endpointEnvVar: ENDPOINT_ENV,
			assumedEndpoint: ASSUMED_ENDPOINT,
			body: buildSubmitBody(req),
			label: LABEL,
		});
	},

	poll(jobId: string): Promise<PollResult> {
		return pollHiggsfieldJob(jobId, LABEL);
	},
};

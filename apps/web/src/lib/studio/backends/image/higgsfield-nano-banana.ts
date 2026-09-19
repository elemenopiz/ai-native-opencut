/**
 * IMAGE adapter — Higgsfield AI, Nano Banana 2 / Nano Banana Pro
 * (`nano_banana_2`).
 *
 * Higgsfield's CHARACTER model: up to 14 blended reference images with strong
 * identity carry, which is why this is the one Higgsfield image adapter that
 * claims `character-still`.
 *
 * SAME MODEL, DIFFERENT DOOR. `image/google-nano-banana.ts` already talks to
 * Google's Gemini `generateContent` surface for this model family and is the
 * registry's image DEFAULT. This adapter is deliberately a SECOND route to it,
 * through Higgsfield, registered under its own id — the same "one model, two
 * vendors, two cost/quota pools" situation the router exists to arbitrate. It
 * is not a replacement, and it must never quietly displace the Google route:
 * the Google adapter is synchronous and works with today's image route, this
 * one is async and does not (see below). Practically, that is handled by the
 * endpoint gate — this backend stays unavailable until an operator explicitly
 * confirms its REST path.
 *
 * ASYNC, UNLIKE ITS NEIGHBOURS — see the same note in `higgsfield-gpt-image.ts`
 * for the full explanation and the two callers (`POST /api/studio/image`,
 * `lib/studio/persona-still.ts`) that assume a synchronous image backend.
 *
 * Flags below come from the first-party flag table for `nano_banana_2` in
 * Higgsfield's CLI repo (github.com/higgsfield-ai/cli, MODELS.md): `prompt`
 * (required), `aspect_ratio`, `image_references` (0..14), `resolution`
 * (1k|2k|4k, default 2k). Constraints it documents: a non-empty prompt OR at
 * least one image reference is required, and at most 14 references.
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

const LABEL = "Higgsfield Nano Banana 2";
const ENDPOINT_ENV = "HIGGSFIELD_NANO_BANANA_ENDPOINT";

/**
 * UNVERIFIED — best construction of the REST path, documentation only; it does
 * NOT satisfy `isAvailable()`. Same reasoning as `higgsfield-gpt-image.ts`:
 * Higgsfield REST paths are `<vendor>/<model>/<task>` and Nano Banana is
 * Google's model, so `google/nano-banana-2/text-to-image` is the expected
 * shape. The slug spelling and task segment are unconfirmed.
 */
const ASSUMED_ENDPOINT = "google/nano-banana-2/text-to-image";

/** At most 14 image references (first-party constraint). */
const MAX_REFERENCES = 14;

function configuredEndpoint(): string {
	return webEnv.HIGGSFIELD_NANO_BANANA_ENDPOINT;
}

/**
 * Byorn's single `ImageQuality` knob → Higgsfield's `resolution` tier. The
 * provider default is `2k`; we send the tier EXPLICITLY on every request so
 * the price in `cost-table.ts` (a flat per-image rate) always matches what was
 * actually rendered, instead of silently following a provider default that
 * could change. `4k` is withheld for cost control — same precedent as the
 * withheld 4k in `google-nano-banana.ts`, `google-veo.ts`, and the Seedance
 * adapters.
 */
function resolutionTier(quality: ImageQuality | undefined): "1k" | "2k" {
	return quality === "high" ? "2k" : "1k";
}

/**
 * Builds the raw submit body. Isolated to one function so these field names can
 * be corrected in one place once a live account confirms the REST input schema.
 *
 * UNVERIFIED as REST body keys: `prompt`, `aspect_ratio`, `resolution`,
 * `image_references`. Names taken from the first-party CLI flag table on the
 * assumption flags pass through as snake_case body keys — see
 * `higgsfield-client.ts`'s header for why that assumption is the open question.
 */
function buildSubmitBody(req: BackendRequest): Record<string, unknown> {
	const body: Record<string, unknown> = {
		prompt: req.prompt,
		aspect_ratio: higgsfieldAspectRatio(req.size),
		resolution: resolutionTier(req.quality),
	};

	// Truncate rather than let the provider 422 on ref 15 — a caller that
	// over-supplies references still gets a render from the first 14.
	const refs = [req.referenceImageUrl, ...(req.referenceImages ?? [])]
		.filter((url): url is string => Boolean(url))
		.slice(0, MAX_REFERENCES);
	if (refs.length > 0) body.image_references = refs;

	return body;
}

export const higgsfieldNanoBananaBackend: GenerationBackend = {
	id: "higgsfield-nano-banana",
	label: LABEL,
	vendor: "Higgsfield AI",
	modality: "image",
	safetyTier: "partner",
	requiredEnv: ["HIGGSFIELD_CREDENTIALS", ENDPOINT_ENV],
	capabilities: {
		sizes: ["1024x1024", "1536x1024", "1024x1536"],
		qualities: ["low", "medium", "high"],
		// No `seed` flag in the first-party table; identity carry is by reference.
		supportsSeedLock: false,
		supportsOmniReference: true,
		supportsLastFrame: false,
		// The model's headline feature — this is what qualifies it for
		// `character-still` under the router's persona-critical filter (which
		// requires seed-lock OR reference-edit support).
		supportsReferenceEdits: true,
		intents: ["character-still", "broll-still"],
	},

	isAvailable() {
		return higgsfieldReady(configuredEndpoint());
	},

	estimateCost(req: BackendRequest): CostEstimate {
		const credits = costFor("higgsfield-nano-banana", "image", { count: 1 });
		return { credits, basis: `${LABEL} (${resolutionTier(req.quality)})` };
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

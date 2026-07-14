/**
 * Reference IMAGE adapter — OpenAI GPT Image 2.
 *
 * Template for every other image adapter. Wraps `image-generator.ts`. Image
 * generation here is synchronous (one round-trip returns the image), so `submit`
 * returns `status: "completed"` with the media inline and `poll` is a no-op —
 * the async job/poll shape is preserved only for interface uniformity with video.
 */

import { webEnv } from "@byorn/env/web";
import { nanoid } from "nanoid";
import { costFor } from "@/lib/credits/cost-table";
import { generateReferenceImage } from "@/lib/studio/image-generator";
import { renderGptImageEdit } from "@/lib/studio/gpt-image-edit";
import type {
	BackendRequest,
	CostEstimate,
	GenerationBackend,
	PollResult,
	SubmitResult,
} from "@/lib/studio/backends/types";

export const openaiGptImageBackend: GenerationBackend = {
	id: "openai-gpt-image",
	label: "GPT Image 2",
	vendor: "OpenAI",
	modality: "image",
	safetyTier: "partner",
	requiredEnv: ["OPENAI_API_KEY"],
	capabilities: {
		sizes: ["1024x1024", "1536x1024", "1024x1536"],
		qualities: ["low", "medium", "high"],
		supportsSeedLock: false, // GPT Image doesn't expose a reproducible seed
		supportsOmniReference: false,
		supportsLastFrame: false,
		supportsReferenceEdits: true, // /images/edits carries identity via reference
		intents: ["character-still", "broll-still", "text-in-image"],
	},

	isAvailable() {
		return Boolean(webEnv.OPENAI_API_KEY);
	},

	estimateCost(req: BackendRequest): CostEstimate {
		// Sourced directly from cost-table.ts's costFor() — the same
		// server-authoritative billing table `/api/studio/image` actually charges
		// (a flat per-image rate today; the previous hardcoded quality tiers here
		// displayed a NUMBER THAT DIDN'T MATCH BILLING for medium/high requests) —
		// so this is exactly what the job will cost, not a separate estimate that
		// can drift from real billing.
		const credits = costFor("openai-gpt-image", "image", { count: 1 });
		return { credits, basis: `GPT Image 2 (${req.quality ?? "high"})` };
	},

	async submit(req: BackendRequest): Promise<SubmitResult> {
		try {
			// Reference-conditioned path (persona / character-still): carry identity
			// from the supplied reference images via /images/edits. This is what
			// `supportsReferenceEdits` promises — a plain text→image generation would
			// silently drop the anchor photos.
			const refs = [
				req.referenceImageUrl,
				...(req.referenceImages ?? []),
			].filter((url): url is string => Boolean(url));

			if (refs.length > 0) {
				const { imageUrl } = await renderGptImageEdit({
					prompt: req.prompt,
					referenceImages: refs,
					size: req.size,
				});
				return { jobId: nanoid(), status: "completed", mediaUrl: imageUrl };
			}

			const [image] = await generateReferenceImage({
				prompt: req.prompt,
				size: req.size,
				quality: req.quality,
				n: 1,
			});
			if (!image) {
				return { jobId: "", status: "failed", error: "No image produced" };
			}
			return {
				jobId: nanoid(),
				status: "completed",
				mediaUrl: image.imageUrl,
			};
		} catch (err) {
			return {
				jobId: "",
				status: "failed",
				error: err instanceof Error ? err.message : "GPT Image submit failed",
			};
		}
	},

	// Synchronous backend: nothing to poll. If ever called, report completed with
	// no url so callers treat it as terminal rather than looping forever.
	async poll(jobId: string): Promise<PollResult> {
		return { jobId, status: "completed" };
	},
};

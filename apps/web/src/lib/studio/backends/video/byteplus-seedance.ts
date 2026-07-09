/**
 * Reference VIDEO adapter — BytePlus ModelArk / Seedance 2.0.
 *
 * The one live backend today, and the template every other video adapter copies.
 * It wraps the existing `provider-adapter.ts` (submit/poll) so this refactor is
 * non-breaking: the old direct callers keep working while new code routes
 * through the registry. Seed-lock + omni-reference + first-&-last-frame all map
 * straight onto Seedance's real capabilities.
 */

import { webEnv } from "@byorn/env/web";
import {
	generateVideo,
	pollVideo,
} from "@/lib/studio/provider-adapter";
import { estimateVideoCredits } from "@/lib/studio/backends/cost";
import type {
	BackendRequest,
	CostEstimate,
	GenerationBackend,
	PollResult,
	SubmitResult,
} from "@/lib/studio/backends/types";

export const byteplusSeedanceBackend: GenerationBackend = {
	id: "byteplus-seedance",
	label: "Seedance 2.0",
	vendor: "BytePlus ModelArk",
	modality: "video",
	// Direct-to-source, no reseller markup; our default workhorse.
	safetyTier: "partner",
	requiredEnv: ["BYTEPLUS_API_KEY"],
	capabilities: {
		resolutions: ["480p", "720p", "1080p"],
		orientations: ["portrait", "landscape", "square"],
		durationRangeSec: { min: 4, max: 15 },
		modes: ["text-to-video", "image-to-video"],
		supportsSeedLock: true,
		supportsOmniReference: true,
		supportsLastFrame: true,
		supportsReferenceEdits: false,
		intents: ["character-video", "broll-video"],
	},

	isAvailable() {
		return Boolean(webEnv.BYTEPLUS_API_KEY);
	},

	estimateCost(req: BackendRequest): CostEstimate {
		const credits = estimateVideoCredits(req.resolution, req.duration);
		return {
			credits,
			basis: `Seedance ${req.resolution ?? "720p"} × ${req.duration ?? 5}s`,
		};
	},

	async submit(req: BackendRequest): Promise<SubmitResult> {
		try {
			const res = await generateVideo({
				prompt: req.prompt,
				referenceImageUrl: req.referenceImageUrl,
				referenceImages: req.referenceImages,
				referenceVideos: req.referenceVideos,
				lastFrameUrl: req.lastFrameUrl,
				seed: req.seed,
				resolution: req.resolution ?? "720p",
				orientation: req.orientation ?? "landscape",
				duration: req.duration ?? 5,
				mode: req.mode ?? "text-to-video",
			});
			return {
				jobId: res.jobId,
				status: res.status,
				mediaUrl: res.videoUrl,
				seed: res.seed,
			};
		} catch (err) {
			return {
				jobId: "",
				status: "failed",
				error: err instanceof Error ? err.message : "Seedance submit failed",
			};
		}
	},

	async poll(jobId: string): Promise<PollResult> {
		try {
			const res = await pollVideo(jobId);
			return {
				jobId: res.jobId,
				status: res.status,
				mediaUrl: res.videoUrl,
				seed: res.seed,
				error: res.error,
			};
		} catch (err) {
			return {
				jobId,
				status: "failed",
				error: err instanceof Error ? err.message : "Seedance poll failed",
			};
		}
	},
};

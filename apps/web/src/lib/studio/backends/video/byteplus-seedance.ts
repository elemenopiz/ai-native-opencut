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
import { generateVideo, pollVideo } from "@/lib/studio/provider-adapter";
import { costFor } from "@/lib/credits/cost-table";
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
		// Re-checked 2026-07-15 (docs.byteplus.com's ModelArk reference is a
		// JS-rendered page WebFetch can't read directly; cross-referenced via
		// third-party integration guides quoting the live schema for this exact
		// model id — dreamina-seedance-2-0 — plus BytePlus's own launch copy):
		// max resolution 1080p, max duration 15s, min duration 4s all confirmed
		// unchanged. Seedance 2.0 also exposes a 2k tier at the API level, not
		// added here — same cost-control precedent as Veo's withheld 4k and
		// Nano Banana Pro's withheld 4K (VideoResolution only has
		// 480p/720p/1080p regardless).
		resolutions: ["480p", "720p", "1080p"],
		orientations: ["portrait", "landscape", "square"],
		durationRangeSec: { min: 4, max: 15 },
		supportsSeedLock: true,
		supportsOmniReference: true,
		supportsLastFrame: true,
		supportsReferenceEdits: false,
		supportsAudioToggle: true,
		intents: ["character-video", "broll-video"],
	},

	isAvailable() {
		return Boolean(webEnv.BYTEPLUS_API_KEY);
	},

	estimateCost(req: BackendRequest): CostEstimate {
		const credits = costFor("byteplus-seedance", "video", {
			seconds: req.duration,
			resolution: req.resolution,
		});
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
				generateAudio: req.generateAudio,
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

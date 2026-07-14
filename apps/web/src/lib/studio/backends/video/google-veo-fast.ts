/**
 * VIDEO adapter — Google Veo 3.1 Fast, the lower-cost/lower-latency Veo tier.
 *
 * Same Gemini API surface, request shape, and reference/last-frame/native-audio
 * behavior as Standard Veo (`google-veo.ts`) — only the model id and per-second
 * price differ (Fast: $0.10/s @720p, $0.12/s @1080p vs. Standard's flat
 * $0.40/s; source: ai.google.dev/gemini-api/docs/pricing, 2026-07). Registered
 * as a distinct backend (not a quality knob on the Standard adapter) so the
 * router/UI can offer it as its own cost/quality tradeoff point, the same way
 * Seedance and the other tiers show up as separate cards.
 *
 * Shares its request-building, fetch, and polling logic with `google-veo.ts`
 * via `submitVeo`/`pollVeo` — there is no independently-maintained copy of the
 * LRO plumbing to drift.
 *
 * `GEMINI_API_KEY` comes from the validated env schema (`@byorn/env/web`);
 * empty string means "not configured" and keeps the adapter inert. Shared with
 * Standard Veo / Imagen / Nano Banana — one key unlocks all.
 *
 * Docs: https://ai.google.dev/gemini-api/docs/video
 */

import { webEnv } from "@byorn/env/web";
import { costFor } from "@/lib/credits/cost-table";
import {
	nearestDuration,
	pollVeo,
	submitVeo,
} from "@/lib/studio/backends/video/google-veo";
import type {
	BackendRequest,
	CostEstimate,
	GenerationBackend,
	PollResult,
	SubmitResult,
} from "@/lib/studio/backends/types";

function apiKey(): string | undefined {
	return webEnv.GEMINI_API_KEY || undefined;
}

function veoFastModel(): string {
	return webEnv.GEMINI_VEO_FAST_MODEL || "veo-3.1-fast-generate-preview";
}

export const googleVeoFastBackend: GenerationBackend = {
	id: "google-veo-fast",
	label: "Veo 3.1 Fast",
	vendor: "Google (Gemini API)",
	modality: "video",
	safetyTier: "experimental",
	requiredEnv: ["GEMINI_API_KEY"],
	capabilities: {
		resolutions: ["720p", "1080p"],
		orientations: ["landscape", "portrait"],
		durationRangeSec: { min: 4, max: 8 },
		supportsSeedLock: false,
		supportsOmniReference: true,
		supportsLastFrame: true,
		supportsReferenceEdits: false,
		intents: ["broll-video", "character-video"],
	},

	isAvailable() {
		return Boolean(apiKey());
	},

	estimateCost(req: BackendRequest): CostEstimate {
		const credits = costFor("google-veo-fast", "video", {
			seconds: req.duration,
			resolution: req.resolution,
		});
		return {
			credits,
			basis: `Veo 3.1 Fast ${req.resolution ?? "720p"} × ${nearestDuration(req.duration)}s (native audio)`,
		};
	},

	submit(req: BackendRequest): Promise<SubmitResult> {
		return submitVeo(req, veoFastModel(), "Veo 3.1 Fast");
	},

	poll(jobId: string): Promise<PollResult> {
		return pollVeo(jobId, "Veo 3.1 Fast");
	},
};

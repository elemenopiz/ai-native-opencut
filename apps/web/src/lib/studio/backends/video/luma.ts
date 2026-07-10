/**
 * VIDEO adapter — Luma AI, Dream Machine / Ray-2, official direct API.
 *
 * Luma's own API at `api.lumalabs.ai/dream-machine/v1` — a plain Bearer-token
 * REST surface, no signing or JWT ceremony. Submit → poll by generation id,
 * same shape as our other adapters. `state` is the status field (not
 * `status`) and the output lands at `assets.video`.
 *
 * Reference/identity conditioning goes through two distinct mechanisms here,
 * both real Luma features: `keyframes.frame0` / `frame1` for i2v and
 * first-&-last-frame, and top-level `character_ref` / `image_ref` for
 * subject-consistent generation across shots (Ray-2's headline feature, and
 * why this backend is a plausible character-video route). The exact
 * multi-image shape of `character_ref` is thin in public docs — marked
 * UNVERIFIED below.
 *
 * `LUMA_API_KEY` is not yet in the env schema (owned by another agent), so
 * read via `process.env` directly per the build brief.
 *
 * Docs: https://docs.lumalabs.ai/docs/api
 */

import { estimateVideoCredits } from "@/lib/studio/backends/cost";
import type {
	BackendRequest,
	CostEstimate,
	GenerationBackend,
	JobStatus,
	PollResult,
	SubmitResult,
} from "@/lib/studio/backends/types";
import type { VideoOrientation } from "@/lib/studio/provider-adapter";

const DEFAULT_BASE = "https://api.lumalabs.ai/dream-machine/v1";

function lumaBase(): string {
	return process.env.LUMA_BASE_URL || DEFAULT_BASE;
}

function apiKey(): string | undefined {
	return process.env.LUMA_API_KEY;
}

function lumaModel(): string {
	return process.env.LUMA_MODEL || "ray-2";
}

const ASPECT_BY_ORIENTATION: Record<VideoOrientation, string> = {
	landscape: "16:9",
	portrait: "9:16",
	square: "1:1",
};

// Our normalized "480p" has no direct Luma equivalent (Luma's tiers are
// 540p/720p/1080p/4k) — UNVERIFIED: 540p is the closest documented tier.
function resolutionFor(resolution: string | undefined): string {
	if (resolution === "1080p") return "1080p";
	if (resolution === "480p") return "540p";
	return "720p";
}

// UNVERIFIED: Ray-2 documents 5s and 9s as the supported durations; anything
// else is rounded to the nearest of those two.
function durationFor(sec: number | undefined): string {
	const n = sec ?? 5;
	return n > 7 ? "9s" : "5s";
}

function mapLumaStatus(state: string | undefined): JobStatus {
	switch (state) {
		case "completed":
			return "completed";
		case "failed":
			return "failed";
		case "dreaming":
			return "processing";
		// "queued" and anything unrecognized
		default:
			return "pending";
	}
}

interface LumaGeneration {
	id: string;
	state?: string;
	failure_reason?: string;
	assets?: { video?: string };
}

async function lumaFetch(
	path: string,
	init: RequestInit,
): Promise<LumaGeneration> {
	const key = apiKey();
	if (!key) throw new Error("LUMA_API_KEY is not configured");
	const res = await fetch(`${lumaBase()}${path}`, {
		...init,
		headers: {
			...init.headers,
			Authorization: `Bearer ${key}`,
			"Content-Type": "application/json",
		},
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Luma request failed ${res.status}: ${text}`);
	}
	return (await res.json()) as LumaGeneration;
}

export const lumaBackend: GenerationBackend = {
	id: "luma-ray",
	label: "Luma Ray 2",
	vendor: "Luma AI",
	modality: "video",
	safetyTier: "partner",
	requiredEnv: ["LUMA_API_KEY"],
	capabilities: {
		resolutions: ["480p", "720p", "1080p"],
		orientations: ["landscape", "portrait", "square"],
		durationRangeSec: { min: 5, max: 9 },
		// No documented seed parameter on the generations endpoint.
		supportsSeedLock: false,
		// `character_ref` / `image_ref` (UNVERIFIED exact shape) — genuine
		// subject-consistency conditioning distinct from an animate-this frame.
		supportsOmniReference: true,
		// `keyframes.frame0` / `frame1` — documented first-&-last-frame support.
		supportsLastFrame: true,
		supportsReferenceEdits: false,
		intents: ["character-video", "broll-video"],
	},

	isAvailable() {
		return Boolean(apiKey());
	},

	estimateCost(req: BackendRequest): CostEstimate {
		const credits = estimateVideoCredits(req.resolution, req.duration);
		return {
			credits,
			basis: `Luma Ray 2 ${resolutionFor(req.resolution)} × ${durationFor(req.duration)}`,
		};
	},

	async submit(req: BackendRequest): Promise<SubmitResult> {
		try {
			const body: Record<string, unknown> = {
				prompt: req.prompt,
				model: lumaModel(),
				resolution: resolutionFor(req.resolution),
				duration: durationFor(req.duration),
				aspect_ratio: ASPECT_BY_ORIENTATION[req.orientation ?? "landscape"],
			};

			const keyframes: Record<string, unknown> = {};
			if (req.mode === "image-to-video" && req.referenceImageUrl) {
				keyframes.frame0 = { type: "image", url: req.referenceImageUrl };
			}
			if (req.lastFrameUrl) {
				keyframes.frame1 = { type: "image", url: req.lastFrameUrl };
			}
			if (Object.keys(keyframes).length) body.keyframes = keyframes;

			// UNVERIFIED: exact param name/shape for multi-image subject reference
			// on Ray-2 (`character_ref` in Luma's marketing docs; may be
			// `character_ref: { identity0: { images: [...] } }` — confirm live).
			if (req.referenceImages?.length) {
				body.character_ref = {
					identity0: { images: req.referenceImages },
				};
			}

			const generation = await lumaFetch("/generations", {
				method: "POST",
				body: JSON.stringify(body),
			});

			return {
				jobId: generation.id,
				status: mapLumaStatus(generation.state),
			};
		} catch (err) {
			return {
				jobId: "",
				status: "failed",
				error: err instanceof Error ? err.message : "Luma submit failed",
			};
		}
	},

	async poll(jobId: string): Promise<PollResult> {
		try {
			const generation = await lumaFetch(`/generations/${jobId}`, {
				method: "GET",
			});
			return {
				jobId: generation.id,
				status: mapLumaStatus(generation.state),
				mediaUrl: generation.assets?.video,
				error: generation.failure_reason,
			};
		} catch (err) {
			return {
				jobId,
				status: "failed",
				error: err instanceof Error ? err.message : "Luma poll failed",
			};
		}
	},
};

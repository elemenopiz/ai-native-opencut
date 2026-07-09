/**
 * Image adapter — Ideogram 3.0.
 *
 * Native Ideogram API (api.ideogram.ai), not an aggregator. Unlike the build
 * brief's assumption, Ideogram's `/v1/ideogram-v3/generate` is genuinely
 * SYNCHRONOUS — the image is generated and returned in the same response, so
 * this follows the GPT Image sync template (submit inline, poll is a no-op).
 * Ideogram is the strongest text-in-image renderer of the four adapters here,
 * and its `character_reference_images` field is a real identity-conditioning
 * input (not a style ref), so we wire `req.referenceImageUrl` through it.
 */

import { nanoid } from "nanoid";
import type {
	BackendRequest,
	CostEstimate,
	GenerationBackend,
	PollResult,
	SubmitResult,
} from "@/lib/studio/backends/types";
import type { ImageQuality, ImageSize } from "@/lib/studio/image-generator";

// UNVERIFIED: IDEOGRAM_API_KEY is not yet declared in `@byorn/env/web`'s
// schema — read straight from `process.env` per the build brief.
const IDEOGRAM_API_KEY_ENV = "IDEOGRAM_API_KEY";

const IDEOGRAM_BASE = "https://api.ideogram.ai";

/** Approximate per-render credit cost by our quality tier → Ideogram
 *  `rendering_speed`. UNVERIFIED: exact USD figures — Ideogram bills per
 *  speed tier but doesn't publish a single per-image rate card here. */
const CREDITS_BY_QUALITY: Record<string, number> = {
	low: 3, // TURBO
	medium: 8, // DEFAULT
	high: 16, // QUALITY
};

interface IdeogramGenerateResponse {
	data: Array<{ url?: string; seed?: number }>;
}

function mapSizeToResolution(size?: ImageSize): string {
	// UNVERIFIED: exact membership of Ideogram's `resolution` enum — these three
	// exact WxH pairs are commonly listed among its supported resolutions, but
	// not confirmed against the live enum at write time.
	switch (size) {
		case "1536x1024":
			return "1536x1024";
		case "1024x1536":
			return "1024x1536";
		case "1024x1024":
		default:
			return "1024x1024";
	}
}

function mapQualityToRenderingSpeed(quality?: ImageQuality): string {
	switch (quality) {
		case "low":
			return "TURBO";
		case "medium":
			return "DEFAULT";
		case "high":
		default:
			return "QUALITY";
	}
}

async function fetchReferenceBlob(url: string): Promise<Blob> {
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(`Failed to fetch reference image (${res.status})`);
	}
	const buf = await res.arrayBuffer();
	return new Blob([buf], { type: res.headers.get("content-type") ?? "image/png" });
}

export const ideogramBackend: GenerationBackend = {
	id: "ideogram",
	label: "Ideogram 3.0",
	vendor: "Ideogram",
	modality: "image",
	safetyTier: "partner",
	requiredEnv: [IDEOGRAM_API_KEY_ENV],
	capabilities: {
		sizes: ["1024x1024", "1536x1024", "1024x1536"],
		qualities: ["low", "medium", "high"],
		supportsSeedLock: true, // real reproducible `seed` param
		supportsOmniReference: false,
		supportsLastFrame: false,
		supportsReferenceEdits: true, // character_reference_images carries identity
		intents: ["text-in-image", "broll-still", "character-still"],
	},

	isAvailable() {
		return Boolean(process.env[IDEOGRAM_API_KEY_ENV]);
	},

	estimateCost(req: BackendRequest): CostEstimate {
		const credits = CREDITS_BY_QUALITY[req.quality ?? "high"] ?? 16;
		return { credits, basis: `Ideogram 3.0 (${req.quality ?? "high"})` };
	},

	async submit(req: BackendRequest): Promise<SubmitResult> {
		const key = process.env[IDEOGRAM_API_KEY_ENV];
		if (!key) {
			return { jobId: "", status: "failed", error: "IDEOGRAM_API_KEY is not configured" };
		}

		try {
			const form = new FormData();
			form.append("prompt", req.prompt);
			form.append("resolution", mapSizeToResolution(req.size));
			form.append("rendering_speed", mapQualityToRenderingSpeed(req.quality));
			if (req.seed !== undefined) form.append("seed", String(req.seed));
			if (req.referenceImageUrl) {
				const blob = await fetchReferenceBlob(req.referenceImageUrl);
				form.append("character_reference_images", blob, "reference.png");
			}

			const res = await fetch(`${IDEOGRAM_BASE}/v1/ideogram-v3/generate`, {
				method: "POST",
				headers: { "Api-Key": key },
				body: form,
			});

			if (!res.ok) {
				const text = await res.text();
				return {
					jobId: "",
					status: "failed",
					error: `Ideogram submit failed ${res.status}: ${text}`,
				};
			}

			const data = (await res.json()) as IdeogramGenerateResponse;
			const first = data.data?.[0];
			if (!first?.url) {
				return { jobId: "", status: "failed", error: "No image produced" };
			}

			return {
				jobId: nanoid(),
				status: "completed",
				mediaUrl: first.url,
				seed: first.seed,
			};
		} catch (err) {
			return {
				jobId: "",
				status: "failed",
				error: err instanceof Error ? err.message : "Ideogram submit failed",
			};
		}
	},

	// Synchronous backend: nothing to poll.
	async poll(jobId: string): Promise<PollResult> {
		return { jobId, status: "completed" };
	},
};

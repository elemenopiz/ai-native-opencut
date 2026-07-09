/**
 * Image adapter — Google Imagen 4 (Gemini API).
 *
 * Native Google API — Imagen exposed through the Gemini API's `:predict`
 * surface (generativelanguage.googleapis.com), not Vertex AI. Synchronous:
 * one round-trip returns base64 image bytes inline, so this follows the GPT
 * Image sync template. Note: Google has flagged the Imagen 4 standard/ultra/
 * fast endpoints for deprecation in favor of Gemini 2.5/3.1 Flash Image
 * (see `google-nano-banana.ts`) — kept here as a distinct, still-live model
 * with different strengths (higher fixed resolution ceiling, no identity
 * conditioning).
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

// UNVERIFIED: GEMINI_API_KEY is not yet declared in `@byorn/env/web`'s
// schema — read straight from `process.env` per the build brief. Shared with
// `google-nano-banana.ts` (same Google AI Studio key covers both models).
const GEMINI_API_KEY_ENV = "GEMINI_API_KEY";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const IMAGEN_MODEL = process.env.GEMINI_IMAGEN_MODEL || "imagen-4.0-generate-001";

/** UNVERIFIED: exact USD — Google publishes per-image pricing that varies by
 *  the standard/ultra/fast Imagen 4 variant; these are order-of-magnitude
 *  estimates for the standard model used here. */
const CREDITS_BY_QUALITY: Record<string, number> = {
	low: 6,
	medium: 6,
	high: 12, // "2K" imageSize
};

interface ImagenPredictResponse {
	predictions?: Array<{ bytesBase64Encoded?: string; mimeType?: string }>;
}

function mapSizeToAspectRatio(size?: ImageSize): string {
	switch (size) {
		// UNVERIFIED: nearest-fit mapping — Imagen's aspectRatio enum
		// ("1:1","3:4","4:3","9:16","16:9") has no exact 3:2/2:3 match for our
		// 1536x1024 / 1024x1536 sizes, so we round to the closest supported ratio.
		case "1536x1024":
			return "4:3";
		case "1024x1536":
			return "3:4";
		case "1024x1024":
		default:
			return "1:1";
	}
}

function mapQualityToImageSize(quality?: ImageQuality): "1K" | "2K" {
	return quality === "high" ? "2K" : "1K";
}

export const googleImagenBackend: GenerationBackend = {
	id: "google-imagen",
	label: "Imagen 4",
	vendor: "Google",
	modality: "image",
	safetyTier: "partner",
	requiredEnv: [GEMINI_API_KEY_ENV],
	capabilities: {
		sizes: ["1024x1024", "1536x1024", "1024x1536"],
		qualities: ["low", "medium", "high"],
		// UNVERIFIED: Vertex AI's Imagen exposes a `seed` param (gated behind
		// addWatermark:false); not confirmed as publicly exposed on this Gemini
		// API `:predict` surface, so left disabled pending confirmation.
		supportsSeedLock: false,
		supportsOmniReference: false,
		supportsLastFrame: false,
		// This :predict endpoint is text-to-image only — Imagen's edit/
		// customization API is Vertex-only, not exposed via the Gemini API.
		supportsReferenceEdits: false,
		intents: ["broll-still", "text-in-image"], // Imagen 4 touts improved typography; no reference conditioning → no character-still
	},

	isAvailable() {
		return Boolean(process.env[GEMINI_API_KEY_ENV]);
	},

	estimateCost(req: BackendRequest): CostEstimate {
		const credits = CREDITS_BY_QUALITY[req.quality ?? "high"] ?? 12;
		return { credits, basis: `Imagen 4 (${mapQualityToImageSize(req.quality)})` };
	},

	async submit(req: BackendRequest): Promise<SubmitResult> {
		const key = process.env[GEMINI_API_KEY_ENV];
		if (!key) {
			return { jobId: "", status: "failed", error: "GEMINI_API_KEY is not configured" };
		}

		try {
			const body = {
				instances: [{ prompt: req.prompt }],
				parameters: {
					sampleCount: 1,
					aspectRatio: mapSizeToAspectRatio(req.size),
					imageSize: mapQualityToImageSize(req.quality),
					// UNVERIFIED: default policy choice — allows adult subjects but not
					// minors, matching most creative-tool defaults.
					personGeneration: "allow_adult",
				},
			};

			const res = await fetch(`${GEMINI_BASE}/models/${IMAGEN_MODEL}:predict`, {
				method: "POST",
				headers: {
					"x-goog-api-key": key,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
			});

			if (!res.ok) {
				const text = await res.text();
				return {
					jobId: "",
					status: "failed",
					error: `Imagen submit failed ${res.status}: ${text}`,
				};
			}

			const data = (await res.json()) as ImagenPredictResponse;
			const first = data.predictions?.[0];
			if (!first?.bytesBase64Encoded) {
				return { jobId: "", status: "failed", error: "No image produced" };
			}

			const mimeType = first.mimeType ?? "image/png";
			return {
				jobId: nanoid(),
				status: "completed",
				mediaUrl: `data:${mimeType};base64,${first.bytesBase64Encoded}`,
			};
		} catch (err) {
			return {
				jobId: "",
				status: "failed",
				error: err instanceof Error ? err.message : "Imagen submit failed",
			};
		}
	},

	// Synchronous backend: nothing to poll.
	async poll(jobId: string): Promise<PollResult> {
		return { jobId, status: "completed" };
	},
};

/**
 * Image adapter — Gemini 2.5 Flash Image ("Nano Banana").
 *
 * Native Google API via the Gemini API's `generateContent` surface
 * (generativelanguage.googleapis.com) — the same endpoint used for text
 * generation, with `responseModalities: ["IMAGE"]` requesting image output.
 * Synchronous: base64 image bytes come back inline in
 * `candidates[0].content.parts[].inlineData`, so this follows the GPT Image
 * sync template. Nano Banana's headline feature is exactly what
 * `supportsReferenceEdits`/`supportsOmniReference` describe — blending one or
 * more input images to carry character identity into a new render — so
 * `referenceImageUrl`/`referenceImages` are wired through as `inlineData`
 * parts alongside the prompt.
 */

import { webEnv } from "@byorn/env/web";
import { nanoid } from "nanoid";
import { fetchWithTimeout, MEDIA_TIMEOUT_MS } from "@/lib/studio/fetch-timeout";
import type {
	BackendRequest,
	CostEstimate,
	GenerationBackend,
	PollResult,
	SubmitResult,
} from "@/lib/studio/backends/types";
import type { ImageQuality, ImageSize } from "@/lib/studio/image-generator";

// GEMINI_API_KEY comes from the validated env schema (`@byorn/env/web`);
// empty string means "not configured". Shared with `google-imagen.ts` (same
// Google AI Studio key covers both models).
const GEMINI_API_KEY_ENV = "GEMINI_API_KEY";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const NANO_BANANA_MODEL =
	webEnv.GEMINI_NANO_BANANA_MODEL || "gemini-2.5-flash-image";

/** UNVERIFIED: exact USD — Google bills Flash Image by output image tokens
 *  rather than a flat per-image rate; these are order-of-magnitude estimates. */
const CREDITS_BY_QUALITY: Record<string, number> = {
	low: 5,
	medium: 8,
	high: 14, // "2K" imageConfig.imageSize
};

interface GenerateContentResponse {
	candidates?: Array<{
		content?: {
			parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }>;
		};
	}>;
}

function mapSizeToAspectRatio(size?: ImageSize): string {
	switch (size) {
		case "1536x1024":
			return "3:2";
		case "1024x1536":
			return "2:3";
		case "1024x1024":
		default:
			return "1:1";
	}
}

function mapQualityToImageSize(quality?: ImageQuality): "1K" | "2K" {
	return quality === "high" ? "2K" : "1K";
}

async function fetchAsInlineData(
	url: string,
): Promise<{ mimeType: string; base64: string }> {
	// Reference image download — media bytes, so the longer budget applies.
	const res = await fetchWithTimeout(url, { timeoutMs: MEDIA_TIMEOUT_MS });
	if (!res.ok) {
		throw new Error(`Failed to fetch reference image (${res.status})`);
	}
	const buf = await res.arrayBuffer();
	const mimeType = res.headers.get("content-type") ?? "image/png";
	return { mimeType, base64: Buffer.from(buf).toString("base64") };
}

export const googleNanoBananaBackend: GenerationBackend = {
	id: "google-nano-banana",
	label: "Gemini 2.5 Flash Image (Nano Banana)",
	vendor: "Google",
	modality: "image",
	safetyTier: "partner", // GA per Google's "now ready for production" announcement
	requiredEnv: [GEMINI_API_KEY_ENV],
	capabilities: {
		sizes: ["1024x1024", "1536x1024", "1024x1536"],
		qualities: ["low", "medium", "high"],
		// UNVERIFIED: no publicly documented `seed` parameter for image output on
		// this generateContent surface — left disabled pending confirmation.
		supportsSeedLock: false,
		// Accepts multiple inlineData reference images blended into one
		// generation — the closest image-modality analog to omni-reference.
		supportsOmniReference: true,
		supportsLastFrame: false,
		supportsReferenceEdits: true, // reference image(s) carry character identity — the model's headline feature
		intents: ["character-still", "broll-still", "text-in-image"],
	},

	isAvailable() {
		return Boolean(webEnv.GEMINI_API_KEY);
	},

	estimateCost(req: BackendRequest): CostEstimate {
		const credits = CREDITS_BY_QUALITY[req.quality ?? "high"] ?? 14;
		return {
			credits,
			basis: `Nano Banana (${mapQualityToImageSize(req.quality)})`,
		};
	},

	async submit(req: BackendRequest): Promise<SubmitResult> {
		const key = webEnv.GEMINI_API_KEY;
		if (!key) {
			return {
				jobId: "",
				status: "failed",
				error: "GEMINI_API_KEY is not configured",
			};
		}

		try {
			const parts: Array<Record<string, unknown>> = [{ text: req.prompt }];
			const refUrls = [
				req.referenceImageUrl,
				...(req.referenceImages ?? []),
			].filter((url): url is string => Boolean(url));

			for (const url of refUrls) {
				const { mimeType, base64 } = await fetchAsInlineData(url);
				parts.push({ inlineData: { mimeType, data: base64 } });
			}

			const body = {
				contents: [{ parts }],
				generationConfig: {
					responseModalities: ["IMAGE"],
					imageConfig: {
						aspectRatio: mapSizeToAspectRatio(req.size),
						imageSize: mapQualityToImageSize(req.quality),
					},
				},
			};

			// Sync generation returning inline base64 image bytes — media budget.
			const res = await fetchWithTimeout(
				`${GEMINI_BASE}/models/${NANO_BANANA_MODEL}:generateContent`,
				{
					timeoutMs: MEDIA_TIMEOUT_MS,
					method: "POST",
					headers: {
						"x-goog-api-key": key,
						"Content-Type": "application/json",
					},
					body: JSON.stringify(body),
				},
			);

			if (!res.ok) {
				const text = await res.text();
				return {
					jobId: "",
					status: "failed",
					error: `Nano Banana submit failed ${res.status}: ${text}`,
				};
			}

			const data = (await res.json()) as GenerateContentResponse;
			const imagePart = data.candidates
				?.flatMap((c) => c.content?.parts ?? [])
				.find((p) => p.inlineData?.data);

			if (!imagePart?.inlineData?.data) {
				return { jobId: "", status: "failed", error: "No image produced" };
			}

			const mimeType = imagePart.inlineData.mimeType ?? "image/png";
			return {
				jobId: nanoid(),
				status: "completed",
				mediaUrl: `data:${mimeType};base64,${imagePart.inlineData.data}`,
				seed: req.seed,
			};
		} catch (err) {
			return {
				jobId: "",
				status: "failed",
				error: err instanceof Error ? err.message : "Nano Banana submit failed",
			};
		}
	},

	// Synchronous backend: nothing to poll.
	async poll(jobId: string): Promise<PollResult> {
		return { jobId, status: "completed" };
	},
};

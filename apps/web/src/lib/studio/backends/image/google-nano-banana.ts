/**
 * Image adapter — Nano Banana Pro (Gemini 3 Pro Image).
 *
 * Native Google API via the Gemini API's `generateContent` surface
 * (generativelanguage.googleapis.com) — the same endpoint used for text
 * generation, with `responseModalities: ["IMAGE"]` requesting image output.
 * Synchronous: base64 image bytes come back inline in
 * `candidates[0].content.parts[].inlineData`, so this follows the GPT Image
 * sync template. Verified 2026-07 (web search against ai.google.dev's model
 * page + a real-world litellm bug report quoting the raw request body) that
 * `generateContent` + `generationConfig.responseModalities` +
 * `generationConfig.imageConfig.{aspectRatio,imageSize}` is still the correct
 * shape for the Pro model — Google's newer "Interactions API" is the
 * *recommended* surface going forward but generateContent remains supported,
 * and switching would be a bigger change than this task's scope. Nano Banana
 * Pro's headline feature is exactly what
 * `supportsReferenceEdits`/`supportsOmniReference` describe — blending up to
 * 14 input images (character/product/style refs) with strong identity carry
 * into a new render — so `referenceImageUrl`/`referenceImages` are wired
 * through as `inlineData` parts alongside the prompt.
 */

import { webEnv } from "@byorn/env/web";
import { nanoid } from "nanoid";
import { fetchWithTimeout, MEDIA_TIMEOUT_MS } from "@/lib/studio/fetch-timeout";
import { costFor } from "@/lib/credits/cost-table";
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
// GA model id per ai.google.dev/gemini-api/docs/models/gemini-3-pro-image
// (listed "Stable", no "-preview" suffix, as of 2026-07). The model launched
// Nov 2025 as `gemini-3-pro-image-preview`; GEMINI_NANO_BANANA_MODEL still
// lets ops pin back to the preview id if the GA id ever regresses.
const NANO_BANANA_MODEL =
	webEnv.GEMINI_NANO_BANANA_MODEL || "gemini-3-pro-image";

// Nano Banana Pro bills ~$0.134 per 1K/2K image and ~$0.24 per 4K (source:
// Google's Gemini 3 Pro Image pricing announcement) — that's the COGS figure
// documented in cost-table.ts (`google-nano-banana`), marked up for sale
// there. 4K is intentionally not exposed in the beta UI (cost control), so
// there's no "high-high" tier. `estimateCost` below reads `costFor` directly
// (flat regardless of the low/medium/high quality knob) rather than a second
// hand-set table, so display can't drift from what's actually charged.

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
	label: "Nano Banana Pro (Gemini 3 Pro Image)",
	vendor: "Google",
	modality: "image",
	safetyTier: "partner", // GA per Google's "now ready for production" announcement
	requiredEnv: [GEMINI_API_KEY_ENV],
	capabilities: {
		// The shared ImageSize wire type only has these 3 members (persona-still,
		// the image route, and DB records all key off it) — kept as-is and mapped
		// to 1:1 / 3:2 / 2:3. Nano Banana Pro actually supports far more aspect
		// ratios (1:1, 3:2, 2:3, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9) and up to
		// 4K via imageConfig.imageSize, but 4K/extra ratios aren't exposed here
		// for the beta (cost control + no UI need yet).
		sizes: ["1024x1024", "1536x1024", "1024x1536"],
		qualities: ["low", "medium", "high"],
		// UNVERIFIED: no publicly documented `seed` parameter for image output on
		// this generateContent surface — left disabled pending confirmation.
		supportsSeedLock: false,
		// Accepts multiple inlineData reference images blended into one
		// generation — the closest image-modality analog to omni-reference.
		// Pro raises the reference ceiling to up to 14 images (identity carry
		// across up to 5 subjects) — the request builder below already forwards
		// every ref supplied by the caller, so no code change was needed here.
		supportsOmniReference: true,
		supportsLastFrame: false,
		supportsReferenceEdits: true, // reference image(s) carry character identity — the model's headline feature
		intents: ["character-still", "broll-still", "text-in-image"],
	},

	isAvailable() {
		return Boolean(webEnv.GEMINI_API_KEY);
	},

	estimateCost(req: BackendRequest): CostEstimate {
		const credits = costFor("google-nano-banana", "image", { count: 1 });
		return {
			credits,
			basis: `Nano Banana Pro (${mapQualityToImageSize(req.quality)})`,
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
					error: `Nano Banana Pro submit failed ${res.status}: ${text}`,
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
				error:
					err instanceof Error ? err.message : "Nano Banana Pro submit failed",
			};
		}
	},

	// Synchronous backend: nothing to poll.
	async poll(jobId: string): Promise<PollResult> {
		return { jobId, status: "completed" };
	},
};

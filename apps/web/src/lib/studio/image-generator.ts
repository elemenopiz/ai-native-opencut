/**
 * GPT Image reference frame generator.
 * Generates character/scene/product stills that feed into Seedance image-to-video.
 */

import { webEnv } from "@opencut-ai/env/web";

export type ImageSize = "1024x1024" | "1536x1024" | "1024x1536";
export type ImageQuality = "low" | "medium" | "high";

export interface GenerateImageParams {
	prompt: string;
	size?: ImageSize;
	quality?: ImageQuality;
	n?: number;
}

export interface GenerateImageResult {
	imageUrl: string;
	revisedPrompt?: string;
}

const OPENAI_BASE = "https://api.openai.com/v1";

export async function generateReferenceImage(
	params: GenerateImageParams,
): Promise<GenerateImageResult[]> {
	const key = webEnv.OPENAI_API_KEY;
	if (!key) throw new Error("OPENAI_API_KEY is not configured");

	const model = webEnv.OPENAI_IMAGE_MODEL || "gpt-image-2";

	const res = await fetch(`${OPENAI_BASE}/images/generations`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${key}`,
			"Content-Type": "application/json",
		},
		// GPT Image models (gpt-image-1/2) ignore response_format and always
		// return b64_json — so we don't request "url" (which would 400). We read
		// b64 below, with a url fallback for DALL·E-style overrides.
		body: JSON.stringify({
			model,
			prompt: params.prompt,
			n: params.n ?? 1,
			size: params.size ?? "1024x1024",
			quality: params.quality ?? "high",
		}),
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`OpenAI image generation failed ${res.status}: ${text}`);
	}

	const data = await res.json() as {
		data: Array<{ url?: string; b64_json?: string; revised_prompt?: string }>;
	};

	return data.data.map((item) => ({
		imageUrl: item.url ?? `data:image/png;base64,${item.b64_json}`,
		revisedPrompt: item.revised_prompt,
	}));
}

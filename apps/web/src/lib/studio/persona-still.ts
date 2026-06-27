/**
 * Persona scene-still renderer — the heart of reference-conditioned character
 * consistency. Given a persona's anchor portrait (+ optional extra angles) and a
 * scene prompt, call gpt-image-2's /images/edits endpoint to place the SAME
 * character into the new scene. The resulting still becomes the reference frame
 * for Seedance image-to-video, so the character recurs shot to shot WITHOUT any
 * training / LoRA.
 *
 * gpt-image-2 only — best model, no fallback (product decision: "use only the
 * best"). Note the edits endpoint is multipart/form-data (NOT JSON like
 * /generations) and returns b64_json, which we rehost to R2 for a stable,
 * publicly-fetchable URL (Seedance needs to fetch the reference frame).
 */

import { webEnv } from "@opencut-ai/env/web";
import { canRehost, fetchBytes, rehostToR2 } from "@/lib/studio/media-storage";
import type { ImageSize } from "@/lib/studio/image-generator";
import { composePersonaScenePrompt } from "@/lib/studio/personas";

const OPENAI_BASE = "https://api.openai.com/v1";

export interface RenderPersonaStillParams {
	/** Canonical portrait — the primary identity reference. */
	anchorImageUrl: string;
	/** Extra angles (3/4, profile, back); passed as additional references. */
	refImageUrls?: string[];
	/** What the character is doing / where they are in this shot. */
	scenePrompt: string;
	/** The persona's locked identity sentence, woven in for textual anchoring. */
	descriptor: string;
	/** Output size; default square. Pass "1024x1536" for portrait reels. */
	size?: ImageSize;
}

export interface RenderPersonaStillResult {
	imageUrl: string;
}

/** Fetch a source image and wrap it as a PNG Blob for multipart upload. */
async function toImageBlob(url: string): Promise<Blob> {
	const bytes = await fetchBytes(url);
	return new Blob([bytes], { type: "image/png" });
}

export async function renderPersonaStill(
	params: RenderPersonaStillParams,
): Promise<RenderPersonaStillResult> {
	const key = webEnv.OPENAI_API_KEY;
	if (!key) throw new Error("OPENAI_API_KEY is not configured");

	const model = webEnv.OPENAI_IMAGE_MODEL || "gpt-image-2";

	// Anchor first (a mask, if ever added, applies to the first image), then any
	// extra angles. Fetch all references and wrap them as Blobs in parallel.
	const sourceUrls = [params.anchorImageUrl, ...(params.refImageUrls ?? [])];
	const blobs = await Promise.all(sourceUrls.map(toImageBlob));

	const form = new FormData();
	form.append("model", model);
	form.append(
		"prompt",
		composePersonaScenePrompt(params.descriptor, params.scenePrompt),
	);
	form.append("size", params.size ?? "1024x1024");
	// gpt-image edits accepts one or more references via the image[] field.
	for (const blob of blobs) {
		form.append("image[]", blob, "ref.png");
	}

	// No explicit Content-Type — fetch sets the multipart boundary itself.
	const res = await fetch(`${OPENAI_BASE}/images/edits`, {
		method: "POST",
		headers: { Authorization: `Bearer ${key}` },
		body: form,
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`OpenAI persona still failed ${res.status}: ${text}`);
	}

	const data = (await res.json()) as {
		data: Array<{ b64_json?: string; url?: string }>;
	};
	const first = data.data?.[0];
	if (!first) throw new Error("OpenAI returned no image for persona still");

	// gpt-image returns b64_json. Rehost to R2 for a stable public URL (needed as
	// a Seedance image-to-video reference); fall back to a data URL if R2 is off.
	let imageUrl = first.url ?? `data:image/png;base64,${first.b64_json}`;
	if (canRehost()) {
		try {
			const bytes = await fetchBytes(imageUrl);
			imageUrl = await rehostToR2(bytes, "image/png");
		} catch (err) {
			console.error("Failed to rehost persona still to R2:", err);
		}
	}

	return { imageUrl };
}

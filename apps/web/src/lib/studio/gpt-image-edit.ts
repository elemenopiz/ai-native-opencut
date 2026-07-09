/**
 * OpenAI GPT Image `/images/edits` — reference-conditioned still.
 *
 * The multi-photo reference path: given one or more reference images and a
 * prompt, GPT Image edits keeps the SAME subject and places them into the new
 * scene. Returns a fetchable https URL — gpt-image returns b64, which we rehost
 * to R2 (Seedance can't fetch data: URLs).
 *
 * Deliberately standalone (imports no router/registry) so the routed adapter
 * `backends/image/openai-gpt-image.ts` can call it without an import cycle:
 * persona-still → router → registry → openai adapter → this module.
 */

import { webEnv } from "@byorn/env/web";
import { canRehost, fetchBytes, rehostToR2 } from "@/lib/studio/media-storage";
import type { ImageSize } from "@/lib/studio/image-generator";

const OPENAI_BASE = "https://api.openai.com/v1";

export interface GptImageEditParams {
	/** Fully-composed edit prompt (identity descriptor already woven in). */
	prompt: string;
	/** Reference images (anchor first). At least one required. */
	referenceImages: string[];
	/** Output size; default square. Pass "1024x1536" for portrait reels. */
	size?: ImageSize;
}

/** Fetch a source image and wrap it as a PNG Blob for multipart upload. */
async function toImageBlob(url: string): Promise<Blob> {
	const bytes = await fetchBytes(url);
	return new Blob([bytes], { type: "image/png" });
}

export async function renderGptImageEdit(
	params: GptImageEditParams,
): Promise<{ imageUrl: string }> {
	const key = webEnv.OPENAI_API_KEY;
	if (!key) throw new Error("OPENAI_API_KEY is not configured");

	const model = webEnv.OPENAI_IMAGE_MODEL || "gpt-image-2";

	const sources = params.referenceImages.filter(Boolean);
	if (sources.length === 0) {
		throw new Error("renderGptImageEdit requires at least one reference image");
	}
	// Anchor first (a mask, if ever added, applies to the first image), then any
	// extra angles. Fetch all references and wrap them as Blobs in parallel.
	const blobs = await Promise.all(sources.map(toImageBlob));

	const form = new FormData();
	form.append("model", model);
	form.append("prompt", params.prompt);
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
		throw new Error(`OpenAI reference still failed ${res.status}: ${text}`);
	}

	const data = (await res.json()) as {
		data: Array<{ b64_json?: string; url?: string }>;
	};
	const first = data.data?.[0];
	// Require an actual image payload — an item that carries neither a url nor
	// b64_json would otherwise build "data:image/png;base64,undefined" and
	// surface downstream as an opaque Seedance fetch error.
	if (!first || (!first.url && !first.b64_json)) {
		throw new Error("OpenAI returned no image for reference still");
	}

	// The still becomes a Seedance image-to-video reference, so it MUST end up at
	// a publicly-fetchable http(s) URL. gpt-image returns b64_json (no url), which
	// we rehost to R2. A data: URL is not fetchable by Seedance, so we never hand
	// one downstream — if we can't produce a real URL we fail loudly.
	if (first.url) {
		return { imageUrl: first.url };
	}

	if (!canRehost()) {
		throw new Error(
			"Reference stills require R2 storage: gpt-image returns base64 only and " +
				"Seedance cannot fetch data URLs. Configure R2_* env vars.",
		);
	}

	const buf = Buffer.from(first.b64_json!, "base64");
	const bytes = buf.buffer.slice(
		buf.byteOffset,
		buf.byteOffset + buf.byteLength,
	);
	const imageUrl = await rehostToR2(bytes, "image/png");

	return { imageUrl };
}

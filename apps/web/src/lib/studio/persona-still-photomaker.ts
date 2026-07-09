/**
 * Persona scene-still renderer — DURABLE (HD) tier, license-clean and local.
 *
 * Same job as persona-still.ts (place the SAME character into a new scene so the
 * still can seed Seedance image-to-video), but instead of gpt-image-2 this renders
 * the still locally on our own image microservice via PhotoMaker v1 (Apache-2.0 —
 * no proprietary weights, no per-image API charge). Best durable likeness of the
 * three consistency tiers; the trade-off is it needs the local image service
 * running and is slower than the cloud path.
 *
 * The endpoint is multipart/form-data (repeatable `image` field, anchor FIRST)
 * and returns raw image/png bytes (a FileResponse), NOT JSON. We rehost those
 * bytes to R2 so the result is a stable, publicly-fetchable URL — Seedance must be
 * able to fetch the reference frame, and it cannot fetch a data: URL.
 */

import { canRehost, fetchBytes, rehostToR2 } from "@/lib/studio/media-storage";
import type { ImageSize } from "@/lib/studio/image-generator";
import { composePersonaScenePrompt } from "@/lib/studio/personas";
import type {
	RenderPersonaStillParams,
	RenderPersonaStillResult,
} from "@/lib/studio/persona-still";

/**
 * Base URL of the local image microservice. Resolved server-side (this runs in
 * the /api/studio/generate route); NEXT_PUBLIC_* vars are readable server-side.
 */
const IMAGE_SERVICE_URL =
	process.env.NEXT_PUBLIC_IMAGE_SERVICE_URL || "http://localhost:8423";

/** Default negatives that keep PhotoMaker from drifting into obvious artifacts. */
const DEFAULT_NEGATIVE_PROMPT = "blurry, deformed, lowres, extra limbs";

/** Map the shared ImageSize enum to explicit pixel width/height for the service. */
function dimsForSize(size: ImageSize | undefined): { width: number; height: number } {
	switch (size) {
		case "1024x1536":
			return { width: 1024, height: 1536 };
		case "1536x1024":
			return { width: 1536, height: 1024 };
		default:
			return { width: 1024, height: 1024 };
	}
}

/** Fetch a source image and wrap it as a PNG Blob for multipart upload. */
async function toImageBlob(url: string): Promise<Blob> {
	const bytes = await fetchBytes(url);
	return new Blob([bytes], { type: "image/png" });
}

/**
 * Render a persona scene still with PhotoMaker v1 on the local image service.
 * Same signature/return as `renderPersonaStill` so the /generate route can swap
 * tiers transparently.
 */
export async function renderPersonaStillPhotoMaker(
	params: RenderPersonaStillParams,
): Promise<RenderPersonaStillResult> {
	// A local render is worthless if we can't hand Seedance a fetchable URL. Fail
	// loudly up front (same policy as the gpt-image path) rather than after paying
	// the render latency.
	if (!canRehost()) {
		throw new Error(
			"Durable persona stills require R2 storage: the still is produced as raw " +
				"bytes and Seedance cannot fetch data URLs. Configure R2_* env vars.",
		);
	}

	// Anchor FIRST (it's the primary identity reference), then any extra angles.
	// Fetch all references and wrap them as PNG Blobs in parallel.
	const sourceUrls = [params.anchorImageUrl, ...(params.refImageUrls ?? [])];
	const blobs = await Promise.all(sourceUrls.map(toImageBlob));

	const { width, height } = dimsForSize(params.size);

	const form = new FormData();
	// Repeatable `image` field — anchor first, then refs (order preserved).
	for (const blob of blobs) {
		form.append("image", blob, "ref.png");
	}
	form.append(
		"prompt",
		composePersonaScenePrompt(params.descriptor, params.scenePrompt),
	);
	form.append("negative_prompt", DEFAULT_NEGATIVE_PROMPT);
	form.append("width", String(width));
	form.append("height", String(height));
	form.append("steps", "30");
	form.append("style_strength", "20");
	form.append("guidance_scale", "5.0");

	// No explicit Content-Type — fetch sets the multipart boundary itself.
	let res: Response;
	try {
		res = await fetch(`${IMAGE_SERVICE_URL}/persona/still`, {
			method: "POST",
			body: form,
		});
	} catch {
		throw new Error(
			`Could not reach the local image service at ${IMAGE_SERVICE_URL}. ` +
				"Start it (port 8423) to use the Durable (HD) consistency tier.",
		);
	}

	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		const hint =
			res.status === 501
				? " The image service is running but PhotoMaker dependencies/model are not installed."
				: " Is the local image service running and the model loaded?";
		throw new Error(
			`PhotoMaker persona still failed ${res.status}: ${detail || "no detail"}.${hint}`,
		);
	}

	// The service returns raw image/png bytes (FileResponse), not JSON.
	const bytes = await res.arrayBuffer();
	const imageUrl = await rehostToR2(bytes, "image/png");

	return { imageUrl };
}

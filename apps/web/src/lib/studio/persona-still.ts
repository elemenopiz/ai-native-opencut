/**
 * Persona scene-still renderer — the heart of reference-conditioned character
 * consistency. Given a persona's anchor portrait (+ any uploaded angles) and a
 * scene prompt, produce a still that places the SAME character into the new
 * scene. That still becomes the reference frame for Seedance image-to-video, so
 * the character recurs shot to shot WITHOUT any training / LoRA.
 *
 * Routed, not hardcoded: the still goes through the multi-provider image
 * backends via the "character-still" intent — the router picks whichever
 * reference-edit-capable provider is configured (GPT Image, Gemini / Nano
 * Banana, …), ranked by safety tier then cost. The persona's anchor + every
 * uploaded photo are handed to the backend as reference images, so likeness
 * rides on the full multi-photo set rather than a single frame.
 *
 * The result is normalized to a fetchable https URL: providers that return
 * inline base64 (e.g. Nano Banana's data: URLs) are rehosted to R2, because
 * Seedance cannot fetch data URLs.
 */

import { ensureBackendsRegistered, routeSlot } from "@/lib/studio/backends";
import type { BackendId } from "@/lib/studio/backends";
import { composePersonaScenePrompt } from "@/lib/studio/personas";
import { canRehost, fetchBytes, rehostToR2 } from "@/lib/studio/media-storage";
import type { ImageSize } from "@/lib/studio/image-generator";
import type { GenerationSpec } from "@/types/timeline";

export interface RenderPersonaStillParams {
	/** Canonical portrait — the primary identity reference (passed first). */
	anchorImageUrl: string;
	/** Extra angles / uploaded photos; passed as additional references. */
	refImageUrls?: string[];
	/** What the character is doing / where they are in this shot. */
	scenePrompt: string;
	/** The persona's locked identity sentence, woven in for textual anchoring. */
	descriptor: string;
	/** Output size; default square. Pass "1024x1536" for portrait reels. */
	size?: ImageSize;
	/** Manual provider pin (the "exception" dropdown) — a backend id. */
	preferredBackendId?: BackendId;
}

export interface RenderPersonaStillResult {
	imageUrl: string;
	/** The image backend the router actually picked — lets the caller charge the
	 *  EXACT per-backend credit cost instead of a default estimate. */
	backendId: BackendId;
}

/** Ensure the still lands at a fetchable https URL. Providers that hand back a
 *  data: URL (inline base64) are rehosted to R2 — Seedance can't fetch data
 *  URLs. Already-remote URLs pass through untouched. */
async function toFetchableUrl(url: string): Promise<string> {
	if (url.startsWith("http")) return url;
	if (!canRehost()) {
		throw new Error(
			"Persona stills require R2 storage: the image provider returned inline " +
				"data and Seedance cannot fetch data URLs. Configure R2_* env vars.",
		);
	}
	const bytes = await fetchBytes(url);
	return rehostToR2(bytes, "image/png");
}

export async function renderPersonaStill(
	params: RenderPersonaStillParams,
): Promise<RenderPersonaStillResult> {
	ensureBackendsRegistered();

	// Anchor first, then every uploaded angle — the full multi-photo reference set.
	const referenceImages = [
		params.anchorImageUrl,
		...(params.refImageUrls ?? []),
	].filter(Boolean);

	const prompt = composePersonaScenePrompt(
		params.descriptor,
		params.scenePrompt,
	);

	// Minimal spec — intent is passed explicitly, so only the fields the router's
	// cost ranking reads (prompt, references) matter here.
	const spec: GenerationSpec = {
		prompt,
		mode: "image-to-video",
		referenceImageUrl: params.anchorImageUrl,
		referenceImages,
		personaId: "persona-still",
		// Required by GenerationSpec but irrelevant to image-still routing/cost —
		// the router only reads prompt + references for a character-still slot.
		resolution: "720p",
		orientation: "portrait",
		duration: 5,
	};

	const route = routeSlot({
		modality: "image",
		spec,
		intent: "character-still",
		preferredBackendId: params.preferredBackendId,
	});

	if (!route.backend.isAvailable()) {
		throw new Error(
			`${route.backend.label} is not configured — set ${route.backend.requiredEnv.join(
				", ",
			)}`,
		);
	}

	const result = await route.backend.submit({
		modality: "image",
		prompt,
		referenceImageUrl: params.anchorImageUrl,
		referenceImages,
		size: params.size ?? "1024x1024",
	});

	if (result.status === "failed" || !result.mediaUrl) {
		throw new Error(result.error ?? "Persona still generation failed");
	}

	return {
		imageUrl: await toFetchableUrl(result.mediaUrl),
		backendId: route.backend.id,
	};
}

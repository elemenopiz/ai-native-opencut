/**
 * Provider adapter — one function, one backend (BytePlus ModelArk).
 * Submit → poll → return. Keys live server-side (env vars), never reach the
 * browser. Kept as a thin adapter so a second backend could slot in later, but
 * we generate direct-to-source via BytePlus only (no reseller markup).
 */

import { webEnv } from "@byorn/env/web";
import { fetchWithTimeout } from "@/lib/studio/fetch-timeout";
import { buildReferenceContractSentence } from "@/lib/studio/personas";
import type { ReferenceImage } from "@/lib/studio/backends/types";

// ─── Types ────────────────────────────────────────────────────────────────

export type VideoResolution = "480p" | "720p" | "1080p";
export type VideoOrientation = "landscape" | "portrait" | "square";
export type VideoMode = "text-to-video" | "image-to-video";

export interface GenerateVideoParams {
	prompt: string;
	referenceImageUrl?: string;
	/**
	 * Seedance 2.0 omni-reference: reference media the model conditions on for
	 * subject / style / scene — none is a fixed frame; the prompt @mentions them.
	 * Publicly-fetchable URLs (R2) so BytePlus can pull them.
	 */
	referenceImages?: string[];
	/**
	 * The roled + named form of `referenceImages` (see `ReferenceImage`'s
	 * docblock in backends/types.ts). Optional and purely additive: when a
	 * caller supplies it, `byteplusSubmit` appends the explicit per-reference
	 * "use image N only for…" contract sentence
	 * (`personas.ts`'s `buildReferenceContractSentence`) to the prompt text
	 * before submitting — reference images themselves still go out via the
	 * plain `referenceImages` array above, unchanged. Order MUST match
	 * `referenceImages` 1:1 (index N here describes `referenceImages[N]`,
	 * i.e. what the prompt calls `@ImageN+1`/`image N+1`).
	 *
	 * No current caller populates this yet — `backends/video/byteplus-seedance.ts`
	 * (the only caller of `generateVideo`) forwards `referenceImageUrl` /
	 * `referenceImages` / `referenceVideos` but not this field. Left in place,
	 * same as `BackendRequest.realFaceReference`, so a follow-up can thread it
	 * through (`GenerationBackend.submit` → here) without touching this
	 * adapter's request shape again.
	 */
	referenceImageRefs?: ReferenceImage[];
	referenceVideos?: string[];
	/** First & last frame mode: the end frame to transition to (flf2v). */
	lastFrameUrl?: string;
	seed?: number;
	resolution: VideoResolution;
	orientation: VideoOrientation;
	duration: number;
	mode?: VideoMode;
	/** When `false`, render the clip silent (Seedance `generate_audio: false`).
	 *  Omitted ⇒ the provider default. */
	generateAudio?: boolean;
}

export interface GenerateVideoResult {
	jobId: string;
	seed?: number;
	status: "pending" | "processing" | "completed" | "failed";
	videoUrl?: string;
	error?: string;
}

export interface PollVideoResult {
	jobId: string;
	status: "pending" | "processing" | "completed" | "failed";
	videoUrl?: string;
	seed?: number;
	error?: string;
}

// ─── Orientation → aspect ratio ─────────────────────────────────────────────
// Seedance takes a quality tier (`resolution`) and an aspect `ratio` as two
// separate fields, so orientation maps cleanly onto the ratio.

const RATIO_BY_ORIENTATION: Record<VideoOrientation, string> = {
	landscape: "16:9",
	portrait: "9:16",
	square: "1:1",
};

// ─── BytePlus ModelArk ──────────────────────────────────────────────────────
// Direct Seedance 2.0 via the BytePlus/Volcengine Ark platform. No reseller
// markup. Request/response shapes per the ModelArk video-task API:
//   POST /contents/generations/tasks  → { id }
//   GET  /contents/generations/tasks/{id} → { id, status, content: { video_url } }
// Seed is accepted on submit but NOT returned, which is why we pin it ourselves.
// Docs: https://docs.byteplus.com/en/docs/ModelArk/1520757

// Defaults to the BytePlus (international) endpoint. Volcengine China users set
// BYTEPLUS_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
const DEFAULT_BYTEPLUS_BASE = "https://ark.ap-southeast.bytepluses.com/api/v3";

function byteplusBase(): string {
	return webEnv.BYTEPLUS_BASE_URL || DEFAULT_BYTEPLUS_BASE;
}

async function byteplusSubmit(
	params: GenerateVideoParams,
): Promise<GenerateVideoResult> {
	const key = webEnv.BYTEPLUS_API_KEY;
	if (!key) throw new Error("BYTEPLUS_API_KEY is not configured");

	// Seedance 2.0 multimodal model on BytePlus international. This is the
	// MultimodalToVideo model that powers omni-reference. Note the `dreamina-`
	// prefix — the `doubao-` IDs are Volcengine-China-only and 404 on BytePlus.
	const modelId =
		webEnv.BYTEPLUS_SEEDANCE_ENDPOINT_ID || "dreamina-seedance-2-0-260128";

	// Reference role contract: when the caller supplies the roled form
	// alongside the plain `referenceImages`, append the explicit "use image N
	// only for…" sentence to the prompt text — see `referenceImageRefs`'s
	// docblock above and docs/plans/2026-09-18-commercial-prompt-patterns.md §4.
	// A caller with no roled references (today: all of them — see the
	// docblock) gets `""` back and the prompt is sent verbatim, unchanged.
	const contractSentence = params.referenceImageRefs
		? buildReferenceContractSentence(params.referenceImageRefs)
		: "";
	const promptText = contractSentence
		? `${params.prompt} ${contractSentence}`
		: params.prompt;

	// Build the multimodal content array. Order: prompt text, then the
	// image-to-video first frame (if any), then any omni-reference images and
	// videos. Each reference carries a `role` so Seedance 2.0 treats it as a
	// conditioning reference rather than a frame to animate.
	const content: Record<string, unknown>[] = [
		{ type: "text", text: promptText },
	];

	// First frame — persona stills + First-&-last-frame mode. Only inject the
	// reference as a frame to animate when the caller actually asked for an
	// image-conditioned generation; a stray referenceImageUrl on a text-to-video
	// request must not silently flip it into i2v. ModelArk REQUIRES a role on
	// every image, so this is tagged `first_frame`: alone it's i2v mode, paired
	// with a `last_frame` it's flf2v (verified against the live API).
	if (params.referenceImageUrl && params.mode === "image-to-video") {
		content.push({
			type: "image_url",
			image_url: { url: params.referenceImageUrl },
			role: "first_frame",
		});
	}
	if (params.lastFrameUrl) {
		content.push({
			type: "image_url",
			image_url: { url: params.lastFrameUrl },
			role: "last_frame",
		});
	}

	// Omni-reference: each ref carries an explicit role so Seedance conditions on
	// it (subject/style/scene) rather than animating it as a frame. The prompt
	// @mentions them by order (the Nth reference_image is @ImageN). Roles per the
	// ModelArk Seedance 2.0 spec: reference_image / reference_video.
	for (const url of params.referenceImages ?? []) {
		if (!url) continue;
		content.push({
			type: "image_url",
			image_url: { url },
			role: "reference_image",
		});
	}

	for (const url of params.referenceVideos ?? []) {
		if (!url) continue;
		content.push({
			type: "video_url",
			video_url: { url },
			role: "reference_video",
		});
	}

	// Root-level fields (not a nested `parameters` object).
	const body: Record<string, unknown> = {
		model: modelId,
		content,
		resolution: params.resolution,
		ratio: RATIO_BY_ORIENTATION[params.orientation],
		duration: params.duration,
		watermark: false,
		...(params.seed != null ? { seed: params.seed } : {}),
		// Silent-render toggle: only send when explicitly set, so an unset value
		// preserves Seedance's own audio default.
		...(params.generateAudio != null
			? { generate_audio: params.generateAudio }
			: {}),
	};

	const res = await fetchWithTimeout(
		`${byteplusBase()}/contents/generations/tasks`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${key}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		},
	);

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`BytePlus submit failed ${res.status}: ${text}`);
	}

	// Task creation returns only the id — no status, seed, or url yet.
	const data = (await res.json()) as { id: string };

	return { jobId: data.id, status: "pending" };
}

async function byteplusPoll(jobId: string): Promise<PollVideoResult> {
	const key = webEnv.BYTEPLUS_API_KEY;
	if (!key) throw new Error("BYTEPLUS_API_KEY is not configured");

	const res = await fetchWithTimeout(
		`${byteplusBase()}/contents/generations/tasks/${jobId}`,
		{
			headers: { Authorization: `Bearer ${key}` },
		},
	);

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`BytePlus poll failed ${res.status}: ${text}`);
	}

	const data = (await res.json()) as {
		id: string;
		status: string;
		content?: { video_url?: string };
		error?: { message?: string };
	};

	return {
		jobId: data.id,
		status: mapByteplusStatus(data.status),
		videoUrl: data.content?.video_url,
		error: data.error?.message,
	};
}

function mapByteplusStatus(s: string): PollVideoResult["status"] {
	switch (s) {
		case "succeeded":
			return "completed";
		case "failed":
		case "expired":
		case "cancelled":
			return "failed";
		case "running":
			return "processing";
		// "queued" and anything unknown
		default:
			return "pending";
	}
}

// ─── Public adapter API ──────────────────────────────────────────────────────

export async function generateVideo(
	params: GenerateVideoParams,
): Promise<GenerateVideoResult> {
	return byteplusSubmit(params);
}

export async function pollVideo(jobId: string): Promise<PollVideoResult> {
	return byteplusPoll(jobId);
}

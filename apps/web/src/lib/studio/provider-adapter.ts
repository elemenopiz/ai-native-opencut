/**
 * Provider adapter — one function, one backend (BytePlus ModelArk).
 * Submit → poll → return. Keys live server-side (env vars), never reach the
 * browser. Kept as a thin adapter so a second backend could slot in later, but
 * we generate direct-to-source via BytePlus only (no reseller markup).
 */

import { webEnv } from "@opencut-ai/env/web";

// ─── Types ────────────────────────────────────────────────────────────────

export type VideoResolution = "480p" | "720p" | "1080p";
export type VideoOrientation = "landscape" | "portrait" | "square";
export type VideoMode = "text-to-video" | "image-to-video";

export interface GenerateVideoParams {
	prompt: string;
	referenceImageUrl?: string;
	seed?: number;
	resolution: VideoResolution;
	orientation: VideoOrientation;
	duration: number;
	mode?: VideoMode;
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

async function byteplusSubmit(params: GenerateVideoParams): Promise<GenerateVideoResult> {
	const key = webEnv.BYTEPLUS_API_KEY;
	if (!key) throw new Error("BYTEPLUS_API_KEY is not configured");

	const modelId = webEnv.BYTEPLUS_SEEDANCE_ENDPOINT_ID || "doubao-seedance-2-0-260128";

	// Root-level fields (not a nested `parameters` object).
	const body: Record<string, unknown> = {
		model: modelId,
		content: [
			{ type: "text", text: params.prompt },
			...(params.referenceImageUrl && params.mode === "image-to-video"
				? [{ type: "image_url", image_url: { url: params.referenceImageUrl } }]
				: []),
		],
		resolution: params.resolution,
		ratio: RATIO_BY_ORIENTATION[params.orientation],
		duration: params.duration,
		watermark: false,
		...(params.seed != null ? { seed: params.seed } : {}),
	};

	const res = await fetch(`${byteplusBase()}/contents/generations/tasks`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${key}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`BytePlus submit failed ${res.status}: ${text}`);
	}

	// Task creation returns only the id — no status, seed, or url yet.
	const data = await res.json() as { id: string };

	return { jobId: data.id, status: "pending" };
}

async function byteplusPoll(jobId: string): Promise<PollVideoResult> {
	const key = webEnv.BYTEPLUS_API_KEY;
	if (!key) throw new Error("BYTEPLUS_API_KEY is not configured");

	const res = await fetch(`${byteplusBase()}/contents/generations/tasks/${jobId}`, {
		headers: { Authorization: `Bearer ${key}` },
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`BytePlus poll failed ${res.status}: ${text}`);
	}

	const data = await res.json() as {
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
		case "succeeded": return "completed";
		case "failed":
		case "expired":
		case "cancelled": return "failed";
		case "running": return "processing";
		// "queued" and anything unknown
		default: return "pending";
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

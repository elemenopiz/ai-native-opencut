/**
 * VIDEO adapter — Kling AI (Kuaishou), official direct API.
 *
 * Kling's own platform (not an aggregator) at https://api.klingai.com. Auth is
 * a short-lived HS256 JWT you sign yourself from an access key / secret key
 * pair (no OAuth round-trip) — every request carries a fresh 30-minute token.
 * We sign with Node's built-in `crypto` rather than pulling in a JWT library,
 * since this file may only touch `backends/video/`.
 *
 * `KLING_ACCESS_KEY` / `KLING_SECRET_KEY` come from the validated env schema
 * (`@byorn/env/web`); empty string means "not configured" and keeps the
 * adapter inert.
 *
 * Docs: https://kling.ai/document-api/ (text2video / image2video reference).
 * The exact request/response shapes below are reconstructed from the public
 * reference + community wrappers, since the doc site blocks non-browser
 * fetches — fields marked UNVERIFIED should be confirmed against a live key
 * before this is promoted out of "inert".
 */

import { createHmac } from "node:crypto";
import { webEnv } from "@byorn/env/web";
import { estimateVideoCredits } from "@/lib/studio/backends/cost";
import type {
	BackendRequest,
	CostEstimate,
	GenerationBackend,
	JobStatus,
	PollResult,
	SubmitResult,
} from "@/lib/studio/backends/types";
import type { VideoOrientation } from "@/lib/studio/provider-adapter";

const DEFAULT_BASE = "https://api.klingai.com";

function klingBase(): string {
	return webEnv.KLING_BASE_URL || DEFAULT_BASE;
}

function accessKey(): string | undefined {
	return webEnv.KLING_ACCESS_KEY || undefined;
}

function secretKey(): string | undefined {
	return webEnv.KLING_SECRET_KEY || undefined;
}

// ─── JWT (HS256) ────────────────────────────────────────────────────────────
// Claims per Kling's auth doc: iss = access key, exp/nbf as unix seconds, a
// 30-minute window with a small nbf backdate for clock skew. Re-signed on
// every call — cheap, and avoids caching a token past its window.

function base64url(input: string | Buffer): string {
	const buf = typeof input === "string" ? Buffer.from(input) : input;
	return buf
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function signKlingJwt(ak: string, sk: string): string {
	const header = { alg: "HS256", typ: "JWT" };
	const now = Math.floor(Date.now() / 1000);
	// UNVERIFIED: exact exp/nbf offsets (1800s window, 5s nbf backdate) are the
	// commonly documented values; confirm against the live "Quick Start" guide.
	const payload = { iss: ak, exp: now + 1800, nbf: now - 5 };
	const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
	const signature = base64url(
		createHmac("sha256", sk).update(signingInput).digest(),
	);
	return `${signingInput}.${signature}`;
}

// ─── Aspect ratio ───────────────────────────────────────────────────────────

const RATIO_BY_ORIENTATION: Record<VideoOrientation, string> = {
	landscape: "16:9",
	portrait: "9:16",
	square: "1:1",
};

// UNVERIFIED: Kling exposes a "std" | "pro" quality tier (not a resolution
// enum) — pro renders roughly 1080p-equivalent, std roughly 720p-equivalent.
// We approximate our normalized resolution knob onto that tier.
function modeByResolution(resolution: string | undefined): "std" | "pro" {
	return resolution === "1080p" ? "pro" : "std";
}

type KlingKind = "text2video" | "image2video";

/** Job ids are prefixed with which endpoint created them, since Kling's poll
 *  path differs by kind (`/v1/videos/text2video/{id}` vs `.../image2video/{id}`)
 *  and `poll()` otherwise has no way to know which one to hit. */
function encodeJobId(kind: KlingKind, taskId: string): string {
	return `${kind}:${taskId}`;
}

function decodeJobId(jobId: string): { kind: KlingKind; taskId: string } {
	const idx = jobId.indexOf(":");
	const kind = (idx >= 0 ? jobId.slice(0, idx) : "text2video") as KlingKind;
	const taskId = idx >= 0 ? jobId.slice(idx + 1) : jobId;
	return { kind, taskId };
}

function mapKlingStatus(s: string | undefined): JobStatus {
	switch (s) {
		case "succeed":
			return "completed";
		case "failed":
			return "failed";
		case "processing":
			return "processing";
		// "submitted" and anything unrecognized
		default:
			return "pending";
	}
}

interface KlingTaskResponse {
	code: number;
	message?: string;
	data?: {
		task_id: string;
		task_status: string;
		task_status_msg?: string;
		task_result?: { videos?: { url: string }[] };
	};
}

async function klingRequest(
	path: string,
	init: RequestInit,
): Promise<KlingTaskResponse> {
	const ak = accessKey();
	const sk = secretKey();
	if (!ak || !sk) {
		throw new Error("KLING_ACCESS_KEY / KLING_SECRET_KEY are not configured");
	}
	const token = signKlingJwt(ak, sk);
	const res = await fetch(`${klingBase()}${path}`, {
		...init,
		headers: {
			...init.headers,
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
	});
	const data = (await res.json()) as KlingTaskResponse;
	if (!res.ok || (data.code && data.code !== 0)) {
		throw new Error(
			`Kling request failed ${res.status}: ${data.message ?? "unknown error"}`,
		);
	}
	return data;
}

export const klingBackend: GenerationBackend = {
	id: "kling",
	label: "Kling AI",
	vendor: "Kuaishou (Kling AI)",
	modality: "video",
	safetyTier: "partner",
	requiredEnv: ["KLING_ACCESS_KEY", "KLING_SECRET_KEY"],
	capabilities: {
		resolutions: ["720p", "1080p"],
		orientations: ["landscape", "portrait", "square"],
		// Kling v1/v1.6 only accept discrete 5s or 10s durations.
		durationRangeSec: { min: 5, max: 10 },
		// No documented seed parameter on the public text2video/image2video
		// endpoints (UNVERIFIED — some Kling model versions may expose one).
		supportsSeedLock: false,
		// No subject/style/scene omni-reference conditioning documented; only a
		// single first/last animate frame for image2video.
		supportsOmniReference: false,
		// image2video documents an `image_tail` field alongside `image` for the
		// end frame (UNVERIFIED field name — confirm against a live account).
		supportsLastFrame: true,
		supportsReferenceEdits: false,
		intents: ["broll-video"],
	},

	isAvailable() {
		return Boolean(accessKey() && secretKey());
	},

	estimateCost(req: BackendRequest): CostEstimate {
		const credits = estimateVideoCredits(req.resolution, req.duration);
		return {
			credits,
			basis: `Kling ${modeByResolution(req.resolution)} × ${req.duration ?? 5}s`,
		};
	},

	async submit(req: BackendRequest): Promise<SubmitResult> {
		try {
			const isImageToVideo =
				req.mode === "image-to-video" && Boolean(req.referenceImageUrl);
			const kind: KlingKind = isImageToVideo ? "image2video" : "text2video";

			const body: Record<string, unknown> = {
				// UNVERIFIED: model_name catalog changes frequently; default to the
				// widely-documented v1.6 id and let ops override via env.
				model_name: webEnv.KLING_MODEL || "kling-v1-6",
				prompt: req.prompt,
				mode: modeByResolution(req.resolution),
				duration: String(req.duration && req.duration > 5 ? 10 : 5),
				aspect_ratio: RATIO_BY_ORIENTATION[req.orientation ?? "landscape"],
			};

			if (isImageToVideo) {
				body.image = req.referenceImageUrl;
				if (req.lastFrameUrl) {
					// UNVERIFIED: end-frame field name for flf2v-style generation.
					body.image_tail = req.lastFrameUrl;
				}
			}

			const path = `/v1/videos/${kind}`;
			const data = await klingRequest(path, {
				method: "POST",
				body: JSON.stringify(body),
			});

			const taskId = data.data?.task_id;
			if (!taskId) {
				return {
					jobId: "",
					status: "failed",
					error: "Kling returned no task_id",
				};
			}

			return {
				jobId: encodeJobId(kind, taskId),
				status: mapKlingStatus(data.data?.task_status),
			};
		} catch (err) {
			return {
				jobId: "",
				status: "failed",
				error: err instanceof Error ? err.message : "Kling submit failed",
			};
		}
	},

	async poll(jobId: string): Promise<PollResult> {
		try {
			const { kind, taskId } = decodeJobId(jobId);
			const data = await klingRequest(`/v1/videos/${kind}/${taskId}`, {
				method: "GET",
			});
			return {
				jobId,
				status: mapKlingStatus(data.data?.task_status),
				mediaUrl: data.data?.task_result?.videos?.[0]?.url,
				error: data.data?.task_status_msg,
			};
		} catch (err) {
			return {
				jobId,
				status: "failed",
				error: err instanceof Error ? err.message : "Kling poll failed",
			};
		}
	},
};

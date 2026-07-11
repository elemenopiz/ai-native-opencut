/**
 * VIDEO adapter — Pika 2.2, via the fal.ai aggregator (fal-ai/pika/v2.2/*).
 *
 * Pika does not run a self-serve public API of its own anymore — Pika's own
 * developer page points integrators at fal.ai, which hosts Pika 2.2 as
 * standard queue-based HTTP endpoints. This is intentionally an aggregator
 * adapter (per the build brief: "prefer native ... where a model is only
 * reachable via an aggregator, implement against the aggregator's documented
 * API"). `FAL_KEY` gates this adapter, not a Pika-branded key.
 *
 * fal's queue protocol is submit → poll status → fetch result, each against
 * the *same* model path (`fal-ai/pika/v2.2/text-to-video` or
 * `.../image-to-video`), so the job id must remember which sub-path submitted
 * it — we prefix it, same trick as the Kling adapter.
 *
 * Only the core text-to-video / image-to-video endpoints are wired here.
 * Pika's first/last-frame and multi-image scene composition ("Pikaframes" /
 * "Pikascenes") are separate fal model ids — real Pika features, just not
 * implemented in this pass — so `supportsLastFrame` / `supportsOmniReference`
 * are honestly `false` here rather than true-but-unwired.
 *
 * `FAL_KEY` comes from the validated env schema (`@byorn/env/web`); empty
 * string means "not configured" and keeps the adapter inert.
 *
 * Docs: https://fal.ai/models/fal-ai/pika/v2.2/text-to-video/api and
 * https://fal.ai/models/fal-ai/pika/v2.2/image-to-video/api
 */

import { webEnv } from "@byorn/env/web";
import { estimateVideoCredits } from "@/lib/studio/backends/cost";
import { fetchWithTimeout } from "@/lib/studio/fetch-timeout";
import type {
	BackendRequest,
	CostEstimate,
	GenerationBackend,
	JobStatus,
	PollResult,
	SubmitResult,
} from "@/lib/studio/backends/types";
import type { VideoOrientation } from "@/lib/studio/provider-adapter";

const DEFAULT_BASE = "https://queue.fal.run/fal-ai/pika/v2.2";

function falBase(): string {
	return webEnv.FAL_BASE_URL || DEFAULT_BASE;
}

function apiKey(): string | undefined {
	return webEnv.FAL_KEY || undefined;
}

const ASPECT_BY_ORIENTATION: Record<VideoOrientation, string> = {
	landscape: "16:9",
	portrait: "9:16",
	square: "1:1",
};

type PikaSubpath = "text-to-video" | "image-to-video";

function subpathFor(req: BackendRequest): PikaSubpath {
	return req.mode === "image-to-video" && req.referenceImageUrl
		? "image-to-video"
		: "text-to-video";
}

/** Job id remembers which sub-path submitted it — needed because fal's
 *  status/result endpoints are rooted under the same model path used to
 *  submit, and `poll()` otherwise has no way to know which one. */
function encodeJobId(subpath: PikaSubpath, requestId: string): string {
	return `${subpath}:${requestId}`;
}

function decodeJobId(jobId: string): {
	subpath: PikaSubpath;
	requestId: string;
} {
	const idx = jobId.indexOf(":");
	const subpath = (
		idx >= 0 ? jobId.slice(0, idx) : "text-to-video"
	) as PikaSubpath;
	const requestId = idx >= 0 ? jobId.slice(idx + 1) : jobId;
	return { subpath, requestId };
}

async function falFetch<T>(path: string, init?: RequestInit): Promise<T> {
	const key = apiKey();
	if (!key) throw new Error("FAL_KEY is not configured");
	const res = await fetchWithTimeout(`${falBase()}${path}`, {
		...init,
		headers: {
			...init?.headers,
			Authorization: `Key ${key}`,
			"Content-Type": "application/json",
		},
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`fal.ai request failed ${res.status}: ${text}`);
	}
	return (await res.json()) as T;
}

function mapFalStatus(status: string | undefined): JobStatus {
	switch (status) {
		case "COMPLETED":
			return "completed";
		case "IN_PROGRESS":
			return "processing";
		case "ERROR":
			return "failed";
		// "IN_QUEUE" and anything unrecognized
		default:
			return "pending";
	}
}

interface FalStatus {
	status?: string;
	error?: string;
}

interface FalResult {
	video?: { url?: string };
	detail?: string;
}

export const pikaBackend: GenerationBackend = {
	id: "pika",
	label: "Pika 2.2",
	vendor: "Pika (via fal.ai)",
	modality: "video",
	safetyTier: "partner",
	requiredEnv: ["FAL_KEY"],
	capabilities: {
		resolutions: ["720p", "1080p"],
		orientations: ["landscape", "portrait", "square"],
		durationRangeSec: { min: 5, max: 10 },
		// `seed` is a documented integer field on both endpoints.
		supportsSeedLock: true,
		// Real Pika feature (Pikascenes), but wired as a separate fal model id
		// we don't call here — see file header.
		supportsOmniReference: false,
		// Real Pika feature (Pikaframes), same caveat as above.
		supportsLastFrame: false,
		supportsReferenceEdits: false,
		intents: ["character-video", "broll-video"],
	},

	isAvailable() {
		return Boolean(apiKey());
	},

	estimateCost(req: BackendRequest): CostEstimate {
		const credits = estimateVideoCredits(req.resolution, req.duration);
		return {
			credits,
			basis: `Pika 2.2 ${req.resolution ?? "720p"} × ${req.duration ?? 5}s`,
		};
	},

	async submit(req: BackendRequest): Promise<SubmitResult> {
		try {
			const subpath = subpathFor(req);
			const input: Record<string, unknown> = {
				prompt: req.prompt,
				aspect_ratio: ASPECT_BY_ORIENTATION[req.orientation ?? "landscape"],
				resolution: req.resolution === "1080p" ? "1080p" : "720p",
				duration: req.duration && req.duration > 5 ? 10 : 5,
				...(req.seed != null ? { seed: req.seed } : {}),
			};
			if (subpath === "image-to-video") {
				input.image_url = req.referenceImageUrl;
			}

			const { request_id } = await falFetch<{ request_id: string }>(
				`/${subpath}`,
				{ method: "POST", body: JSON.stringify(input) },
			);

			return {
				jobId: encodeJobId(subpath, request_id),
				status: "pending",
			};
		} catch (err) {
			return {
				jobId: "",
				status: "failed",
				error: err instanceof Error ? err.message : "Pika submit failed",
			};
		}
	},

	async poll(jobId: string): Promise<PollResult> {
		try {
			const { subpath, requestId } = decodeJobId(jobId);
			const status = await falFetch<FalStatus>(
				`/${subpath}/requests/${requestId}/status`,
			);
			const mapped = mapFalStatus(status.status);

			if (mapped !== "completed") {
				return { jobId, status: mapped, error: status.error };
			}

			const result = await falFetch<FalResult>(
				`/${subpath}/requests/${requestId}`,
			);
			return {
				jobId,
				status: "completed",
				mediaUrl: result.video?.url,
				error: result.detail,
			};
		} catch (err) {
			return {
				jobId,
				status: "failed",
				error: err instanceof Error ? err.message : "Pika poll failed",
			};
		}
	},
};

/**
 * VIDEO adapter — Runway (Gen-4 / Aleph), official direct API.
 *
 * Runway's own developer API at `api.dev.runwayml.com`, versioned by a date
 * header (`X-Runway-Version`) rather than a URL segment or media-type param —
 * every request must pin one. Submit → task id → poll `/v1/tasks/{id}`, same
 * async shape as our other adapters.
 *
 * Three task types map onto one adapter: `image_to_video` (Gen-4, the
 * standard i2v path — Runway's Gen-4 line requires a starting image, so a
 * pure-text request without a reference still needs `text_to_video`, kept
 * for parity though Runway's newer models lean i2v-first), and
 * `video_to_video` (Aleph — prompt-driven edits of an existing clip, wired
 * whenever the request carries `referenceVideos`). Aleph's exact request
 * shape is thin in the public docs relative to image_to_video, so its fields
 * below are marked UNVERIFIED more heavily than the other two.
 *
 * `RUNWAY_API_KEY` comes from the validated env schema (`@byorn/env/web`); empty
 * string means "not configured" and keeps the adapter inert.
 *
 * Docs: https://docs.dev.runwayml.com/
 */

import { webEnv } from "@byorn/env/web";
import { costFor } from "@/lib/credits/cost-table";
import { fetchWithTimeout } from "@/lib/studio/fetch-timeout";
import type {
	BackendRequest,
	CostEstimate,
	GenerationBackend,
	JobStatus,
	PollResult,
	SubmitResult,
} from "@/lib/studio/backends/types";
import type {
	VideoOrientation,
	VideoResolution,
} from "@/lib/studio/provider-adapter";

const DEFAULT_BASE = "https://api.dev.runwayml.com/v1";
const DEFAULT_VERSION = "2024-11-06";

function runwayBase(): string {
	return webEnv.RUNWAY_BASE_URL || DEFAULT_BASE;
}

function apiKey(): string | undefined {
	return webEnv.RUNWAY_API_KEY || undefined;
}

function apiVersion(): string {
	return webEnv.RUNWAY_API_VERSION || DEFAULT_VERSION;
}

// As of API version 2024-11-06, `ratio` takes an exact pixel dimension string
// rather than a "16:9"-style aspect keyword. The enum of accepted values is
// model-dependent and has shifted release to release — UNVERIFIED: confirm
// the live enum for whichever `model` id is actually configured before
// treating "square" as safe on every model.
const RATIO_TABLE: Record<VideoOrientation, Record<VideoResolution, string>> = {
	landscape: { "480p": "832:480", "720p": "1280:720", "1080p": "1920:1080" },
	portrait: { "480p": "480:832", "720p": "720:1280", "1080p": "1080:1920" },
	square: { "480p": "832:832", "720p": "960:960", "1080p": "1080:1080" },
};

function ratioFor(req: BackendRequest): string {
	const orientation = req.orientation ?? "landscape";
	const resolution = req.resolution ?? "720p";
	return RATIO_TABLE[orientation][resolution];
}

function mapRunwayStatus(status: string | undefined): JobStatus {
	switch (status) {
		case "SUCCEEDED":
			return "completed";
		case "FAILED":
			return "failed";
		case "RUNNING":
			return "processing";
		// "PENDING" and "THROTTLED"
		default:
			return "pending";
	}
}

interface RunwayTask {
	id: string;
	status?: string;
	output?: string[];
	failure?: string;
	failureCode?: string;
}

async function runwayFetch(
	path: string,
	init: RequestInit,
): Promise<RunwayTask> {
	const key = apiKey();
	if (!key) throw new Error("RUNWAY_API_KEY is not configured");
	const res = await fetchWithTimeout(`${runwayBase()}${path}`, {
		...init,
		headers: {
			...init.headers,
			Authorization: `Bearer ${key}`,
			"X-Runway-Version": apiVersion(),
			"Content-Type": "application/json",
		},
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Runway request failed ${res.status}: ${text}`);
	}
	return (await res.json()) as RunwayTask;
}

type RunwayTaskKind = "image_to_video" | "text_to_video" | "video_to_video";

function taskKindFor(req: BackendRequest): RunwayTaskKind {
	if (req.referenceVideos?.length) return "video_to_video";
	if (req.mode === "image-to-video" && req.referenceImageUrl)
		return "image_to_video";
	return "text_to_video";
}

export const runwayBackend: GenerationBackend = {
	id: "runway",
	label: "Runway Gen-4",
	vendor: "Runway",
	modality: "video",
	safetyTier: "partner",
	requiredEnv: ["RUNWAY_API_KEY"],
	capabilities: {
		resolutions: ["480p", "720p", "1080p"],
		orientations: ["landscape", "portrait", "square"],
		durationRangeSec: { min: 5, max: 10 },
		// Seed accepted on image_to_video/text_to_video, max 4294967295 per the
		// 2024-11-06 changelog — a real, documented reproducibility knob.
		supportsSeedLock: true,
		// Aleph (`video_to_video`) accepts reference images/videos for style and
		// subject conditioning during an edit pass (UNVERIFIED exact param name —
		// public docs are thin on this endpoint's full schema).
		supportsOmniReference: true,
		// `promptImage` accepts an array with position markers ('first' | 'last')
		// — documented first-&-last-frame support.
		supportsLastFrame: true,
		// video_to_video (Aleph) is fundamentally a reference-conditioned edit of
		// an existing clip.
		supportsReferenceEdits: true,
		intents: ["character-video", "broll-video"],
	},

	isAvailable() {
		return Boolean(apiKey());
	},

	estimateCost(req: BackendRequest): CostEstimate {
		const credits = costFor("runway", "video", { seconds: req.duration });
		return {
			credits,
			basis: `Runway ${taskKindFor(req)} ${req.resolution ?? "720p"} × ${req.duration ?? 5}s`,
		};
	},

	async submit(req: BackendRequest): Promise<SubmitResult> {
		try {
			const kind = taskKindFor(req);
			// UNVERIFIED: default model ids vary by task type and change as Runway
			// ships new generations; override per-deployment via env.
			const model = webEnv.RUNWAY_MODEL || "gen4_turbo";

			let path: string;
			const body: Record<string, unknown> = {
				model,
				ratio: ratioFor(req),
				duration: req.duration && req.duration > 5 ? 10 : 5,
				...(req.seed != null ? { seed: req.seed } : {}),
			};

			if (kind === "video_to_video") {
				path = "/video_to_video";
				body.videoUri = req.referenceVideos?.[0];
				body.promptText = req.prompt;
				// UNVERIFIED: Aleph's field for extra style/subject reference images.
				if (req.referenceImages?.length) {
					body.references = req.referenceImages.map((uri) => ({
						type: "image",
						uri,
					}));
				}
			} else if (kind === "image_to_video") {
				path = "/image_to_video";
				body.promptText = req.prompt;
				body.promptImage = req.lastFrameUrl
					? [
							{ uri: req.referenceImageUrl, position: "first" },
							{ uri: req.lastFrameUrl, position: "last" },
						]
					: req.referenceImageUrl;
			} else {
				path = "/text_to_video";
				body.promptText = req.prompt;
			}

			const task = await runwayFetch(path, {
				method: "POST",
				body: JSON.stringify(body),
			});

			return {
				jobId: task.id,
				status: mapRunwayStatus(task.status),
			};
		} catch (err) {
			return {
				jobId: "",
				status: "failed",
				error: err instanceof Error ? err.message : "Runway submit failed",
			};
		}
	},

	async poll(jobId: string): Promise<PollResult> {
		try {
			const task = await runwayFetch(`/tasks/${jobId}`, { method: "GET" });
			return {
				jobId: task.id,
				status: mapRunwayStatus(task.status),
				mediaUrl: task.output?.[0],
				error: task.failure,
			};
		} catch (err) {
			return {
				jobId,
				status: "failed",
				error: err instanceof Error ? err.message : "Runway poll failed",
			};
		}
	},
};

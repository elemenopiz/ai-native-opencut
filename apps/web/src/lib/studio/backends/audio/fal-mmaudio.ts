/**
 * AUDIO adapter — MMAudio V2, video-conditioned "score" generation (synced
 * ambience/foley), via the fal.ai aggregator (`fal-ai/mmaudio-v2`).
 *
 * MMAudio takes a video + a text prompt describing the desired soundscape and
 * returns the SAME video re-muxed with a newly generated, temporally-synced
 * audio track — the fal model's output is a `video`, not a standalone audio
 * file. Callers that want audio-only must extract the track client-side (or
 * on export) from the returned video. This is a real MMAudio behavior, not an
 * adapter shortcut — documented in `docs/audio-generation.md`.
 *
 * Reuses the fal queue protocol already proven by the Pika video adapter
 * (submit → poll status → fetch result, all rooted at the same model path).
 * `FAL_KEY` gates this adapter — the same key that already unlocks Pika, so
 * no new provider account is needed if Pika is already configured.
 *
 * `req.referenceVideos[0]` carries the source video URL. `BackendRequest` has
 * no bespoke "audio source video" field — the existing omni-reference-video
 * slot is a natural, additive fit. The intended caller flow is: the client
 * renders a short, audio-stripped, low-res proxy of the timeline span it
 * wants scored and uploads it, then passes that URL here — see
 * `docs/audio-generation.md` (client proxy renderer is NOT built in this
 * pass; this adapter accepts any already-uploaded video URL today).
 *
 * `FAL_BASE_URL`, if set, overrides fal.ai's entire base+model path (same
 * pre-existing quirk as the Pika adapter — it is not a hostname-only swap).
 *
 * Docs: https://fal.ai/models/fal-ai/mmaudio-v2/api
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

const DEFAULT_BASE = "https://queue.fal.run/fal-ai/mmaudio-v2";

/** MMAudio's practical ceiling for a synced score pass — longer spans cost
 *  proportionally more and drift further from the source video's motion. */
export const MMAUDIO_MAX_DURATION_SEC = 30;

function falBase(): string {
	return webEnv.FAL_BASE_URL || DEFAULT_BASE;
}

function apiKey(): string | undefined {
	return webEnv.FAL_KEY || undefined;
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

export const falMmaudioBackend: GenerationBackend = {
	id: "fal-mmaudio",
	label: "MMAudio V2",
	vendor: "fal.ai",
	modality: "audio",
	safetyTier: "partner",
	requiredEnv: ["FAL_KEY"],
	capabilities: {
		durationRangeSec: { min: 1, max: MMAUDIO_MAX_DURATION_SEC },
		// Documented integer `seed` field on the submit payload.
		supportsSeedLock: true,
		supportsOmniReference: false,
		supportsLastFrame: false,
		supportsReferenceEdits: false,
		requiresVideoRef: true,
		intents: ["video-score"],
	},

	isAvailable() {
		return Boolean(apiKey());
	},

	estimateCost(req: BackendRequest): CostEstimate {
		const duration = Math.min(req.duration ?? 8, MMAUDIO_MAX_DURATION_SEC);
		// Sourced directly from cost-table.ts's costFor() — the same
		// server-authoritative billing table the credit-preview UI mirrors —
		// so this is exactly what the job will cost, not a separate normalized
		// routing unit that can drift from real billing.
		const credits = costFor("fal-mmaudio", "audio", { seconds: duration });
		return { credits, basis: `MMAudio V2 score × ${duration}s` };
	},

	async submit(req: BackendRequest): Promise<SubmitResult> {
		try {
			const videoUrl = req.referenceVideos?.[0];
			if (!videoUrl) {
				return {
					jobId: "",
					status: "failed",
					error:
						"MMAudio requires a source video (referenceVideos[0]) — score generation is video-conditioned",
				};
			}

			const duration = Math.min(
				Math.max(1, Math.round(req.duration ?? 8)),
				MMAUDIO_MAX_DURATION_SEC,
			);
			const body: Record<string, unknown> = {
				video_url: videoUrl,
				prompt: req.prompt,
				duration,
				...(req.seed != null ? { seed: req.seed } : {}),
			};

			// Single-endpoint model (no sub-paths like Pika's t2v/i2v split) — the
			// submit path IS the base model path.
			const { request_id } = await falFetch<{ request_id: string }>("", {
				method: "POST",
				body: JSON.stringify(body),
			});

			return { jobId: request_id, status: "pending" };
		} catch (err) {
			return {
				jobId: "",
				status: "failed",
				error: err instanceof Error ? err.message : "MMAudio submit failed",
			};
		}
	},

	async poll(jobId: string): Promise<PollResult> {
		try {
			const status = await falFetch<FalStatus>(`/requests/${jobId}/status`);
			const mapped = mapFalStatus(status.status);

			if (mapped !== "completed") {
				return { jobId, status: mapped, error: status.error };
			}

			const result = await falFetch<FalResult>(`/requests/${jobId}`);
			return {
				jobId,
				status: "completed",
				// NOTE: this is a VIDEO url (source video re-muxed with the
				// generated audio track) — see file header.
				mediaUrl: result.video?.url,
				error: result.detail,
			};
		} catch (err) {
			return {
				jobId,
				status: "failed",
				error: err instanceof Error ? err.message : "MMAudio poll failed",
			};
		}
	},
};

/**
 * AUDIO adapter — ElevenLabs Music, text-to-music with an instrumental toggle
 * and lyric-guided vocals (licensed stems), native ElevenLabs API (`/v1/music`
 * — not fal.ai).
 *
 * `POST /v1/music` is SYNCHRONOUS — it returns the finished audio bytes
 * inline (no queue/poll cycle), the same shape our sync image adapters use:
 * `submit()` returns `status: "completed"` with the audio inlined as a
 * `data:` URL (mirrors `image-generator.ts`'s base64 convention — the calling
 * route rehosts it to R2, same as sync image generation); `poll()` is a
 * terminal no-op kept only for interface uniformity with async backends.
 *
 * Lyrics: the documented `composition_plan` field is ElevenLabs' precise way
 * to pin exact lyric lines to song sections, but its schema is thin in public
 * docs. UNVERIFIED simplification for this pass: lyrics are appended to the
 * plain `prompt` field ("<prompt>\n\nLyrics:\n<lyrics>") rather than built
 * into a `composition_plan` — a real ElevenLabs feature, just looser fidelity
 * than the structured path. A follow-up could move to `composition_plan` for
 * precise per-section lyric/timing control.
 *
 * `ELEVENLABS_API_KEY` comes from the validated env schema (`@byorn/env/web`);
 * empty string means "not configured" and keeps the adapter inert.
 *
 * Docs: https://elevenlabs.io/docs/api-reference/music/compose
 */

import { webEnv } from "@byorn/env/web";
import { nanoid } from "nanoid";
import { estimateAudioCredits } from "@/lib/studio/backends/cost";
import { fetchWithTimeout, MEDIA_TIMEOUT_MS } from "@/lib/studio/fetch-timeout";
import type {
	BackendRequest,
	CostEstimate,
	GenerationBackend,
	PollResult,
	SubmitResult,
} from "@/lib/studio/backends/types";

const DEFAULT_BASE = "https://api.elevenlabs.io/v1";

/** Documented `music_length_ms` range on `/v1/music` (3s–10min). */
const MIN_LENGTH_MS = 3_000;
const MAX_LENGTH_MS = 600_000;

function elevenBase(): string {
	return webEnv.ELEVENLABS_BASE_URL || DEFAULT_BASE;
}

function apiKey(): string | undefined {
	return webEnv.ELEVENLABS_API_KEY || undefined;
}

function musicModel(): string {
	return webEnv.ELEVENLABS_MUSIC_MODEL || "music_v2";
}

function clampLengthMs(seconds: number | undefined): number {
	const ms = Math.round((seconds ?? 30) * 1000);
	return Math.min(Math.max(MIN_LENGTH_MS, ms), MAX_LENGTH_MS);
}

export const elevenlabsMusicBackend: GenerationBackend = {
	id: "elevenlabs-music",
	label: "ElevenLabs Music",
	vendor: "ElevenLabs",
	modality: "audio",
	safetyTier: "partner",
	requiredEnv: ["ELEVENLABS_API_KEY"],
	capabilities: {
		durationRangeSec: { min: 3, max: 600 },
		// Documented integer `seed` field on the request body.
		supportsSeedLock: true,
		supportsOmniReference: false,
		supportsLastFrame: false,
		supportsReferenceEdits: false,
		requiresVideoRef: false,
		intents: ["text-music"],
	},

	isAvailable() {
		return Boolean(apiKey());
	},

	estimateCost(req: BackendRequest): CostEstimate {
		const duration = req.duration ?? 30;
		const credits = estimateAudioCredits(duration);
		return {
			credits,
			basis: `ElevenLabs Music × ${duration}s${req.instrumental ? " (instrumental)" : ""}`,
		};
	},

	async submit(req: BackendRequest): Promise<SubmitResult> {
		try {
			const key = apiKey();
			if (!key) throw new Error("ELEVENLABS_API_KEY is not configured");

			// Lyrics are meaningless (and contradictory) on an instrumental take —
			// only fold them in when the caller isn't forcing instrumental.
			const prompt =
				!req.instrumental && req.lyrics?.trim()
					? `${req.prompt}\n\nLyrics:\n${req.lyrics}`
					: req.prompt;

			const body: Record<string, unknown> = {
				prompt,
				model_id: musicModel(),
				music_length_ms: clampLengthMs(req.duration),
				force_instrumental: Boolean(req.instrumental),
				...(req.seed != null ? { seed: req.seed } : {}),
			};

			const res = await fetchWithTimeout(`${elevenBase()}/music`, {
				method: "POST",
				timeoutMs: MEDIA_TIMEOUT_MS,
				headers: {
					"xi-api-key": key,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
			});
			if (!res.ok) {
				const text = await res.text();
				throw new Error(
					`ElevenLabs Music request failed ${res.status}: ${text}`,
				);
			}

			const bytes = await res.arrayBuffer();
			const contentType = res.headers.get("content-type") || "audio/mpeg";
			const base64 = Buffer.from(bytes).toString("base64");

			return {
				jobId: nanoid(),
				status: "completed",
				mediaUrl: `data:${contentType};base64,${base64}`,
			};
		} catch (err) {
			return {
				jobId: "",
				status: "failed",
				error:
					err instanceof Error ? err.message : "ElevenLabs Music submit failed",
			};
		}
	},

	// Synchronous backend: nothing to poll. If ever called, report completed
	// with no url so callers treat it as terminal rather than looping forever.
	async poll(jobId: string): Promise<PollResult> {
		return { jobId, status: "completed" };
	},
};

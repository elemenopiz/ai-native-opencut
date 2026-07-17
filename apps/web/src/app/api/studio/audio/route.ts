import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { headers } from "next/headers";
import { auth } from "@/lib/auth/server";
import {
	ensureBackendsRegistered,
	getBackend,
	toTakeCost,
	type SlotIntent,
} from "@/lib/studio/backends";
import { canRehost, rehostToR2, fetchBytes } from "@/lib/studio/media-storage";
import { db } from "@/lib/db";
import { audioJobs } from "@/lib/db/schema-studio";
import { enforceRateLimit } from "@/lib/rate-limit";
import { costFor } from "@/lib/credits/cost-table";
import { InsufficientCredits } from "@/lib/credits/ledger";
import {
	insufficientCreditsResponse,
	meteredRelease,
	meteredReserve,
	meteredSettle,
	STUDIO_REF_TYPE,
} from "@/lib/credits/metering";
import type { Provenance, TakeCost } from "@/types/timeline";

/**
 * POST /api/studio/audio — submit an audio generation job.
 *
 * Two non-interchangeable actions, each pinned to its own default backend
 * (override with `model` only to another backend that declares the matching
 * intent):
 *   - "score" → MMAudio V2 (video-to-audio, synced ambience/foley). Requires
 *     `videoUrl` — a client-uploaded video asset reference. See
 *     docs/audio-generation.md for the intended span-proxy upload flow (the
 *     client-side proxy renderer is a later-wave UI piece, NOT built here;
 *     this route accepts any already-uploaded video URL today).
 *   - "music" → ElevenLabs Music (text-to-music, licensed stems). Optional
 *     `lyrics` + `instrumental` toggle.
 *
 * Follows the exact reserve → submit → settle/release shape as
 * `/api/studio/generate` (video) and `/api/studio/image`: cost is computed
 * SERVER-SIDE from the routed backend + duration, held before the paid
 * provider call, settled on sync completion, released on any failure. Async
 * jobs (MMAudio's fal.ai queue) stay reserved for `GET /api/studio/audio/
 * [jobId]` to settle.
 */
export const maxDuration = 60;

type AudioAction = "score" | "music";

const DEFAULT_AUDIO_BACKEND: Record<AudioAction, string> = {
	score: "fal-mmaudio",
	music: "elevenlabs-music",
};

const ACTION_INTENT: Record<AudioAction, SlotIntent> = {
	score: "video-score",
	music: "text-music",
};

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

export async function POST(req: Request) {
	try {
		// Paid generation — bills our provider keys, so require a signed-in user.
		const session = await auth.api.getSession({ headers: await headers() });
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const limited = await enforceRateLimit({
			name: "studio:audio",
			request: req,
			userId: session.user.id,
		});
		if (limited) return limited;

		ensureBackendsRegistered();

		const body = (await req.json()) as {
			action: AudioAction;
			prompt: string;
			videoUrl?: string;
			duration?: number;
			instrumental?: boolean;
			lyrics?: string;
			seed?: number;
			/** Manual backend pin — must declare the matching intent for `action`. */
			model?: string;
		};

		const { action, prompt, videoUrl, instrumental, lyrics, seed, model } =
			body;

		if (action !== "score" && action !== "music") {
			return NextResponse.json(
				{ error: 'action must be "score" or "music"' },
				{ status: 400 },
			);
		}
		if (!prompt?.trim()) {
			return NextResponse.json(
				{ error: "prompt is required" },
				{ status: 400 },
			);
		}

		// Reject malformed numeric/boolean/string fields BEFORE any credit-
		// reservation logic runs. A non-finite `duration` (NaN from a malformed
		// client payload) silently defeats ledger.reserve()'s insufficient-funds
		// gate — `credits < 0` and `credits > 0 && spendable < credits` are both
		// `false` when `credits` is NaN — and then crashes the integer `duration`
		// column write mid-transaction as an uncaught 500. `instrumental`/`lyrics`
		// flow straight into typed DB columns and `seed` into the provider
		// payload + provenance unchecked, so validate them here too — this is
		// deliberately NOT delegated to the downstream `clamp()` below, which
		// only handles in-range-but-out-of-bounds numbers, not non-numbers.
		if (
			body.duration !== undefined &&
			(typeof body.duration !== "number" ||
				!Number.isFinite(body.duration) ||
				body.duration <= 0)
		) {
			return NextResponse.json(
				{ error: "duration must be a finite positive number" },
				{ status: 400 },
			);
		}
		if (instrumental !== undefined && typeof instrumental !== "boolean") {
			return NextResponse.json(
				{ error: "instrumental must be a boolean" },
				{ status: 400 },
			);
		}
		if (lyrics !== undefined && typeof lyrics !== "string") {
			return NextResponse.json(
				{ error: "lyrics must be a string" },
				{ status: 400 },
			);
		}
		if (
			seed !== undefined &&
			(typeof seed !== "number" || !Number.isFinite(seed))
		) {
			return NextResponse.json(
				{ error: "seed must be a finite number" },
				{ status: 400 },
			);
		}

		const backendId = model || DEFAULT_AUDIO_BACKEND[action];
		const backend = getBackend(backendId);
		if (!backend || backend.modality !== "audio") {
			return NextResponse.json(
				{ error: `Unknown audio backend "${backendId}"` },
				{ status: 400 },
			);
		}
		if (!backend.capabilities.intents.includes(ACTION_INTENT[action])) {
			return NextResponse.json(
				{ error: `${backend.label} does not support "${action}" generation` },
				{ status: 400 },
			);
		}
		if (!backend.isAvailable()) {
			return NextResponse.json(
				{
					error: `${backend.label} is not configured — set ${backend.requiredEnv.join(
						", ",
					)}`,
				},
				{ status: 400 },
			);
		}
		if (backend.capabilities.requiresVideoRef && !videoUrl?.trim()) {
			return NextResponse.json(
				{
					error: `${backend.label} requires videoUrl (a source video to score)`,
				},
				{ status: 400 },
			);
		}

		const range = backend.capabilities.durationRangeSec ?? { min: 1, max: 600 };
		const requestedDuration = body.duration ?? (action === "score" ? 8 : 30);
		const duration = clamp(Math.round(requestedDuration), range.min, range.max);

		const request = {
			modality: "audio" as const,
			prompt,
			referenceVideos: videoUrl ? [videoUrl] : undefined,
			duration,
			instrumental,
			lyrics,
			seed,
		};

		// Credits: reserve the server-computed cost BEFORE the paid provider call.
		// The job's own id doubles as the credit-hold charge id (same trick as
		// `takes.id` in the video route), so the poll route settles/releases
		// exactly THIS job's hold.
		const jobId = nanoid();
		const creditCost = costFor(backend.id, "audio", { seconds: duration });
		try {
			await meteredReserve(session.user.id, creditCost, {
				refType: STUDIO_REF_TYPE,
				refId: jobId,
				idempotencyKey: `${jobId}:reserve`,
				metadata: { backendId: backend.id, action, seconds: duration },
			});
		} catch (err) {
			if (err instanceof InsufficientCredits) {
				return insufficientCreditsResponse(err);
			}
			throw err;
		}

		await db.insert(audioJobs).values({
			id: jobId,
			ownerId: session.user.id,
			action,
			backendId: backend.id,
			prompt,
			sourceVideoUrl: videoUrl ?? null,
			duration,
			instrumental: instrumental ?? null,
			lyrics: lyrics ?? null,
			status: "pending",
		});

		let result: Awaited<ReturnType<typeof backend.submit>>;
		try {
			result = await backend.submit(request);
			if (result.status === "failed") {
				throw new Error(result.error ?? "provider dispatch failed");
			}
		} catch (err) {
			await meteredRelease(session.user.id, creditCost, {
				refType: STUDIO_REF_TYPE,
				refId: jobId,
				idempotencyKey: `${jobId}:release`,
			}).catch(() => {});
			await db
				.update(audioJobs)
				.set({
					status: "failed",
					errorMessage: err instanceof Error ? err.message : "submit failed",
					updatedAt: new Date(),
				})
				.where(eq(audioJobs.id, jobId));
			const detail =
				err instanceof Error ? err.message : "audio generation failed";
			throw new Error(
				`Audio generation failed (${detail}). Not charged — the credit hold was released.`,
			);
		}

		// Sync backends (ElevenLabs Music) finish inline — rehost + settle now.
		let resultUrl = result.mediaUrl ?? null;
		if (result.status === "completed" && resultUrl && canRehost()) {
			try {
				const bytes = await fetchBytes(resultUrl);
				const mime = action === "score" ? "video/mp4" : "audio/mpeg";
				resultUrl = await rehostToR2(bytes, mime);
			} catch (err) {
				console.error("Failed to rehost audio job result to R2:", err);
			}
		}

		await db
			.update(audioJobs)
			.set({
				providerJobId: result.jobId,
				status: result.status,
				resultUrl,
				updatedAt: new Date(),
			})
			.where(eq(audioJobs.id, jobId));

		if (result.status === "completed" && creditCost > 0) {
			await meteredSettle(session.user.id, creditCost, {
				refType: STUDIO_REF_TYPE,
				refId: jobId,
				idempotencyKey: `${jobId}:settle`,
				metadata: { backendId: backend.id, action },
			});
		}

		const provenance: Provenance = {
			backendId: backend.id,
			vendor: backend.vendor,
			model: backendId,
			safetyTier: backend.safetyTier,
			routedBy: model ? "manual" : "auto",
			intent: ACTION_INTENT[action],
			seedLocked: seed != null && backend.capabilities.supportsSeedLock,
			generatedAt: Date.now(),
		};
		const cost: TakeCost = toTakeCost(backend.estimateCost(request), {
			estimated: false,
		});

		return NextResponse.json({
			id: jobId,
			jobId: result.jobId,
			action,
			status: result.status,
			resultUrl,
			provenance,
			cost,
		});
	} catch (err) {
		const message =
			err instanceof Error ? err.message : "Audio generation failed";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}

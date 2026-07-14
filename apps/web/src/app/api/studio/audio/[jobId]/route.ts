import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { auth } from "@/lib/auth/server";
import { ensureBackendsRegistered, getBackend } from "@/lib/studio/backends";
import { canRehost, rehostToR2, fetchBytes } from "@/lib/studio/media-storage";
import { db } from "@/lib/db";
import { audioJobs } from "@/lib/db/schema-studio";
import { enforceRateLimit } from "@/lib/rate-limit";
import { holdFor, release, settle } from "@/lib/credits/ledger";
import { STUDIO_REF_TYPE } from "@/lib/credits/metering";

/**
 * GET /api/studio/audio/[jobId] — poll an async audio job to a terminal
 * state (MMAudio's fal.ai queue). Mirrors `/api/studio/generate/[jobId]`:
 * ownership-checked via the `audio_jobs` row (owner_id is NOT NULL on this
 * table — no legacy-backfill fallback needed), settlement commits BEFORE a
 * terminal status is reported so a settle/release failure just reads as
 * "processing" and the idempotent retry lands on the client's next poll.
 *
 * Sync backends (ElevenLabs Music) are already terminal from the POST
 * response — a client that polls anyway gets the cached row back with no
 * extra provider call.
 */
export const maxDuration = 60;

export async function GET(
	req: Request,
	{ params }: { params: Promise<{ jobId: string }> },
) {
	try {
		const { jobId } = await params;

		const session = await auth.api.getSession({ headers: await headers() });
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const limited = await enforceRateLimit({
			name: "studio:audio-poll",
			request: req,
			userId: session.user.id,
		});
		if (limited) return limited;

		const job = await db.query.audioJobs.findFirst({
			where: eq(audioJobs.providerJobId, jobId),
		});
		if (!job || job.ownerId !== session.user.id) {
			return NextResponse.json({ error: "Not found" }, { status: 404 });
		}

		// Already terminal (sync backend, or a prior poll finished it) — return
		// the cached row without calling the provider again.
		if (job.status === "completed" || job.status === "failed") {
			return NextResponse.json({
				status: job.status,
				resultUrl: job.resultUrl,
				error: job.errorMessage,
			});
		}

		ensureBackendsRegistered();
		const backend = getBackend(job.backendId);
		if (!backend) {
			return NextResponse.json(
				{ error: `Unknown audio backend "${job.backendId}"` },
				{ status: 500 },
			);
		}

		const result = await backend.poll(jobId);

		if (result.status === "completed" || result.status === "failed") {
			// Credits: async settlement point, keyed by the job's own id (the same
			// id used as the reserve refId at submit time). Uses the raw ledger
			// (not the metered wrappers) — this is the async completion path, same
			// reasoning as generate/[jobId]/route.ts: a hold only exists if reserve
			// ran while enforced, so this stays correct without a flag re-check.
			const held = await holdFor(session.user.id, job.id);
			if (held != null && held > 0) {
				try {
					if (result.status === "completed") {
						await settle(session.user.id, held, {
							refType: STUDIO_REF_TYPE,
							refId: job.id,
							idempotencyKey: `${job.id}:settle`,
						});
					} else {
						await release(session.user.id, held, {
							refType: STUDIO_REF_TYPE,
							refId: job.id,
							idempotencyKey: `${job.id}:release`,
						});
					}
				} catch (err) {
					console.error(
						`Failed to ${result.status === "completed" ? "settle" : "release"} audio job credits (will retry on next poll):`,
						err,
					);
					return NextResponse.json({ status: "processing" });
				}
			}

			let resultUrl = result.mediaUrl ?? null;
			// fal.ai result URLs expire — rehost into our own R2 once, same as the
			// video poll route does for Seedance.
			if (result.status === "completed" && result.mediaUrl && canRehost()) {
				try {
					const bytes = await fetchBytes(result.mediaUrl);
					const mime = job.action === "score" ? "video/mp4" : "audio/mpeg";
					resultUrl = await rehostToR2(bytes, mime);
				} catch (err) {
					console.error("Failed to rehost audio job result to R2:", err);
				}
			}

			await db
				.update(audioJobs)
				.set({
					status: result.status,
					resultUrl,
					errorMessage: result.error ?? null,
					updatedAt: new Date(),
				})
				.where(eq(audioJobs.id, job.id));

			return NextResponse.json({
				status: result.status,
				resultUrl: resultUrl ?? result.mediaUrl,
				error: result.error,
			});
		}

		// Still in flight — persist any status transition (pending → processing)
		// without touching credits.
		if (result.status !== job.status) {
			await db
				.update(audioJobs)
				.set({ status: result.status, updatedAt: new Date() })
				.where(eq(audioJobs.id, job.id));
		}
		return NextResponse.json({ status: result.status });
	} catch (err) {
		const message = err instanceof Error ? err.message : "Poll failed";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}

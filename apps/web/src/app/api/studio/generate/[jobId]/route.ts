import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { pollVideo } from "@/lib/studio/provider-adapter";
import {
	canRehost,
	rehostToR2,
	isRehostedUrl,
	fetchBytes,
} from "@/lib/studio/media-storage";
import { db } from "@/lib/db";
import { takes, generationSets } from "@/lib/db/schema-studio";
import { headers } from "next/headers";
import { auth } from "@/lib/auth/server";
import { enforceRateLimit } from "@/lib/rate-limit";
import { holdFor, release, settle } from "@/lib/credits/ledger";
import { STUDIO_REF_TYPE } from "@/lib/credits/metering";

// A completed poll downloads the finished video and rehosts it to R2 inline.
export const maxDuration = 60;

export async function GET(
	_req: Request,
	{ params }: { params: Promise<{ jobId: string }> },
) {
	try {
		const { jobId } = await params;

		// This job's take carries provider URLs and drives paid rehosting — require
		// a signed-in user who owns the take before polling or mutating it.
		const session = await auth.api.getSession({ headers: await headers() });
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		// Polling is looped by the client, so this cap is generous — it exists to
		// bound a runaway/abusive poller, not normal polling.
		const limited = await enforceRateLimit({
			name: "studio:poll",
			request: _req,
			userId: session.user.id,
		});
		if (limited) return limited;

		const ownTake = await db.query.takes.findFirst({
			where: eq(takes.providerJobId, jobId),
		});
		if (!ownTake) {
			return NextResponse.json({ error: "Not found" }, { status: 404 });
		}
		// Prefer the take's own ownerId (denormalized tenancy column); legacy rows
		// (NULL, pre-backfill) resolve through the parent set.
		if (ownTake.ownerId) {
			if (ownTake.ownerId !== session.user.id) {
				return NextResponse.json({ error: "Not found" }, { status: 404 });
			}
		} else {
			const parentSet = await db.query.generationSets.findFirst({
				where: eq(generationSets.id, ownTake.setId),
			});
			if (!parentSet || parentSet.userId !== session.user.id) {
				return NextResponse.json({ error: "Not found" }, { status: 404 });
			}
		}

		const result = await pollVideo(jobId);

		if (result.status === "completed" || result.status === "failed") {
			// Credits: this is the async settlement point for a video job. The hold
			// was placed at submit time keyed by the TAKE id (a per-job charge id);
			// settle the EXACT reserved amount on success, release it on failure
			// (never charge for a failure). Idempotency keys derive from the hold
			// key, so a retried/duplicated poll can't double-charge or double-refund.
			// `holdFor` returns null once the hold is closed.
			//
			// Legacy fallback: holds reserved before the per-job charge id change
			// were keyed by setId. Honor them ONLY for non-promoted takes — a
			// promoted take shares its draft's set, and settling/releasing by setId
			// from a promoted job would consume the DRAFT's hold.
			let holdKey = ownTake.id;
			let held = await holdFor(session.user.id, holdKey);
			if ((held == null || held <= 0) && ownTake.status !== "promoted") {
				holdKey = ownTake.setId;
				held = await holdFor(session.user.id, holdKey);
			}
			if (held != null && held > 0) {
				// Settlement must COMMIT before we report a terminal status. If it
				// fails, tell the client the job is still processing so it polls
				// again — settle/release are idempotent, so the retry is safe. (The
				// old fire-and-forget `.catch(console.error)` reported "completed"
				// anyway: the client stopped polling, the hold leaked, and the sweep
				// later REFUNDED a successful job.)
				try {
					if (result.status === "completed") {
						await settle(session.user.id, held, {
							refType: STUDIO_REF_TYPE,
							refId: holdKey,
							idempotencyKey: `${holdKey}:settle`,
						});
					} else {
						await release(session.user.id, held, {
							refType: STUDIO_REF_TYPE,
							refId: holdKey,
							idempotencyKey: `${holdKey}:release`,
						});
					}
				} catch (err) {
					console.error(
						`Failed to ${result.status === "completed" ? "settle" : "release"} credits (will retry on next poll):`,
						err,
					);
					return NextResponse.json({ status: "processing" });
				}
			}

			let videoUrl = result.videoUrl ?? null;

			// Seedance video URLs expire ~24h. On success, copy the bytes into our
			// own R2 once and store the durable URL. Idempotent: skip if the take
			// already holds a rehosted URL. Best-effort — fall back to the provider
			// URL (still valid for ~24h) if the copy fails.
			if (result.status === "completed" && result.videoUrl && canRehost()) {
				if (ownTake.videoUrl && isRehostedUrl(ownTake.videoUrl)) {
					videoUrl = ownTake.videoUrl;
				} else {
					try {
						const bytes = await fetchBytes(result.videoUrl);
						videoUrl = await rehostToR2(bytes, "video/mp4");
					} catch (err) {
						console.error("Failed to rehost video to R2:", err);
					}
				}
			}

			// Never write seed back to null: it's pinned at submit time and the
			// completion payload omits it.
			await db
				.update(takes)
				.set({
					status: result.status === "completed" ? "kept" : "drafting",
					videoUrl,
					errorMessage: result.error ?? null,
					...(result.seed != null ? { seed: result.seed } : {}),
					updatedAt: new Date(),
				})
				.where(eq(takes.providerJobId, jobId));

			// Hand the durable URL back to the client too.
			return NextResponse.json({
				...result,
				videoUrl: videoUrl ?? result.videoUrl,
			});
		}

		return NextResponse.json(result);
	} catch (err) {
		const message = err instanceof Error ? err.message : "Poll failed";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}

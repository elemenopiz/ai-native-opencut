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
			// was placed at submit time keyed by the set id; settle the EXACT reserved
			// amount on success, release it on failure (never charge for a failure).
			// Both are keyed by setId, so a retried/duplicated poll can't double-charge
			// or double-refund. `holdFor` returns null once the hold is closed.
			const held = await holdFor(session.user.id, ownTake.setId);
			if (held != null && held > 0) {
				if (result.status === "completed") {
					await settle(session.user.id, held, {
						refType: STUDIO_REF_TYPE,
						refId: ownTake.setId,
						idempotencyKey: `${ownTake.setId}:settle`,
					}).catch((err) => console.error("Failed to settle credits:", err));
				} else {
					await release(session.user.id, held, {
						refType: STUDIO_REF_TYPE,
						refId: ownTake.setId,
						idempotencyKey: `${ownTake.setId}:release`,
					}).catch((err) => console.error("Failed to release credits:", err));
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

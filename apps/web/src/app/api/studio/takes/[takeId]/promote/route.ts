/**
 * Promote a take to 1080p using the locked seed from the original generation.
 * Re-fires the same prompt + seed at full resolution. No upscaling.
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
	generateVideo,
	type VideoOrientation,
} from "@/lib/studio/provider-adapter";
import { db } from "@/lib/db";
import { takes, generationSets } from "@/lib/db/schema-studio";
import { headers } from "next/headers";
import { auth } from "@/lib/auth/server";
import { enforceRateLimit } from "@/lib/rate-limit";
import { DEFAULT_BACKEND_ID } from "@/lib/studio/backends/registry";
import { costFor } from "@/lib/credits/cost-table";
import { InsufficientCredits } from "@/lib/credits/ledger";
import {
	insufficientCreditsResponse,
	meteredRelease,
	meteredReserve,
	meteredSettle,
	STUDIO_REF_TYPE,
} from "@/lib/credits/metering";

export const maxDuration = 60;

export async function POST(
	_req: Request,
	{ params }: { params: Promise<{ takeId: string }> },
) {
	try {
		// Promote re-fires a paid 1080p generation — require a signed-in user.
		const session = await auth.api.getSession({ headers: await headers() });
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		// Cap paid 1080p promotion per account (both burst and daily volume).
		const limited = await enforceRateLimit({
			name: "studio:promote",
			request: _req,
			userId: session.user.id,
		});
		if (limited) return limited;

		const { takeId } = await params;

		// Load the take + its parent set
		const take = await db.query.takes.findFirst({
			where: eq(takes.id, takeId),
		});
		if (!take) {
			return NextResponse.json({ error: "Take not found" }, { status: 404 });
		}

		const set = await db.query.generationSets.findFirst({
			where: eq(generationSets.id, take.setId),
		});
		if (!set) {
			return NextResponse.json(
				{ error: "Generation set not found" },
				{ status: 404 },
			);
		}
		// The take must belong to the caller — never let one user spend generation
		// credits promoting another user's take. Prefer the take's own ownerId;
		// legacy rows (NULL, pre-backfill) resolve through the parent set.
		if ((take.ownerId ?? set.userId) !== session.user.id) {
			return NextResponse.json({ error: "Take not found" }, { status: 404 });
		}

		// Credits: promotion re-fires a FULL paid 1080p generation, so it is
		// metered exactly like api/studio/generate — reserve the server-computed
		// cost BEFORE the provider call (402 if the user can't afford it), settle
		// on sync success, release on failure; async jobs stay reserved and the
		// poll route (generate/[jobId]) settles on completion. The hold is keyed
		// by the NEW take's id (a per-job charge id) — NOT the setId — so it can
		// never collide with the draft's hold in the same set.
		const newTakeId = nanoid();
		const creditCost = costFor(DEFAULT_BACKEND_ID.video, "video", {
			seconds: set.duration,
		});
		try {
			await meteredReserve(session.user.id, creditCost, {
				refType: STUDIO_REF_TYPE,
				refId: newTakeId,
				idempotencyKey: `${newTakeId}:reserve`,
				metadata: {
					backendId: DEFAULT_BACKEND_ID.video,
					seconds: set.duration,
					kind: "promote",
					setId: take.setId,
				},
			});
		} catch (err) {
			if (err instanceof InsufficientCredits) {
				return insufficientCreditsResponse(err);
			}
			throw err;
		}

		let result: Awaited<ReturnType<typeof generateVideo>>;
		try {
			// Submit a new 1080p generation with the locked seed + same orientation,
			// so the only thing that changes is the resolution. Same shot, full
			// quality.
			result = await generateVideo({
				prompt: set.prompt,
				referenceImageUrl: set.referenceImageUrl ?? undefined,
				seed: take.seed ?? undefined,
				resolution: "1080p",
				orientation: set.orientation as VideoOrientation,
				duration: set.duration,
				mode: set.mode as "text-to-video" | "image-to-video",
			});

			// Persist the promoted take in the same set (its id doubles as the
			// credit-hold charge id; ownership always stamped from the session).
			await db.insert(takes).values({
				id: newTakeId,
				setId: take.setId,
				ownerId: session.user.id,
				seed: take.seed,
				resolution: "1080p",
				providerJobId: result.jobId,
				status: "promoted",
				videoUrl: result.videoUrl ?? null,
			});

			// Sync completion — settle now. Async (pending/processing) stays
			// reserved; the poll route settles on completion.
			if (result.status === "completed" && creditCost > 0) {
				await meteredSettle(session.user.id, creditCost, {
					refType: STUDIO_REF_TYPE,
					refId: newTakeId,
					idempotencyKey: `${newTakeId}:settle`,
					metadata: { backendId: DEFAULT_BACKEND_ID.video, kind: "promote" },
				});
			}
		} catch (err) {
			// Never charge for a failed dispatch/persist — refund the hold.
			await meteredRelease(session.user.id, creditCost, {
				refType: STUDIO_REF_TYPE,
				refId: newTakeId,
				idempotencyKey: `${newTakeId}:release`,
			}).catch(() => {});
			throw err;
		}

		// Mark the source take as promoted
		await db
			.update(takes)
			.set({ status: "promoted", updatedAt: new Date() })
			.where(eq(takes.id, takeId));

		return NextResponse.json({
			takeId: newTakeId,
			jobId: result.jobId,
			status: result.status,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : "Promote failed";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}

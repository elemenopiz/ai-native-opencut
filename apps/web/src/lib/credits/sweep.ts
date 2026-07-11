/**
 * Stale-hold sweep — settle-aware reconciliation of abandoned credit holds.
 *
 * A paid generation `reserve()`s credits and the async completion path (the
 * poll route) settles or releases the hold when the job finishes. If a client
 * never polls a job to completion (closed tab, crash), its hold stays open
 * forever. This sweep finds reserve markers older than a cutoff whose hold is
 * still open and reconciles them.
 *
 * SETTLE-AWARE: a stale hold does NOT automatically mean a failed job — a
 * closed tab leaves a COMPLETED video with an open hold, and blindly releasing
 * would refund a delivered generation. Before releasing, the sweep checks the
 * job's real outcome and only releases when it is verifiably failed or
 * unverifiable past the cutoff:
 *
 *   1. The hold's take shows a delivered video (videoUrl set)      → SETTLE
 *   2. The take recorded a failure (errorMessage)                  → RELEASE
 *   3. The take has a provider job id → ask the provider:
 *        completed                                                 → SETTLE
 *        failed                                                    → RELEASE
 *        still pending/processing                                  → SKIP
 *          (never race a live job; the next sweep run gets it)
 *        poll error (job expired/unknown past the cutoff)          → RELEASE
 *   4. No take / nothing verifiable (crashed request, image charge
 *      ids, sync flows that died before settling)                  → RELEASE
 *
 * Hold keys: per-job charge ids are the TAKE id (current scheme); holds
 * reserved before that change were keyed by setId — those resolve to the
 * set's FIRST take (the draft the hold was reserved for; promote's 1080p take
 * is a later insert into the same set and must not consume the draft's hold).
 *
 * Idempotency: settles use `${refId}:settle` — the SAME key the poll route
 * uses for that hold — so sweep and poll can never double-charge each other;
 * releases use `${refId}:sweep`. `release()` additionally clamps to the
 * still-open portion of the hold under the account lock, so a settle that
 * lands between our `holdFor` read and the release cannot be double-counted.
 */

import { and, asc, eq, lt } from "drizzle-orm";
import { db } from "@/lib/db";
import { creditLedger } from "@/lib/db/schema-credits";
import { generationSets, takes } from "@/lib/db/schema-studio";
import { holdFor, release, settle } from "@/lib/credits/ledger";
import { STUDIO_REF_TYPE } from "@/lib/credits/metering";

/** The one field of a provider poll the sweep decides on. */
export interface SweepPollResult {
	status: string;
}

export interface SweepOptions {
	/** Only holds older than this many minutes are touched. */
	minutes: number;
	/**
	 * Provider poll used to verify jobs with no locally-recorded outcome.
	 * Injectable for tests; defaults to the real provider adapter.
	 */
	poll?: (jobId: string) => Promise<SweepPollResult>;
	/** Clock override for tests. */
	now?: () => Date;
}

export interface SweepStats {
	/** Reserve markers older than the cutoff that were inspected. */
	checked: number;
	/** Holds released (refunded). */
	released: number;
	/** Holds settled (charged — the job verifiably completed). */
	settled: number;
	/** Live jobs left untouched for a later run. */
	skipped: number;
	/** Credits returned to spendable via releases. */
	freed: number;
	/** Credits charged via settles. */
	charged: number;
}

/** Default poll — lazy import so tests (and non-provider envs) never load the
 *  provider adapter unless a job actually needs verification. */
async function defaultPoll(jobId: string): Promise<SweepPollResult> {
	const { pollVideo } = await import("@/lib/studio/provider-adapter");
	return pollVideo(jobId);
}

type TakeRow = typeof takes.$inferSelect;

/** Resolve the take a hold refers to: take id (per-job charge id, current
 *  scheme) first, then legacy setId holds → the set's FIRST take (the draft
 *  the hold was reserved for). Image charge ids resolve to nothing. */
async function takeForHold(refId: string): Promise<TakeRow | null> {
	const byId = await db.query.takes.findFirst({ where: eq(takes.id, refId) });
	if (byId) return byId;

	const set = await db.query.generationSets.findFirst({
		where: eq(generationSets.id, refId),
	});
	if (!set) return null;

	const [first] = await db
		.select()
		.from(takes)
		.where(eq(takes.setId, refId))
		.orderBy(asc(takes.createdAt))
		.limit(1);
	return first ?? null;
}

export async function sweepStaleHolds(opts: SweepOptions): Promise<SweepStats> {
	const poll = opts.poll ?? defaultPoll;
	const now = opts.now ?? (() => new Date());
	const cutoff = new Date(now().getTime() - opts.minutes * 60_000);

	// Candidate holds: reserve markers older than the cutoff. `holdFor` then
	// tells us which are still open (no matching settle/release).
	const markers = await db
		.select({ userId: creditLedger.userId, refId: creditLedger.refId })
		.from(creditLedger)
		.where(
			and(
				eq(creditLedger.reason, "reserve"),
				lt(creditLedger.createdAt, cutoff),
			),
		);

	const stats: SweepStats = {
		checked: markers.length,
		released: 0,
		settled: 0,
		skipped: 0,
		freed: 0,
		charged: 0,
	};

	for (const m of markers) {
		if (!m.refId) continue;
		const hold = await holdFor(m.userId, m.refId);
		if (hold == null || hold <= 0) continue; // already settled/released

		const take = await takeForHold(m.refId);

		// Decide the job's outcome: settle | release | skip.
		let outcome: "settle" | "release" | "skip";
		if (take?.videoUrl) {
			// Delivered video on record — the user got the result; charge the hold.
			outcome = "settle";
		} else if (take?.errorMessage) {
			outcome = "release";
		} else if (take?.providerJobId) {
			try {
				const polled = await poll(take.providerJobId);
				if (polled.status === "completed") {
					outcome = "settle";
				} else if (polled.status === "failed") {
					outcome = "release";
				} else {
					// Provider says the job is still live — never race it. A later
					// run reconciles once it reaches a terminal state.
					outcome = "skip";
				}
			} catch {
				// Job unknown/expired past the cutoff — unverifiable, refund.
				outcome = "release";
			}
		} else {
			// Nothing verifiable was delivered (crashed request, image charge id,
			// sync flow that died before settling) — refund.
			outcome = "release";
		}

		if (outcome === "skip") {
			stats.skipped += 1;
			continue;
		}

		if (outcome === "settle") {
			// Same idempotency key as the poll route's settle for this hold — the
			// two paths can never double-charge.
			await settle(m.userId, hold, {
				refType: STUDIO_REF_TYPE,
				refId: m.refId,
				idempotencyKey: `${m.refId}:settle`,
				metadata: { via: "sweep" },
			});
			stats.settled += 1;
			stats.charged += hold;
		} else {
			await release(m.userId, hold, {
				refType: STUDIO_REF_TYPE,
				refId: m.refId,
				idempotencyKey: `${m.refId}:sweep`,
			});
			stats.released += 1;
			stats.freed += hold;
		}
	}

	return stats;
}

/**
 * Ops CLI: release stale credit holds left by abandoned generations.
 *
 *   bun run credits:sweep [-- <minutes>]     # default 120
 *   # or: bun scripts/sweep-stale-holds.ts <minutes>
 *
 * A paid generation `reserve()`s credits into `credit_accounts.reserved` and the
 * async video-completion route settles or releases that hold when the job finishes.
 * If a client never polls a job to completion, its hold stays in `reserved`
 * forever — spendable is reduced but the user is never charged (safe direction).
 * This sweep finds reserve markers older than <minutes> whose hold is still open
 * (no settle/release) and releases them, returning the credits to spendable.
 *
 * SAFETY: use a cutoff comfortably longer than the slowest provider job (video is
 * seconds–minutes), so a marker this old is genuinely abandoned. A too-short cutoff
 * could race a still-running job — its later settle would then charge balance for a
 * hold this sweep already freed. The default (120 min) is far beyond any real job.
 * Release is idempotent (`${refId}:sweep`), so re-runs are safe.
 *
 * Reads DATABASE_URL from apps/web/.env.local (loaded automatically by bun).
 */

import { and, eq, lt } from "drizzle-orm";
import { db } from "@/lib/db";
import { creditLedger } from "@/lib/db/schema-credits";
import { holdFor, release } from "@/lib/credits/ledger";
import { STUDIO_REF_TYPE } from "@/lib/credits/metering";

async function main() {
	const minutes = Number(process.argv[2] ?? "120");
	if (!Number.isFinite(minutes) || minutes <= 0) {
		console.error(
			`Invalid minutes "${process.argv[2]}" — must be a positive number.`,
		);
		process.exit(1);
	}

	const cutoff = new Date(Date.now() - minutes * 60_000);

	// Candidate holds: reserve markers older than the cutoff. `holdFor` then tells
	// us which are still open (no matching settle/release).
	const markers = await db
		.select({ userId: creditLedger.userId, refId: creditLedger.refId })
		.from(creditLedger)
		.where(
			and(
				eq(creditLedger.reason, "reserve"),
				lt(creditLedger.createdAt, cutoff),
			),
		);

	let released = 0;
	let freed = 0;
	for (const m of markers) {
		if (!m.refId) continue;
		const hold = await holdFor(m.userId, m.refId);
		if (hold == null || hold <= 0) continue; // already settled/released
		await release(m.userId, hold, {
			refType: STUDIO_REF_TYPE,
			refId: m.refId,
			idempotencyKey: `${m.refId}:sweep`,
		});
		released += 1;
		freed += hold;
	}

	console.log(
		`Checked ${markers.length} reserve marker(s) older than ${minutes}m; ` +
			`released ${released} stale hold(s), freeing ${freed} credit(s).`,
	);
	process.exit(0);
}

main().catch((err) => {
	console.error("Sweep failed:", err);
	process.exit(1);
});

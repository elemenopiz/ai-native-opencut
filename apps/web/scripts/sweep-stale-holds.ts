/**
 * Ops CLI: reconcile stale credit holds left by abandoned generations.
 *
 *   bun run credits:sweep [-- <minutes>]     # default 120
 *   # or: bun scripts/sweep-stale-holds.ts <minutes>
 *
 * Thin wrapper around `@/lib/credits/sweep` (see its header for the full
 * decision table). The sweep is SETTLE-AWARE: a stale hold whose job verifiably
 * COMPLETED (delivered video on record, or the provider reports completed) is
 * SETTLED — charged — not refunded; only verifiably failed or unverifiable
 * holds are released, and still-live jobs are skipped for a later run.
 *
 * SAFETY: use a cutoff comfortably longer than the slowest provider job (video
 * is seconds–minutes). Both paths are idempotent (settle `${refId}:settle`,
 * release `${refId}:sweep`) and `release()` clamps to the still-open hold under
 * the account lock, so re-runs and races with the poll route are safe.
 *
 * Reads DATABASE_URL from apps/web/.env.local (loaded automatically by bun).
 */

import { sweepStaleHolds } from "@/lib/credits/sweep";

async function main() {
	const minutes = Number(process.argv[2] ?? "120");
	if (!Number.isFinite(minutes) || minutes <= 0) {
		console.error(
			`Invalid minutes "${process.argv[2]}" — must be a positive number.`,
		);
		process.exit(1);
	}

	const stats = await sweepStaleHolds({ minutes });

	console.log(
		`Checked ${stats.checked} reserve marker(s) older than ${minutes}m; ` +
			`settled ${stats.settled} completed hold(s) (charging ${stats.charged} credit(s)), ` +
			`released ${stats.released} stale hold(s) (freeing ${stats.freed} credit(s)), ` +
			`skipped ${stats.skipped} still-live job(s).`,
	);
	process.exit(0);
}

main().catch((err) => {
	console.error("Sweep failed:", err);
	process.exit(1);
});

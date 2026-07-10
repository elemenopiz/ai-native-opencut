/**
 * Ops CLI: grant credits to a user (soft launch, no payments yet).
 *
 *   bun run credits:grant -- <userId> <amount> [note]
 *   # or: bun scripts/grant-credits.ts <userId> <amount> [note]
 *
 * Grants are idempotent per (userId, amount, note) via a derived key, so an
 * accidental re-run won't double-grant — vary the note to grant again on purpose.
 * Reads DATABASE_URL from apps/web/.env.local (loaded automatically by bun).
 */

import { grant, getAccount } from "@/lib/credits/ledger";

async function main() {
	const [userId, amountRaw, ...noteParts] = process.argv.slice(2);
	const note = noteParts.join(" ").trim() || undefined;

	if (!userId || !amountRaw) {
		console.error("Usage: bun run credits:grant -- <userId> <amount> [note]");
		process.exit(1);
	}

	const amount = Number(amountRaw);
	if (!Number.isInteger(amount) || amount <= 0) {
		console.error(
			`Invalid amount "${amountRaw}" — must be a positive integer.`,
		);
		process.exit(1);
	}

	const before = await getAccount(userId);
	const account = await grant(userId, amount, {
		reason: "cli_grant",
		refType: "cli",
		refId: userId,
		note,
		// Distinct per invocation-content so repeated intentional grants (different
		// note) apply, but an identical accidental re-run is a no-op.
		idempotencyKey: `cli_grant:${userId}:${amount}:${note ?? ""}`,
	});

	console.log(
		`Granted ${amount} credits to ${userId}.\n` +
			`  balance:  ${before.balance} -> ${account.balance}\n` +
			`  spendable: ${before.spendable} -> ${account.spendable}`,
	);
	process.exit(0);
}

main().catch((err) => {
	console.error("Grant failed:", err);
	process.exit(1);
});

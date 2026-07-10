import {
	pgTable,
	text,
	timestamp,
	integer,
	jsonb,
	index,
} from "drizzle-orm/pg-core";
import { users } from "./schema";

// ─── Credits ────────────────────────────────────────────────────────────────
// Metered per-action credit system. 1 credit = US$0.01 of real provider cost.
// This is MONEY-ADJACENT: correctness (concurrency, idempotency, never-charge-
// for-failure) is the whole point.
//
// Two tables:
//   `credit_ledger`   — append-only source of truth. Every grant/debit is a row.
//   `credit_accounts` — the hot-path balance, derived from (and kept in step
//                       with) the ledger inside the same transaction as each
//                       write. Spendable = balance - reserved.
//
// A charge is a two-phase hold: `reserve` moves credits into `reserved` (no
// ledger row — nothing is spent yet), then either `settle` (balance -= credits,
// reserved -= credits, append a debit row) on provider success, or `release`
// (reserved -= credits, NO ledger row) on failure. We never charge for a failed
// generation.

// ─── credit_ledger ────────────────────────────────────────────────────────────
// Append-only. Positive `delta` = grant (credit), negative = debit (settle).
// `idempotency_key` is UNIQUE so a retried callback can't double-post the same
// economic event. `balance_after` snapshots the account balance right after this
// row was applied, for auditability.

export const creditLedger = pgTable(
	"credit_ledger",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		// Signed change in credits: +grant, -debit.
		delta: integer("delta").notNull(),
		// Account balance immediately after applying this row (audit trail).
		balanceAfter: integer("balance_after").notNull(),
		// Human/machine reason, e.g. "settle", "grant", "admin_grant".
		reason: text("reason").notNull(),
		// What this entry references, e.g. "studio_job", "admin".
		refType: text("ref_type"),
		refId: text("ref_id"),
		// Dedupe key for the economic event (jobId+':settle', etc.). UNIQUE — a
		// second write with the same key is a no-op (idempotent settle/grant).
		idempotencyKey: text("idempotency_key").unique(),
		metadata: jsonb("metadata"),
		createdAt: timestamp("created_at")
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(t) => [
		index("credit_ledger_user_id_idx").on(t.userId),
		index("credit_ledger_ref_idx").on(t.refType, t.refId),
	],
);

// ─── credit_accounts ──────────────────────────────────────────────────────────
// One row per user, the hot path. `balance` is total owned credits; `reserved`
// is credits held by in-flight generations. Spendable = balance - reserved. Both
// are guarded ≥ 0 by the ledger service (and NOT NULL here).

export const creditAccounts = pgTable("credit_accounts", {
	userId: text("user_id")
		.primaryKey()
		.references(() => users.id, { onDelete: "cascade" }),
	balance: integer("balance").notNull().default(0),
	reserved: integer("reserved").notNull().default(0),
	updatedAt: timestamp("updated_at")
		.$defaultFn(() => new Date())
		.notNull(),
});

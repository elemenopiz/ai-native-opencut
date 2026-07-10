-- Credits: metered per-action credit system. 1 credit = US$0.01 of real provider
-- cost. MONEY-ADJACENT — correctness (concurrency, idempotency, never-charge-for-
-- failure) matters more than speed.
--
--   credit_ledger   — append-only source of truth (one row per grant/debit).
--   credit_accounts — hot-path balance; spendable = balance - reserved.
--
-- A charge is a two-phase hold: reserve (reserved += credits, no ledger row) then
-- settle (balance -= credits, reserved -= credits, append debit row) on success,
-- or release (reserved -= credits, no ledger row) on failure. idempotency_key is
-- UNIQUE so a retried callback can't double-post the same economic event.
-- Run after 0005_mcp_tokens.sql

CREATE TABLE IF NOT EXISTS "credit_ledger" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "delta" integer NOT NULL,
  "balance_after" integer NOT NULL,
  "reason" text NOT NULL,
  "ref_type" text,
  "ref_id" text,
  "idempotency_key" text UNIQUE,
  "metadata" jsonb,
  "created_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "credit_ledger_user_id_idx" ON "credit_ledger" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_ledger_ref_idx" ON "credit_ledger" ("ref_type", "ref_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "credit_accounts" (
  "user_id" text PRIMARY KEY NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "balance" integer NOT NULL DEFAULT 0,
  "reserved" integer NOT NULL DEFAULT 0,
  "updated_at" timestamp NOT NULL DEFAULT now()
);

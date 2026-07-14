-- MCP usage telemetry: per-event log for token issuance, session
-- establishment, and per-verb tool-call counts (PROD-READINESS follow-up:
-- the MCP server had zero telemetry — "how many users connected MCP" and
-- "which verbs get called" were both unanswerable). Written fire-and-forget
-- from src/lib/mcp/telemetry.ts; never blocks or fails a tool call.
--
-- userId nullable + ON DELETE SET NULL (mirrors 0009's actor-FK pattern) so a
-- user deleting their account doesn't FK-block; the event row survives for
-- aggregate counts with userId cleared. projectId is the opaque client-side
-- project id (no server-side projects table, same convention as
-- mcp_tokens.project_id) — not an FK.
CREATE TABLE IF NOT EXISTS "mcp_events" (
	"id" text PRIMARY KEY NOT NULL,
	"ts" timestamp NOT NULL,
	"user_id" text,
	"project_id" text,
	"event" text NOT NULL,
	"verb" text,
	"meta" jsonb,
	CONSTRAINT "mcp_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_events_user_id_idx" ON "mcp_events" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_events_event_idx" ON "mcp_events" ("event");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_events_ts_idx" ON "mcp_events" ("ts");

-- Revert (down migration) — drizzle-kit has no native down files:
--
--   DROP TABLE IF EXISTS "mcp_events";

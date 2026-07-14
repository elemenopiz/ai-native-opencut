import { pgTable, text, timestamp, index, jsonb } from "drizzle-orm/pg-core";
import { users } from "./schema";

// ─── MCP Tokens ───────────────────────────────────────────────────────────────
// Per-project scoped bearer tokens for the external MCP server. This is a web
// app (no loopback/127.0.0.1 trust model), so every MCP call authenticates with
// one of these tokens instead of an ambient local session.
//
// `projectId` is the OPAQUE client-side project id (there is no server-side
// projects table); a token grants a specific user access to a specific project's
// reel at a specific scope set. Only the token HASH is stored — the raw token is
// shown to the issuer exactly once and never persisted.

export const mcpTokens = pgTable(
	"mcp_tokens",
	{
		id: text("id").primaryKey(),
		// SHA-256 hash (hex) of the raw bearer token — never the token itself.
		token: text("token").notNull().unique(),
		// Opaque client project id (editor.project.getActive().metadata.id).
		projectId: text("project_id").notNull(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		// CSV of granted scopes, e.g. "reel:read,reel:write".
		scopes: text("scopes").notNull().default("reel:read,reel:write"),
		// Optional human label shown in the token list UI.
		label: text("label"),
		createdAt: timestamp("created_at")
			.$defaultFn(() => new Date())
			.notNull(),
		lastUsedAt: timestamp("last_used_at"),
		// Non-null once revoked; a revoked token never verifies.
		revokedAt: timestamp("revoked_at"),
	},
	(t) => [
		index("mcp_tokens_user_id_idx").on(t.userId),
		index("mcp_tokens_project_id_idx").on(t.projectId),
	],
);

// ─── MCP Events ─────────────────────────────────────────────────────────────
// Lightweight usage telemetry for the external MCP server — see
// `src/lib/mcp/telemetry.ts` for the fire-and-forget writer. One row per
// event: token issuance, session establishment, and per-verb `tools/call`
// (including calls blocked by scope or rate limit, so abuse is visible too).
//
// `userId` is nullable + ON DELETE SET NULL (mirrors the actor-FK pattern in
// migration 0009) so account deletion never FK-blocks on a telemetry row; the
// event survives for aggregate counts with `userId` cleared. `projectId` is
// the same opaque client-side id as `mcp_tokens.project_id` — not an FK,
// there is no server-side projects table.

export const mcpEvents = pgTable(
	"mcp_events",
	{
		id: text("id").primaryKey(),
		ts: timestamp("ts")
			.$defaultFn(() => new Date())
			.notNull(),
		userId: text("user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		projectId: text("project_id"),
		// "token_created" | "session_initialized" | "tool_call" — see McpEventName.
		event: text("event").notNull(),
		// Director verb name; populated for "tool_call" events only.
		verb: text("verb"),
		meta: jsonb("meta"),
	},
	(t) => [
		index("mcp_events_user_id_idx").on(t.userId),
		index("mcp_events_event_idx").on(t.event),
		index("mcp_events_ts_idx").on(t.ts),
	],
);

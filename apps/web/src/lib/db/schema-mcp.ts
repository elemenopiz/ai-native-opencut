import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
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

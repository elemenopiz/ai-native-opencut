-- MCP tokens: per-project scoped bearer tokens for the external MCP server.
-- This is a web app (no loopback trust), so each MCP call authenticates with one
-- of these tokens. Only the token HASH is stored ("token" column); the raw token
-- is shown to the issuer exactly once. projectId is the opaque client-side project
-- id (there is no server-side projects table); userId owns the token.
-- Run after 0004_personas.sql

CREATE TABLE IF NOT EXISTS "mcp_tokens" (
  "id" text PRIMARY KEY NOT NULL,
  "token" text NOT NULL UNIQUE,
  "project_id" text NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "scopes" text NOT NULL DEFAULT 'reel:read,reel:write',
  "label" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "last_used_at" timestamp,
  "revoked_at" timestamp
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "mcp_tokens_user_id_idx" ON "mcp_tokens" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_tokens_project_id_idx" ON "mcp_tokens" ("project_id");

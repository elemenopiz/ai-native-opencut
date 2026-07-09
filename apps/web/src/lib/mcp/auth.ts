/**
 * Server-side auth for the external MCP server.
 *
 * The MCP transport (Fable) imports {@link verifyProjectToken} to authenticate
 * every request, and {@link scopeForTool} (re-exported from the shared tool
 * catalog) to enforce per-tool scope. This is a web app, so there is NO loopback
 * trust — each call must carry a per-project scoped bearer token issued via
 * `POST /api/mcp/tokens`.
 *
 * Only token HASHES are stored (see `schema-mcp.ts`); this module hashes the
 * presented token and compares. It never logs or returns the raw token.
 */

import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { mcpTokens } from "@/lib/db/schema-mcp";

/** All scopes a token may carry (const tuple so `z.enum(MCP_SCOPES)` type-checks). */
export const MCP_SCOPES = ["reel:read", "reel:write"] as const;

export type McpScope = (typeof MCP_SCOPES)[number];

// Re-export so Fable has a single import site for both verification and scoping.
export { scopeForTool } from "@/lib/director/tool-catalog";

/** SHA-256 (hex) of a raw token — the value stored in `mcp_tokens.token`. */
export function hashToken(rawToken: string): string {
	return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

/** Strip an optional `Bearer ` prefix and surrounding whitespace. */
function normalizeToken(rawToken: string): string {
	return rawToken.replace(/^Bearer\s+/i, "").trim();
}

/** Parse the stored CSV scopes into a validated {@link McpScope} list. */
export function parseScopes(csv: string | null | undefined): McpScope[] {
	if (!csv) return [];
	return csv
		.split(",")
		.map((s) => s.trim())
		.filter((s): s is McpScope => (MCP_SCOPES as readonly string[]).includes(s));
}

/** Result of a successful token verification. */
export interface VerifiedToken {
	userId: string;
	projectId: string;
	scopes: McpScope[];
}

/**
 * Verify an MCP bearer token. Accepts a bare token or one with a `Bearer `
 * prefix. Hashes it, looks up the (non-revoked) row, bumps `lastUsedAt`, and
 * returns the owning user, project, and granted scopes — or `null` if the token
 * is empty, unknown, or revoked. Fable should treat `null` as 401.
 */
export async function verifyProjectToken(
	rawToken: string,
): Promise<VerifiedToken | null> {
	const token = normalizeToken(rawToken ?? "");
	if (!token) return null;

	const hash = hashToken(token);
	const rows = await db
		.select()
		.from(mcpTokens)
		.where(eq(mcpTokens.token, hash))
		.limit(1);

	const row = rows[0];
	if (!row) return null;
	if (row.revokedAt) return null;

	// Best-effort last-used bump; never blocks the request on a write failure.
	try {
		await db
			.update(mcpTokens)
			.set({ lastUsedAt: new Date() })
			.where(eq(mcpTokens.id, row.id));
	} catch {
		/* non-fatal: verification still succeeds */
	}

	return {
		userId: row.userId,
		projectId: row.projectId,
		scopes: parseScopes(row.scopes),
	};
}

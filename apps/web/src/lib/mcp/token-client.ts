/**
 * Typed client for the MCP token API.
 *
 * ASSUMPTION (backend not yet implemented in this worktree — Opus's slice):
 * these routes don't exist yet, so calls here will 404 at runtime until they
 * land. The shapes below are inferred from the Sprint 2 contract:
 *
 *   POST   /api/mcp/tokens            body: { projectId, label?, scopes? }
 *                                      -> { token: "<raw, shown once>", id, ... }
 *   GET    /api/mcp/tokens?projectId=  -> { tokens: McpTokenSummary[] }  (no raw token)
 *   DELETE /api/mcp/tokens/:id         -> { ok: true }
 *
 * Unverified specifics (flagged, best-guess pending Opus's actual route):
 *  - GET is assumed to take `projectId` as a query param (not stated in the
 *    contract) since tokens are scoped per-project and there's no path segment
 *    for it.
 *  - The exact field names on McpTokenSummary (label, scopes, createdAt,
 *    lastUsedAt) are inferred from the POST body fields, not confirmed against
 *    a real response.
 *  - DELETE is called as `/api/mcp/tokens/:id` (REST path form) — the contract
 *    also allows `?id=`, but the path form is used here as primary.
 *  - Auth is assumed to ride on the existing better-auth session cookie via
 *    same-origin `fetch` (no explicit Authorization header needed for these
 *    management calls — only the MCP endpoint itself uses the bearer token).
 *
 * All failures surface as `McpTokenApiError` so a missing/unimplemented route
 * is a runtime error the UI can display, not a compile-time dependency.
 */

export interface McpTokenSummary {
	id: string;
	projectId: string;
	label: string | null;
	scopes: string[] | null;
	createdAt: string;
	lastUsedAt?: string | null;
}

export interface McpTokenCreateResult extends McpTokenSummary {
	/** Raw bearer token — the API only returns this once, on creation. */
	token: string;
}

export interface CreateMcpTokenInput {
	projectId: string;
	label?: string;
	scopes?: string[];
}

export class McpTokenApiError extends Error {
	readonly status?: number;

	constructor(message: string, status?: number) {
		super(message);
		this.name = "McpTokenApiError";
		this.status = status;
	}
}

async function parseJsonOrThrow(res: Response): Promise<unknown> {
	let body: unknown = null;
	try {
		body = await res.json();
	} catch {
		// non-JSON body (e.g. a 404 HTML page from a not-yet-implemented route)
	}

	if (!res.ok) {
		const message =
			(body && typeof body === "object" && "error" in body && typeof (body as { error?: unknown }).error === "string"
				? (body as { error: string }).error
				: null) ??
			(res.status === 404
				? "MCP token API is not available yet (404) — the backend route hasn't shipped."
				: `MCP token API request failed (${res.status})`);
		throw new McpTokenApiError(message, res.status);
	}

	return body;
}

export async function listMcpTokens(projectId: string): Promise<McpTokenSummary[]> {
	const res = await fetch(`/api/mcp/tokens?projectId=${encodeURIComponent(projectId)}`, {
		method: "GET",
	});
	const body = await parseJsonOrThrow(res);
	if (body && typeof body === "object" && Array.isArray((body as { tokens?: unknown }).tokens)) {
		return (body as { tokens: McpTokenSummary[] }).tokens;
	}
	if (Array.isArray(body)) {
		return body as McpTokenSummary[];
	}
	return [];
}

export async function createMcpToken(
	input: CreateMcpTokenInput,
): Promise<McpTokenCreateResult> {
	const res = await fetch("/api/mcp/tokens", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const body = await parseJsonOrThrow(res);
	return body as McpTokenCreateResult;
}

export async function revokeMcpToken(id: string): Promise<void> {
	const res = await fetch(`/api/mcp/tokens/${encodeURIComponent(id)}`, {
		method: "DELETE",
	});
	await parseJsonOrThrow(res);
}

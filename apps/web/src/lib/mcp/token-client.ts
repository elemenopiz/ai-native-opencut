/**
 * Typed client for the MCP token API (`app/api/mcp/tokens/route.ts`).
 * Reconciled at integration against the shipped route:
 *
 *   POST   /api/mcp/tokens             body: { projectId, label?, scopes? }
 *                                       -> 201 { id, token: "<raw, once>", projectId, scopes, label, createdAt }
 *   GET    /api/mcp/tokens?projectId=   -> McpTokenSummary[]  (bare array, no hash/raw)
 *   DELETE /api/mcp/tokens?id=          -> { id, revoked: true }
 *
 * Auth rides the existing better-auth session cookie via same-origin `fetch`
 * (the route calls `auth.api.getSession`); only the MCP endpoint itself uses the
 * per-project bearer token. All failures surface as `McpTokenApiError`.
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
	const res = await fetch(`/api/mcp/tokens?id=${encodeURIComponent(id)}`, {
		method: "DELETE",
	});
	await parseJsonOrThrow(res);
}

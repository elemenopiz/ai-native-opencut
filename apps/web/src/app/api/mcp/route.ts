/**
 * `/api/mcp` — the Byorn MCP endpoint (Streamable HTTP transport).
 *
 * External agents (Claude Code, Cursor, Codex, …) speak the MCP Streamable
 * HTTP protocol here, via the official SDK's
 * `WebStandardStreamableHTTPServerTransport` (fetch-native — no node req/res
 * adapter needed in the App Router):
 *  - POST  — JSON-RPC messages (initialize, tools/list, tools/call, …).
 *            Responses stream back as SSE by default (the transport's
 *            built-in SSE mode doubles as the streaming fallback for
 *            clients that expect event streams).
 *  - GET   — standalone SSE stream for server-initiated messages.
 *  - DELETE— explicit session termination.
 *
 * SESSIONS: stateful. `initialize` (no `Mcp-Session-Id` header) creates a
 * `{ Server, transport }` pair; the transport issues the session id, which the
 * store pins to the token's `{ userId, projectId }`. All later requests must
 * carry the header; idle timeout + LRU cap eviction live in
 * `mcp-session-store.ts`. Evicted ids 404, telling the client to re-init.
 *
 * AUTH: EVERY request (including initialize and DELETE) must present
 * `Authorization: Bearer <project token>`; `verifyProjectToken` (Opus's
 * frozen interface) resolves it to `{ userId, projectId, scopes }` or null →
 * 401. A valid token for the WRONG user/project against an existing session →
 * 403. Per-tool scope enforcement happens in `build-mcp-server.ts` via
 * `scopeForTool`, fed by the `authInfo` attached here per request.
 *
 * EXECUTION: tools are never run here — see `editor-bridge.ts` for how calls
 * reach the live editor tab.
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { verifyProjectToken } from "@/lib/mcp/auth";
import { createByornMcpServer } from "@/lib/mcp/build-mcp-server";
import { getMcpSessionStore } from "@/lib/mcp/mcp-session-store";
import { RATE_LIMITS, getRateLimiter } from "@/lib/rate-limit";
import { recordMcpEvent } from "@/lib/mcp/telemetry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** JSON-RPC-shaped HTTP error (spec-friendly body for non-2xx transport errors). */
function rpcError(status: number, code: number, message: string): Response {
	return Response.json(
		{ jsonrpc: "2.0", error: { code, message }, id: null },
		{ status },
	);
}

interface Grant {
	userId: string;
	projectId: string;
	scopes: string[];
}

function toAuthInfo(token: string, grant: Grant): AuthInfo {
	return {
		token,
		clientId: grant.userId,
		scopes: grant.scopes,
		extra: { userId: grant.userId, projectId: grant.projectId },
	};
}

async function handleMcpRequest(req: Request): Promise<Response> {
	// ---- auth gate (every request, no exceptions) -------------------------
	const authorization = req.headers.get("authorization");
	const token = authorization?.startsWith("Bearer ")
		? authorization.slice("Bearer ".length).trim()
		: null;
	if (!token) {
		return rpcError(401, -32001, "Missing Authorization: Bearer <token>.");
	}
	const grant = await verifyProjectToken(token);
	if (!grant) {
		return rpcError(401, -32001, "Invalid or expired token.");
	}
	const authInfo = toAuthInfo(token, grant);

	// ---- transport-level rate limit (blanket safety net, not verb-aware) --
	// Covers every JSON-RPC method plus the GET SSE stream and DELETE — the
	// verb-aware read/write caps that matter for cost/DB load are enforced
	// per `tools/call` in build-mcp-server.ts, where the tool name is known.
	// A bare 429 is the acceptable fallback here (no MCP session/tool-call
	// context exists yet to shape a protocol-level tool error into).
	const transportLimit = await getRateLimiter().check(
		RATE_LIMITS["mcp:transport"],
		"mcp:transport",
		`user:${grant.userId}`,
	);
	if (transportLimit.limited) {
		return rpcError(
			429,
			-32000,
			"Rate limit exceeded. Please slow down and try again shortly.",
		);
	}

	const store = getMcpSessionStore();
	const sessionId = req.headers.get("mcp-session-id");

	// ---- existing session --------------------------------------------------
	if (sessionId) {
		const session = store.touch(sessionId);
		if (!session) {
			// Unknown/evicted (idle or LRU) → 404 so the client re-initializes.
			return rpcError(
				404,
				-32001,
				"Session not found or expired — send a new initialize request.",
			);
		}
		if (
			session.userId !== grant.userId ||
			session.projectId !== grant.projectId
		) {
			return rpcError(
				403,
				-32003,
				"This session belongs to a different user/project than the presented token.",
			);
		}
		return session.transport.handleRequest(req, { authInfo });
	}

	// ---- no session header: only a POSTed initialize may mint one ----------
	if (req.method !== "POST") {
		return rpcError(400, -32000, "Mcp-Session-Id header is required.");
	}
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return rpcError(400, -32700, "Parse error: body must be JSON.");
	}
	if (!isInitializeRequest(body)) {
		return rpcError(
			400,
			-32000,
			"Expected an initialize request when no Mcp-Session-Id is present.",
		);
	}

	const server = createByornMcpServer({
		userId: grant.userId,
		projectId: grant.projectId,
	});
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: () => crypto.randomUUID(),
		onsessioninitialized: (sid) => {
			const now = Date.now();
			store.set({
				id: sid,
				server,
				transport,
				userId: grant.userId,
				projectId: grant.projectId,
				createdAt: now,
				lastSeenAt: now,
			});
			recordMcpEvent({
				userId: grant.userId,
				projectId: grant.projectId,
				event: "session_initialized",
				source: "mcp",
			});
		},
		// Client sent DELETE → transport closed the session itself; just forget it.
		onsessionclosed: (sid) => store.delete(sid),
	});
	await server.connect(transport);
	return transport.handleRequest(req, { parsedBody: body, authInfo });
}

export {
	handleMcpRequest as GET,
	handleMcpRequest as POST,
	handleMcpRequest as DELETE,
};

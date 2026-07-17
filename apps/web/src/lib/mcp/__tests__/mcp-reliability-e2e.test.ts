/**
 * MCP reliability hardening — campaign/mcp-moat definition-of-done evidence.
 *
 * Two things this file proves that the other three MCP test files don't:
 *
 *  1. THE DOUBLE EDIT LOOP: an external agent can run a full
 *     connect→list→read→mutate×N→export→disconnect cycle, then do it again on
 *     a BRAND NEW connection, against the SAME server-side state (session
 *     store + editor bridge), with no manual reset in between. This is the
 *     actual shape of a real external-agent session (Claude Code, Cursor, …
 *     reconnecting after an idle gap) — a single happy-path smoke test can't
 *     show the loop survives itself.
 *  2. TOKEN-AUTH EDGES not already covered elsewhere (see SKIPPED below).
 *
 * Same in-process harness as `mcp-e2e-smoke.test.ts` /
 * `mcp-project-binding.test.ts` / `mcp-rate-limit.test.ts`: a real
 * `@modelcontextprotocol/sdk` `Client` talks to the shipped `/api/mcp` route
 * through a `routeFetch` that hands requests straight to the exported route
 * handlers (no sockets), `@/lib/mcp/auth` is mocked (DB-free — a `GRANTS` map
 * plus a `revokedTokens` set so a test can flip a token to "revoked" mid-run),
 * and a real {@link getEditorBridge} is used with fake executor tabs standing
 * in for the browser `EditorCore`.
 *
 * SKIPPED (already covered elsewhere, not duplicated here per the campaign
 * brief):
 *  - invalid/expired token at initialize → connect rejects (401) —
 *    `mcp-e2e-smoke.test.ts`: "rejects a missing/invalid bearer token at
 *    initialize".
 *  - per-tool scope gate, project-binding refusal shapes, and read/write
 *    rate-limit bucket math — `mcp-project-binding.test.ts` /
 *    `mcp-rate-limit.test.ts`.
 *
 * ISOLATION: every scenario below uses its own unique userId/projectId/token
 * triple (never reused across describe blocks) so the `mcp:read`/`mcp:write`/
 * `mcp:transport` rate-limit buckets and the editor-bridge's one-tab-per-
 * project registry can't bleed across tests in this file, or collide with the
 * other three MCP test files sharing this same bun test process.
 */

import { afterAll, describe, expect, mock, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { scopeForTool, toolCatalog } from "@/lib/director/tool-catalog";

interface Grant {
	userId: string;
	projectId: string;
	scopes: string[];
}

/** token → grant. Tests add entries before connecting; never removed. */
const GRANTS: Record<string, Grant> = {};
/** Tokens a test has "revoked" — verified as if the DB row's revokedAt was set. */
const revokedTokens = new Set<string>();

// Mock ONLY the DB-backed token verification; keep the real scope logic so
// the scope gate in build-mcp-server is genuinely exercised. Registered
// before the route module is imported (below) so the route binds this mock.
mock.module("@/lib/mcp/auth", () => ({
	MCP_SCOPES: ["reel:read", "reel:write"] as const,
	scopeForTool,
	verifyProjectToken: async (raw: string) => {
		const token = (raw ?? "").replace(/^Bearer\s+/i, "").trim();
		if (!token || revokedTokens.has(token)) return null;
		const grant = GRANTS[token];
		if (!grant) return null;
		return {
			userId: grant.userId,
			projectId: grant.projectId,
			scopes: grant.scopes,
		};
	},
}));

// Import AFTER the mock is registered so the route wires the stubbed auth.
const route = (await import("@/app/api/mcp/route")) as {
	GET: (req: Request) => Promise<Response>;
	POST: (req: Request) => Promise<Response>;
	DELETE: (req: Request) => Promise<Response>;
};
const { getEditorBridge } = await import("@/lib/mcp/editor-bridge");

const MCP_URL = "http://mcp.reliability.local/api/mcp";

/** Route the SDK client's fetch straight to the in-process handler. */
const routeFetch = (async (input: string | URL, init?: RequestInit) => {
	const url = typeof input === "string" ? input : input.toString();
	const request = new Request(url, init);
	const method = request.method.toUpperCase();
	if (method === "GET") return route.GET(request);
	if (method === "DELETE") return route.DELETE(request);
	return route.POST(request);
}) as unknown as typeof fetch;

function newClient(
	token: string,
	name = "reliability-test-client",
): { client: Client; transport: StreamableHTTPClientTransport } {
	const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
		fetch: routeFetch,
		requestInit: { headers: { Authorization: `Bearer ${token}` } },
	});
	const client = new Client({ name, version: "0.0.0" });
	return { client, transport };
}

type CallResult = {
	isError?: boolean;
	content: Array<{ type: string; text: string }>;
};

function parsePayload(res: CallResult): Record<string, unknown> {
	return JSON.parse(res.content[0].text) as Record<string, unknown>;
}

interface RecordedCall {
	tool: string;
	args: Record<string, unknown>;
}

/**
 * Register a fake executor tab that logs every relayed call (tool name +
 * args) and answers it with a valid `ok` `DirectorResult`, mimicking what the
 * browser `EditorCore` returns. Returns the real tabId `registerTab` minted
 * so the caller can unregister it precisely.
 */
function registerRecordingTab(
	projectId: string,
	userId: string,
	log: RecordedCall[],
): string {
	const bridge = getEditorBridge();
	return bridge.registerTab({
		projectId,
		userId,
		send: (event, data) => {
			if (event !== "tool-call") return;
			const call = JSON.parse(data) as {
				callId: string;
				tool: string;
				args: Record<string, unknown>;
			};
			log.push({ tool: call.tool, args: call.args });
			queueMicrotask(() => {
				bridge.resolveCall({
					callId: call.callId,
					projectId,
					userId,
					result: { ok: true, message: `ok:${call.tool}`, data: {} },
				});
			});
		},
		close: () => {},
	});
}

// ─────────────────────────────────────────────────────────────────────────
// 1. THE DOUBLE EDIT LOOP
// ─────────────────────────────────────────────────────────────────────────

describe("MCP reliability: double edit loop survives reconnect with no manual reset", () => {
	const LOOP_USER = "user_reliability_loop";
	const LOOP_PROJECT = "proj_reliability_loop";
	const LOOP_TOKEN = "mcp_reliability_loop_token";
	GRANTS[LOOP_TOKEN] = {
		userId: LOOP_USER,
		projectId: LOOP_PROJECT,
		scopes: ["reel:read", "reel:write"],
	};

	// Registered ONCE for the whole describe block — the point of this test is
	// that the SAME bridge tab + session store, untouched between rounds, keep
	// answering correctly across two independent connect→disconnect cycles.
	const calls: RecordedCall[] = [];
	const tabId = registerRecordingTab(LOOP_PROJECT, LOOP_USER, calls);
	const openClients: Client[] = [];

	afterAll(async () => {
		for (const c of openClients) await c.close().catch(() => {});
		getEditorBridge().unregisterTab(LOOP_PROJECT, tabId);
	});

	const CANONICAL_TOOL_NAMES = toolCatalog()
		.map((d) => d.name)
		.sort();

	/** One full external-agent cycle: connect → list → read → 3 edits → export → disconnect. */
	async function runRound(label: string): Promise<{
		sessionId: string;
		toolNames: string[];
	}> {
		const { client, transport } = newClient(LOOP_TOKEN, `loop-client-${label}`);
		openClients.push(client);

		// connect + initialize (fails here if auth/session is broken).
		await client.connect(transport);
		const sessionId = transport.sessionId;
		expect(typeof sessionId).toBe("string");

		// tools/list — the shared catalog surface must reach the client, in full,
		// every round.
		const { tools } = await client.listTools();
		const toolNames = tools.map((t) => t.name).sort();
		expect(toolNames).toEqual(CANONICAL_TOOL_NAMES);

		// a read
		const readRes = (await client.callTool({
			name: "getReel",
			arguments: {},
		})) as CallResult;
		expect(readRes.isError).toBeFalsy();
		expect(parsePayload(readRes).ok).toBe(true);
		expect(calls.at(-1)).toEqual({ tool: "getReel", args: {} });

		// three mutating edit ops
		const trimRes = (await client.callTool({
			name: "trim",
			arguments: { slotId: "slot_trim_1", trimStart: 0, trimEnd: 5 },
		})) as CallResult;
		expect(trimRes.isError).toBeFalsy();
		expect(parsePayload(trimRes).ok).toBe(true);
		expect(calls.at(-1)).toEqual({
			tool: "trim",
			args: { slotId: "slot_trim_1", trimStart: 0, trimEnd: 5 },
		});

		const addTextRes = (await client.callTool({
			name: "addText",
			arguments: { content: "hello from round " + label, startTime: 1 },
		})) as CallResult;
		expect(addTextRes.isError).toBeFalsy();
		expect(parsePayload(addTextRes).ok).toBe(true);
		expect(calls.at(-1)).toEqual({
			tool: "addText",
			args: { content: "hello from round " + label, startTime: 1 },
		});

		const removeRes = (await client.callTool({
			name: "remove",
			arguments: { slotId: "slot_remove_1" },
		})) as CallResult;
		expect(removeRes.isError).toBeFalsy();
		expect(parsePayload(removeRes).ok).toBe(true);
		expect(calls.at(-1)).toEqual({
			tool: "remove",
			args: { slotId: "slot_remove_1" },
		});

		// export — relays through the identical bridge path (mutating:false, but
		// still a real tool-call round trip).
		const exportRes = (await client.callTool({
			name: "export",
			arguments: {},
		})) as CallResult;
		expect(exportRes.isError).toBeFalsy();
		expect(parsePayload(exportRes).ok).toBe(true);
		expect(calls.at(-1)).toEqual({ tool: "export", args: {} });

		// clean disconnect: a real DELETE (session ends server-side — the store's
		// `onsessionclosed` fires) followed by local transport teardown.
		// (`client.close()` alone only aborts the client's own SSE connection —
		// it does not send DELETE; `terminateSession()` is what actually tears
		// down server-side session state per the Streamable HTTP spec.)
		await transport.terminateSession();
		await client.close().catch(() => {});

		return { sessionId: sessionId as string, toolNames };
	}

	test("round 1 and round 2 behave identically on a fresh connection, with different session ids, and no reset in between", async () => {
		const round1 = await runRound("r1");
		const round2 = await runRound("r2");

		expect(round1.sessionId).not.toBe(round2.sessionId);
		expect(round2.toolNames).toEqual(round1.toolNames);
		// 2 rounds × (read + 3 edits + export) = 10 calls reached the SAME tab.
		expect(calls.length).toBe(10);

		// The round-1 session is well and truly gone: reusing its id 404s.
		const staleRes = await routeFetch(MCP_URL, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${LOOP_TOKEN}`,
				"mcp-session-id": round1.sessionId,
			},
		});
		expect(staleRes.status).toBe(404);
	}, 20_000);
});

// ─────────────────────────────────────────────────────────────────────────
// 2. TOKEN-AUTH EDGES
// ─────────────────────────────────────────────────────────────────────────

describe("MCP reliability: token-auth edges", () => {
	test("a valid token for a DIFFERENT user/project against an existing session id → 403", async () => {
		const SESSION_USER = "user_reliability_sessA";
		const SESSION_PROJECT = "proj_reliability_sessA";
		const SESSION_TOKEN = "mcp_reliability_sessA_token";
		GRANTS[SESSION_TOKEN] = {
			userId: SESSION_USER,
			projectId: SESSION_PROJECT,
			scopes: ["reel:read", "reel:write"],
		};

		const OTHER_TOKEN = "mcp_reliability_sessA_intruder_token";
		GRANTS[OTHER_TOKEN] = {
			userId: "user_reliability_sessA_intruder",
			projectId: "proj_reliability_sessA_intruder",
			scopes: ["reel:read", "reel:write"],
		};

		const { client, transport } = newClient(SESSION_TOKEN);
		await client.connect(transport);
		const sessionId = transport.sessionId as string;
		expect(typeof sessionId).toBe("string");
		// Local-only close: the session stays live server-side so we can probe it
		// with the wrong token below (a real DELETE would just 404 either way).
		await client.close().catch(() => {});

		const res = await routeFetch(MCP_URL, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${OTHER_TOKEN}`,
				"mcp-session-id": sessionId,
			},
		});
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error?: { message?: string } };
		expect(body.error?.message).toMatch(/different user\/project/i);

		// Cleanup: terminate with the OWNING token so this session doesn't leak
		// into the store for the rest of the suite.
		const cleanup = await routeFetch(MCP_URL, {
			method: "DELETE",
			headers: {
				Authorization: `Bearer ${SESSION_TOKEN}`,
				"mcp-session-id": sessionId,
			},
		});
		expect([200, 405]).toContain(cleanup.status);
	});

	test("token revoked MID-session → the next call on the same session 401s, and the session store is unharmed", async () => {
		const REVOKE_USER = "user_reliability_revoke";
		const REVOKE_PROJECT = "proj_reliability_revoke";
		const REVOKE_TOKEN = "mcp_reliability_revoke_token";
		GRANTS[REVOKE_TOKEN] = {
			userId: REVOKE_USER,
			projectId: REVOKE_PROJECT,
			scopes: ["reel:read", "reel:write"],
		};

		const calls: RecordedCall[] = [];
		const tabId = registerRecordingTab(REVOKE_PROJECT, REVOKE_USER, calls);

		const { client, transport } = newClient(REVOKE_TOKEN);
		await client.connect(transport);

		const first = (await client.callTool({
			name: "getReel",
			arguments: {},
		})) as CallResult;
		expect(first.isError).toBeFalsy();
		expect(parsePayload(first).ok).toBe(true);

		// Flip the mocked verifyProjectToken to "revoked" (mirrors a DB row's
		// revokedAt getting set while the session is still open).
		revokedTokens.add(REVOKE_TOKEN);

		// Raw fetch, not the SDK client: a bare 401 mid-session is a transport
		// error the SDK client isn't obligated to surface cleanly, and asserting
		// the exact HTTP status is the point of this case.
		const blocked = await routeFetch(MCP_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${REVOKE_TOKEN}`,
				"mcp-session-id": transport.sessionId as string,
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 9001,
				method: "tools/call",
				params: { name: "getReel", arguments: {} },
			}),
		});
		expect(blocked.status).toBe(401);

		// Prove the session STORE itself wasn't crashed/corrupted by the
		// revocation: un-revoke and reuse the exact same client/session — it must
		// still work normally, proving the 401 never touched session state.
		revokedTokens.delete(REVOKE_TOKEN);
		const recovered = (await client.callTool({
			name: "getReel",
			arguments: {},
		})) as CallResult;
		expect(recovered.isError).toBeFalsy();
		expect(parsePayload(recovered).ok).toBe(true);

		await client.close().catch(() => {});
		getEditorBridge().unregisterTab(REVOKE_PROJECT, tabId);
	});

	test("an unknown/evicted session id 404s with a re-initialize hint, then a fresh initialize with the same token self-heals", async () => {
		const EVICT_USER = "user_reliability_evict";
		const EVICT_PROJECT = "proj_reliability_evict";
		const EVICT_TOKEN = "mcp_reliability_evict_token";
		GRANTS[EVICT_TOKEN] = {
			userId: EVICT_USER,
			projectId: EVICT_PROJECT,
			scopes: ["reel:read", "reel:write"],
		};

		const ghostSessionId = crypto.randomUUID();
		const res = await routeFetch(MCP_URL, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${EVICT_TOKEN}`,
				"mcp-session-id": ghostSessionId,
			},
		});
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error?: { message?: string } };
		expect(body.error?.message).toMatch(/new initialize|re-?initializ/i);

		// Self-healing: a fresh initialize (no session header) with the SAME
		// token succeeds, minting a brand new session.
		const { client, transport } = newClient(EVICT_TOKEN);
		await client.connect(transport);
		const { tools } = await client.listTools();
		expect(tools.length).toBeGreaterThan(0);
		expect(transport.sessionId).not.toBe(ghostSessionId);

		await client.close().catch(() => {});
	});

	test("tab disconnects mid-call (send() throws) → structured { ok:false, bridge } error envelope, no hang, session keeps answering", async () => {
		const TABDISC_USER = "user_reliability_tabdisc";
		const TABDISC_PROJECT = "proj_reliability_tabdisc";
		const TABDISC_TOKEN = "mcp_reliability_tabdisc_token";
		GRANTS[TABDISC_TOKEN] = {
			userId: TABDISC_USER,
			projectId: TABDISC_PROJECT,
			scopes: ["reel:read", "reel:write"],
		};

		const bridge = getEditorBridge();
		const tabId = bridge.registerTab({
			projectId: TABDISC_PROJECT,
			userId: TABDISC_USER,
			send: () => {
				// Simulates the SSE pipe breaking exactly as the tab is asked to run
				// a tool — relayToolCall's own try/catch must turn this into a
				// structured BridgeError, not an unhandled rejection or a hang.
				throw new Error("simulated broken pipe");
			},
			close: () => {},
		});

		const { client, transport } = newClient(TABDISC_TOKEN);
		await client.connect(transport);

		const res = (await client.callTool({
			name: "getReel",
			arguments: {},
		})) as CallResult;
		expect(res.isError).toBe(true);
		const payload = parsePayload(res) as {
			ok: boolean;
			message: string;
			bridge?: string;
		};
		expect(payload.ok).toBe(false);
		expect(payload.bridge).toBe("tab-disconnected");

		// The JSON-RPC transport/session itself must survive: the SAME session
		// answers a second call (still a structured error, since the tab is still
		// broken) rather than hanging or tearing down the connection.
		const res2 = (await client.callTool({
			name: "getReel",
			arguments: {},
		})) as CallResult;
		expect(res2.isError).toBe(true);
		expect((parsePayload(res2) as { bridge?: string }).bridge).toBe(
			"tab-disconnected",
		);

		await client.close().catch(() => {});
		bridge.unregisterTab(TABDISC_PROJECT, tabId);
	}, 15_000);
});

/**
 * End-to-end smoke test for the external MCP server.
 *
 * Drives the REAL MCP Streamable-HTTP stack in-process: an official
 * `@modelcontextprotocol/sdk` `Client` talks to the shipped `/api/mcp` route
 * handler through a custom `fetch` that hands each request straight to the
 * exported handler (no sockets). This exercises the genuine path an external
 * agent (Claude Code, Cursor, …) takes:
 *
 *   initialize (Bearer token) → session id pinned to {user,project}
 *     → tools/list (shared catalog) → tools/call getReel
 *     → scope gate → editor-bridge relay → executor tab answers
 *     → DirectorResult returned as JSON-RPC content.
 *
 * Hermetic by construction:
 *  - `@/lib/mcp/auth` is mocked so token verification returns a fixed grant
 *    instead of hitting Postgres — the REAL `scopeForTool` is kept, so scope
 *    enforcement is still tested for real.
 *  - A fake executor tab is registered on the real {@link getEditorBridge} so
 *    the relayed call round-trips to a valid `DirectorResult` (the browser
 *    `EditorCore` that normally answers cannot exist under `bun test`).
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { scopeForTool } from "@/lib/director/tool-catalog";

const USER_ID = "user_smoke";
const PROJECT_ID = "proj_smoke";
const VALID_TOKEN = "mcp_smoke_valid_token";

// Mock ONLY the DB-backed token verification; keep the real scope logic so the
// scope gate in build-mcp-server is genuinely exercised. Registered before the
// route module is imported (below) so the route binds this mock.
mock.module("@/lib/mcp/auth", () => ({
	MCP_SCOPES: ["reel:read", "reel:write"] as const,
	scopeForTool,
	verifyProjectToken: async (raw: string) => {
		const token = (raw ?? "").replace(/^Bearer\s+/i, "").trim();
		if (token !== VALID_TOKEN) return null;
		// Read-only grant on purpose — lets us assert the write-scope gate too.
		return { userId: USER_ID, projectId: PROJECT_ID, scopes: ["reel:read"] };
	},
}));

// Import AFTER the mock is registered so the route wires the stubbed auth.
const route = (await import("@/app/api/mcp/route")) as {
	GET: (req: Request) => Promise<Response>;
	POST: (req: Request) => Promise<Response>;
	DELETE: (req: Request) => Promise<Response>;
};
const { getEditorBridge } = await import("@/lib/mcp/editor-bridge");

/** Route the SDK client's fetch straight to the in-process handler. */
const routeFetch = (async (input: string | URL, init?: RequestInit) => {
	const url = typeof input === "string" ? input : input.toString();
	const request = new Request(url, init);
	const method = request.method.toUpperCase();
	if (method === "GET") return route.GET(request);
	if (method === "DELETE") return route.DELETE(request);
	return route.POST(request);
}) as unknown as typeof fetch;

function newClient(token: string): {
	client: Client;
	transport: StreamableHTTPClientTransport;
} {
	const transport = new StreamableHTTPClientTransport(
		new URL("http://mcp.smoke.local/api/mcp"),
		{
			fetch: routeFetch,
			requestInit: { headers: { Authorization: `Bearer ${token}` } },
		},
	);
	const client = new Client({ name: "smoke-client", version: "0.0.0" });
	return { client, transport };
}

describe("MCP e2e smoke", () => {
	let unregisterTab: () => void = () => {};
	const openClients: Client[] = [];

	beforeAll(() => {
		// Fake executor tab: answer every relayed tool-call with a valid
		// read-only DirectorResult, mimicking what the browser EditorCore returns.
		const bridge = getEditorBridge();
		bridge.registerTab({
			projectId: PROJECT_ID,
			userId: USER_ID,
			send: (event, data) => {
				if (event !== "tool-call") return;
				const call = JSON.parse(data) as {
					callId: string;
					tool: string;
					args: Record<string, unknown>;
				};
				queueMicrotask(() => {
					bridge.resolveCall({
						callId: call.callId,
						projectId: PROJECT_ID,
						userId: USER_ID,
						result: {
							ok: true,
							message: `smoke:${call.tool}`,
							data: { slots: [] },
						},
					});
				});
			},
			close: () => {},
		});
		unregisterTab = () => bridge.unregisterTab(PROJECT_ID, "");
	});

	afterAll(async () => {
		for (const c of openClients) {
			await c.close().catch(() => {});
		}
		unregisterTab();
	});

	test("connects, authenticates, lists tools, and calls a read-only verb", async () => {
		const { client, transport } = newClient(VALID_TOKEN);
		openClients.push(client);

		// initialize + session handshake (fails here if auth/session is broken).
		await client.connect(transport);

		// tools/list — the shared catalog surface must reach the client.
		const { tools } = await client.listTools();
		const names = tools.map((t) => t.name);
		expect(names).toContain("getReel");
		const getReel = tools.find((t) => t.name === "getReel");
		expect(getReel?.annotations?.readOnlyHint).toBe(true);

		// tools/call getReel — relays through the bridge to the fake tab.
		const res = (await client.callTool({
			name: "getReel",
			arguments: {},
		})) as {
			isError?: boolean;
			content: Array<{ type: string; text: string }>;
		};

		expect(res.isError).toBeFalsy();
		const payload = JSON.parse(res.content[0].text) as {
			ok: boolean;
			message: string;
			data?: unknown;
		};
		expect(payload.ok).toBe(true);
		expect(payload.message).toBe("smoke:getReel");
	});

	test("enforces per-tool scope: a read-only token cannot call a mutating verb", async () => {
		const { client, transport } = newClient(VALID_TOKEN);
		openClients.push(client);
		await client.connect(transport);

		const res = (await client.callTool({
			name: "undo", // mutating → requires reel:write, which this token lacks
			arguments: {},
		})) as {
			isError?: boolean;
			content: Array<{ type: string; text: string }>;
		};

		expect(res.isError).toBe(true);
		const payload = JSON.parse(res.content[0].text) as {
			ok: boolean;
			message: string;
		};
		expect(payload.ok).toBe(false);
		expect(payload.message).toMatch(/scope/i);
	});

	test("rejects a missing/invalid bearer token at initialize", async () => {
		const { client, transport } = newClient("not-a-real-token");
		openClients.push(client);
		await expect(client.connect(transport)).rejects.toThrow();
	});
});

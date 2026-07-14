/**
 * Per-verb MCP rate limiting, exercised through the real Streamable-HTTP
 * stack (same in-process pattern as `mcp-e2e-smoke.test.ts`): an official SDK
 * `Client` talks to the shipped `/api/mcp` route handler, which relays
 * `tools/call` to `build-mcp-server.ts`. That handler picks the `mcp:read` or
 * `mcp:write` rate-limit bucket from the catalog's `mutating` flag (see
 * `RATE_LIMITS` in `rate-limit.ts`) and returns an MCP `CallToolResult` with
 * `isError: true` once the bucket is exhausted — a protocol-level error, not
 * a bare HTTP 429, so the client's session survives.
 *
 * The env has no real Upstash credentials configured in this test run, so
 * `getRateLimiter()` resolves to the process-local `InMemoryRateLimiter`
 * (same as the `enforceRateLimit` unit test) — this genuinely exercises the
 * bucket math, not a stub.
 *
 * Uses distinct userId/projectId per test so the `mcp:read`/`mcp:write` and
 * `mcp:transport` buckets (all keyed on userId, projectId, or both) don't
 * bleed across tests in this file or collide with `mcp-e2e-smoke.test.ts`'s
 * `user_smoke`/`proj_smoke`.
 */

import { afterAll, describe, expect, mock, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { scopeForTool } from "@/lib/director/tool-catalog";
import { InMemoryRateLimiter, getRateLimiter } from "@/lib/rate-limit";

const VALID_TOKEN = "mcp_ratelimit_test_token";

// Same grant regardless of which project the request pins to — this test
// varies projectId per case instead, which is enough to isolate the
// mcp:read/mcp:write buckets (keyed `${userId}:${projectId}`).
mock.module("@/lib/mcp/auth", () => ({
	MCP_SCOPES: ["reel:read", "reel:write"] as const,
	scopeForTool,
	verifyProjectToken: async (raw: string) => {
		const token = (raw ?? "").replace(/^Bearer\s+/i, "").trim();
		if (token !== VALID_TOKEN) return null;
		return {
			userId: "user_ratelimit",
			projectId: currentProjectId,
			scopes: ["reel:read", "reel:write"],
		};
	},
}));

// The mocked auth module reads this at verify-time, so each test can pin a
// fresh project id (and therefore a fresh mcp:read/mcp:write bucket) just by
// setting it before connecting.
let currentProjectId = "proj_ratelimit_init";

const route = (await import("@/app/api/mcp/route")) as {
	POST: (req: Request) => Promise<Response>;
};
const { getEditorBridge } = await import("@/lib/mcp/editor-bridge");

const routeFetch = (async (input: string | URL, init?: RequestInit) => {
	const url = typeof input === "string" ? input : input.toString();
	return route.POST(new Request(url, init));
}) as unknown as typeof fetch;

function newClient(): {
	client: Client;
	transport: StreamableHTTPClientTransport;
} {
	const transport = new StreamableHTTPClientTransport(
		new URL("http://mcp.ratelimit.local/api/mcp"),
		{
			fetch: routeFetch,
			requestInit: { headers: { Authorization: `Bearer ${VALID_TOKEN}` } },
		},
	);
	const client = new Client({
		name: "ratelimit-test-client",
		version: "0.0.0",
	});
	return { client, transport };
}

describe("MCP per-verb rate limiting", () => {
	// getRateLimiter() is a process-wide singleton cached on globalThis; force
	// a fresh InMemoryRateLimiter for this suite so its buckets can't have been
	// pre-warmed by another test file that ran earlier in the same process.
	const globalStore = globalThis as unknown as {
		__byornRateLimiter?: unknown;
	};
	const previousLimiter = globalStore.__byornRateLimiter;
	globalStore.__byornRateLimiter = new InMemoryRateLimiter();
	expect(getRateLimiter()).toBeInstanceOf(InMemoryRateLimiter);

	const openClients: Client[] = [];
	const registeredProjects: string[] = [];

	afterAll(async () => {
		for (const c of openClients) await c.close().catch(() => {});
		const bridge = getEditorBridge();
		for (const projectId of registeredProjects) {
			bridge.unregisterTab(projectId, "");
		}
		globalStore.__byornRateLimiter = previousLimiter;
	});

	/** Register a fake executor tab that answers every relayed call instantly. */
	function registerFakeTab(projectId: string): void {
		const bridge = getEditorBridge();
		bridge.registerTab({
			projectId,
			userId: "user_ratelimit",
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
						projectId,
						userId: "user_ratelimit",
						result: { ok: true, message: `ok:${call.tool}`, data: {} },
					});
				});
			},
			close: () => {},
		});
		registeredProjects.push(projectId);
	}

	test("the read bucket (120/min) blocks the 121st read-only tool call with an MCP-protocol error, not a bare 429", async () => {
		currentProjectId = "proj_ratelimit_read";
		registerFakeTab(currentProjectId);

		const { client, transport } = newClient();
		openClients.push(client);
		await client.connect(transport);

		for (let i = 0; i < 120; i++) {
			const res = (await client.callTool({
				name: "getReel",
				arguments: {},
			})) as {
				isError?: boolean;
			};
			expect(res.isError).toBeFalsy();
		}

		const overflow = (await client.callTool({
			name: "getReel",
			arguments: {},
		})) as {
			isError?: boolean;
			content: Array<{ type: string; text: string }>;
		};

		expect(overflow.isError).toBe(true);
		const payload = JSON.parse(overflow.content[0].text) as {
			ok: boolean;
			message: string;
		};
		expect(payload.ok).toBe(false);
		expect(payload.message).toMatch(/rate limit/i);
		expect(payload.message).toMatch(/read/i);
	}, 20_000);

	test("the write bucket (30/min) is tighter than the read bucket and independent of it", async () => {
		currentProjectId = "proj_ratelimit_write";
		registerFakeTab(currentProjectId);

		const { client, transport } = newClient();
		openClients.push(client);
		await client.connect(transport);

		for (let i = 0; i < 30; i++) {
			const res = (await client.callTool({ name: "undo", arguments: {} })) as {
				isError?: boolean;
			};
			expect(res.isError).toBeFalsy();
		}

		const overflow = (await client.callTool({
			name: "undo",
			arguments: {},
		})) as {
			isError?: boolean;
			content: Array<{ type: string; text: string }>;
		};

		expect(overflow.isError).toBe(true);
		const payload = JSON.parse(overflow.content[0].text) as {
			ok: boolean;
			message: string;
		};
		expect(payload.ok).toBe(false);
		expect(payload.message).toMatch(/rate limit/i);
		expect(payload.message).toMatch(/mutating/i);

		// A read-only call against the SAME project still has budget — proves
		// the write bucket exhausting doesn't clobber the read bucket.
		const readStillWorks = (await client.callTool({
			name: "getReel",
			arguments: {},
		})) as { isError?: boolean };
		expect(readStillWorks.isError).toBeFalsy();
	}, 20_000);
});

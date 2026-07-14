/**
 * MCP `tool_call` telemetry enrichment + activation (poach/verb-telemetry,
 * palmier-delta-refresh-2026-07-14 §4.6). Same in-process harness as
 * `mcp-project-binding.test.ts` / `mcp-rate-limit.test.ts`: a real SDK
 * `Client` talks to the shipped `/api/mcp` route through a routeFetch,
 * `@/lib/mcp/auth` is mocked (DB-free token verification, per-test
 * scopes/projectId), and a real {@link getEditorBridge} is used with fake
 * tabs registered per case.
 *
 * Unlike the sibling MCP test files, THIS file asserts on the actual
 * `mcp_events` rows `build-mcp-server.ts` writes (via the real
 * `recordMcpEvent` — not mocked), so it seeds one real throwaway `users` row
 * for the FK (`mcp_events.user_id` -> `users.id`), same posture as
 * `lib/mcp/__tests__/telemetry.test.ts` and
 * `app/api/telemetry/__tests__/verb-route.test.ts`. Every test uses its own
 * unique projectId so the `mcp:read`/`mcp:write` rate-limit buckets (keyed on
 * `${userId}:${projectId}`) never collide with each other.
 */

import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	mock,
	test,
} from "bun:test";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { scopeForTool } from "@/lib/director/tool-catalog";
import { users } from "@/lib/db/schema";
import { mcpEvents } from "@/lib/db/schema-mcp";
import { InMemoryRateLimiter, getRateLimiter } from "@/lib/rate-limit";

// Load the REAL db implementation and re-pin the "@/lib/db" alias to it,
// immune to cross-file mock leakage (same query-suffix trick as
// `app/api/telemetry/__tests__/verb-route.test.ts` / `tts/__tests__/route.test.ts`).
// This file asserts on REAL mcp_events rows written through `recordMcpEvent`
// (imported deep inside `build-mcp-server.ts` via the plain "@/lib/db"
// specifier), so it needs the real implementation even in a full-suite run
// where an earlier file's `mock.module("@/lib/db", fakeDb)` (missing
// `.catch`/`.transaction`) would otherwise leak forward — see
// `lib/mcp/__tests__/telemetry.test.ts`'s header for the original writeup of
// this gotcha.
const realDb = (await import(
	"../../db/index.ts?real" as string
)) as typeof import("@/lib/db");
mock.module("@/lib/db", () => ({ ...realDb }));
const { db } = realDb;

const USER_ID = `mcp-telemetry-enrich-${crypto.randomUUID()}`;
const VALID_TOKEN = "mcp_telemetry_enrich_token";

let currentProjectId = "proj_telemetry_enrich_init";
let currentScopes: string[] = ["reel:read", "reel:write"];

mock.module("@/lib/mcp/auth", () => ({
	MCP_SCOPES: ["reel:read", "reel:write"] as const,
	scopeForTool,
	verifyProjectToken: async (raw: string) => {
		const token = (raw ?? "").replace(/^Bearer\s+/i, "").trim();
		if (token !== VALID_TOKEN) return null;
		return {
			userId: USER_ID,
			projectId: currentProjectId,
			scopes: currentScopes,
		};
	},
}));

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
		new URL("http://mcp.telemetry-enrich.local/api/mcp"),
		{
			fetch: routeFetch,
			requestInit: { headers: { Authorization: `Bearer ${VALID_TOKEN}` } },
		},
	);
	const client = new Client({
		name: "telemetry-enrich-test-client",
		version: "0.0.0",
	});
	return { client, transport };
}

async function callTool(
	client: Client,
	name: string,
): Promise<{ isError?: boolean; payload: Record<string, unknown> }> {
	const res = (await client.callTool({ name, arguments: {} })) as {
		isError?: boolean;
		content: Array<{ type: string; text: string }>;
	};
	return { isError: res.isError, payload: JSON.parse(res.content[0].text) };
}

async function eventsFor(
	projectId: string,
): Promise<Array<typeof mcpEvents.$inferSelect>> {
	return db.select().from(mcpEvents).where(eq(mcpEvents.projectId, projectId));
}

async function waitFor(
	predicate: () => Promise<boolean>,
	timeoutMs = 2000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
}

describe("MCP tool_call telemetry enrichment + activation", () => {
	// Fresh limiter for this suite so its real bucket math (used by the
	// rate_limited case) can't have been pre-warmed by another test file that
	// ran earlier in the same process — same trick as mcp-rate-limit.test.ts.
	const globalStore = globalThis as unknown as { __byornRateLimiter?: unknown };
	const previousLimiter = globalStore.__byornRateLimiter;
	globalStore.__byornRateLimiter = new InMemoryRateLimiter();
	expect(getRateLimiter()).toBeInstanceOf(InMemoryRateLimiter);

	const openClients: Client[] = [];
	let liveTabs: Array<{ projectId: string; tabId: string }> = [];

	beforeAll(async () => {
		await db.insert(users).values({
			id: USER_ID,
			name: "MCP Telemetry Enrichment Test",
			email: `${USER_ID}@example.test`,
			emailVerified: false,
			createdAt: new Date(),
			updatedAt: new Date(),
		});
	});

	afterEach(() => {
		const bridge = getEditorBridge();
		for (const { projectId, tabId } of liveTabs) {
			bridge.unregisterTab(projectId, tabId);
		}
		liveTabs = [];
		currentScopes = ["reel:read", "reel:write"];
	});

	afterAll(async () => {
		for (const c of openClients) await c.close().catch(() => {});
		globalStore.__byornRateLimiter = previousLimiter;
		await db
			.delete(mcpEvents)
			.where(eq(mcpEvents.userId, USER_ID))
			.catch(() => {});
		await db
			.delete(users)
			.where(eq(users.id, USER_ID))
			.catch(() => {});
	});

	/** Register a fake executor tab that answers every relayed call `ok` (or a custom result). */
	function registerFakeTab(
		projectId: string,
		userId: string,
		result: { ok: boolean; message?: string; data?: unknown } = {
			ok: true,
			message: "ok",
			data: {},
		},
	): void {
		const bridge = getEditorBridge();
		const tabId = bridge.registerTab({
			projectId,
			userId,
			send: (event, data) => {
				if (event !== "tool-call") return;
				const call = JSON.parse(data) as { callId: string; tool: string };
				queueMicrotask(() => {
					bridge.resolveCall({
						callId: call.callId,
						projectId,
						userId,
						result: {
							...result,
							message: `${result.message ?? "ok"}:${call.tool}`,
						},
					});
				});
			},
			close: () => {},
		});
		liveTabs.push({ projectId, tabId });
	}

	test("successful READ call: status ok, timelineChanged false, mutating false, source mcp, PLUS a matching mcp_activated row", async () => {
		currentProjectId = "proj_enrich_read_ok";
		registerFakeTab(currentProjectId, USER_ID);
		const { client, transport } = newClient();
		openClients.push(client);
		await client.connect(transport);

		const { isError } = await callTool(client, "getReel");
		expect(isError).toBeFalsy();

		let rows: Array<typeof mcpEvents.$inferSelect> = [];
		await waitFor(async () => {
			rows = await eventsFor(currentProjectId);
			return (
				rows.some((r) => r.event === "tool_call") &&
				rows.some((r) => r.event === "mcp_activated")
			);
		});

		const toolCall = rows.find((r) => r.event === "tool_call");
		const meta = toolCall?.meta as Record<string, unknown>;
		expect(meta.source).toBe("mcp");
		expect(meta.status).toBe("ok");
		expect(meta.timelineChanged).toBe(false);
		expect(meta.mutating).toBe(false);
		expect(typeof meta.durationMs).toBe("number");
		expect(meta.durationMs as number).toBeGreaterThanOrEqual(0);

		const activation = rows.find((r) => r.event === "mcp_activated");
		expect(activation?.verb).toBe("getReel");
		expect((activation?.meta as Record<string, unknown>).source).toBe("mcp");
	});

	test("successful MUTATING call: timelineChanged true, mutating true; a SECOND successful call in the same session does NOT re-activate", async () => {
		currentProjectId = "proj_enrich_mutate_ok";
		registerFakeTab(currentProjectId, USER_ID);
		const { client, transport } = newClient();
		openClients.push(client);
		await client.connect(transport);

		await callTool(client, "undo");
		let rows: Array<typeof mcpEvents.$inferSelect> = [];
		await waitFor(async () => {
			rows = await eventsFor(currentProjectId);
			return rows.some((r) => r.event === "mcp_activated");
		});
		const firstToolCall = rows.find((r) => r.event === "tool_call");
		const firstMeta = firstToolCall?.meta as Record<string, unknown>;
		expect(firstMeta.timelineChanged).toBe(true);
		expect(firstMeta.mutating).toBe(true);
		expect(rows.filter((r) => r.event === "mcp_activated").length).toBe(1);

		await callTool(client, "undo");
		await waitFor(async () => {
			rows = await eventsFor(currentProjectId);
			return rows.filter((r) => r.event === "tool_call").length >= 2;
		});
		// Still exactly one activation despite a second successful call.
		expect(rows.filter((r) => r.event === "mcp_activated").length).toBe(1);
	});

	test("a FAILED first call (tool returns ok:false) does not activate; the next successful call does", async () => {
		currentProjectId = "proj_enrich_fail_then_ok";
		registerFakeTab(currentProjectId, USER_ID, { ok: false, message: "nope" });
		const { client, transport } = newClient();
		openClients.push(client);
		await client.connect(transport);

		await callTool(client, "getReel");
		let rows: Array<typeof mcpEvents.$inferSelect> = [];
		await waitFor(async () => {
			rows = await eventsFor(currentProjectId);
			return rows.some((r) => r.event === "tool_call");
		});
		const firstToolCall = rows.find((r) => r.event === "tool_call");
		expect((firstToolCall?.meta as Record<string, unknown>).status).toBe(
			"tool_error",
		);
		expect(rows.some((r) => r.event === "mcp_activated")).toBe(false);

		// Flip the fake tab to succeed and call again.
		const bridge = getEditorBridge();
		for (const { projectId, tabId } of liveTabs)
			bridge.unregisterTab(projectId, tabId);
		liveTabs = [];
		registerFakeTab(currentProjectId, USER_ID, {
			ok: true,
			message: "ok",
			data: {},
		});

		await callTool(client, "getReel");
		await waitFor(async () => {
			rows = await eventsFor(currentProjectId);
			return rows.some((r) => r.event === "mcp_activated");
		});
		expect(rows.filter((r) => r.event === "mcp_activated").length).toBe(1);
	});

	test("scope-blocked mutating call: status scope_blocked, timelineChanged false", async () => {
		currentProjectId = "proj_enrich_scope_blocked";
		currentScopes = ["reel:read"]; // no reel:write
		const { client, transport } = newClient();
		openClients.push(client);
		await client.connect(transport);

		const { isError } = await callTool(client, "undo");
		expect(isError).toBe(true);

		let rows: Array<typeof mcpEvents.$inferSelect> = [];
		await waitFor(async () => {
			rows = await eventsFor(currentProjectId);
			return rows.some((r) => r.event === "tool_call");
		});
		const toolCall = rows.find((r) => r.event === "tool_call");
		const meta = toolCall?.meta as Record<string, unknown>;
		expect(meta.status).toBe("scope_blocked");
		expect(meta.timelineChanged).toBe(false);
		expect(rows.some((r) => r.event === "mcp_activated")).toBe(false);
	});

	test("rate-limited mutating call: status rate_limited once the mcp:write bucket (30/min) is exhausted", async () => {
		currentProjectId = "proj_enrich_rate_limited";
		registerFakeTab(currentProjectId, USER_ID);
		const { client, transport } = newClient();
		openClients.push(client);
		await client.connect(transport);

		for (let i = 0; i < 30; i++) {
			const { isError } = await callTool(client, "undo");
			expect(isError).toBeFalsy();
		}
		const { isError } = await callTool(client, "undo");
		expect(isError).toBe(true);

		let rows: Array<typeof mcpEvents.$inferSelect> = [];
		await waitFor(async () => {
			rows = await eventsFor(currentProjectId);
			return rows.some(
				(r) => (r.meta as Record<string, unknown>).status === "rate_limited",
			);
		});
		const limited = rows.find(
			(r) => (r.meta as Record<string, unknown>).status === "rate_limited",
		);
		expect((limited?.meta as Record<string, unknown>).timelineChanged).toBe(
			false,
		);
	});

	test("bridge refusal (no-tab): status bridge_refused, meta.bridge = 'no-tab'", async () => {
		currentProjectId = "proj_enrich_no_tab";
		// No tab registered.
		const { client, transport } = newClient();
		openClients.push(client);
		await client.connect(transport);

		const { isError } = await callTool(client, "undo");
		expect(isError).toBe(true);

		let rows: Array<typeof mcpEvents.$inferSelect> = [];
		await waitFor(async () => {
			rows = await eventsFor(currentProjectId);
			return rows.some((r) => r.event === "tool_call");
		});
		const toolCall = rows.find((r) => r.event === "tool_call");
		const meta = toolCall?.meta as Record<string, unknown>;
		expect(meta.status).toBe("bridge_refused");
		expect(meta.bridge).toBe("no-tab");
		expect(meta.timelineChanged).toBe(false);
	});

	test("bridge failure (user-mismatch): status bridge_error, distinct from bridge_refused", async () => {
		currentProjectId = "proj_enrich_user_mismatch";
		// A tab IS registered for this project, but for a DIFFERENT user — the
		// bridge rejects with BridgeError("user-mismatch"), not "no-tab".
		registerFakeTab(currentProjectId, "some_other_user_entirely");
		const { client, transport } = newClient();
		openClients.push(client);
		await client.connect(transport);

		const { isError } = await callTool(client, "undo");
		expect(isError).toBe(true);

		let rows: Array<typeof mcpEvents.$inferSelect> = [];
		await waitFor(async () => {
			rows = await eventsFor(currentProjectId);
			return rows.some((r) => r.event === "tool_call");
		});
		const toolCall = rows.find((r) => r.event === "tool_call");
		const meta = toolCall?.meta as Record<string, unknown>;
		expect(meta.status).toBe("bridge_error");
		expect(meta.bridge).toBe("user-mismatch");
		expect(meta.timelineChanged).toBe(false);
	});
});

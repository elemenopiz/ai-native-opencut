/**
 * MCP session→project binding — refusal-path tests (poach/mcp-project-binding).
 *
 * The session (and every relayed call) is pinned to the bearer token's
 * `{userId, projectId}`, never "whichever project the browser happens to have
 * open" (see `build-mcp-server.ts`'s module doc). When the bound project has
 * no live editor tab, `relayToolCall` rejects with a "no-tab" `BridgeError`
 * carrying `{boundProjectId, activeProjectId?}` (see `editor-bridge.ts`), and
 * `build-mcp-server.ts` turns that into a structured refusal worded
 * differently for a MUTATING verb (`refusal: "project-mismatch"` — this verb
 * requires the bound project's own live editor, no exceptions) vs. a READ
 * verb (`refusal: "bridge-unavailable"` — the identical gap, but no mutation
 * risk, so it is never framed as a wrong-project refusal).
 *
 * Same in-process harness as `mcp-e2e-smoke.test.ts` / `mcp-rate-limit.test.ts`:
 * a real SDK `Client` talks to the shipped `/api/mcp` route through a
 * routeFetch, `@/lib/mcp/auth` is mocked (DB-free token verification), and a
 * real {@link getEditorBridge} is used — fake tabs are registered/omitted per
 * test case to control which project (if any) has a live bridge. Every test
 * uses its own unique projectId(s) so the `mcp:read`/`mcp:write` rate-limit
 * buckets (keyed on `${userId}:${projectId}`) never collide with each other
 * or with the other MCP test files.
 */

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { scopeForTool } from "@/lib/director/tool-catalog";

const USER_ID = "user_binding";
const OTHER_USER_ID = "user_binding_other";
const VALID_TOKEN = "mcp_binding_test_token";

// One grant per test: `currentProjectId` lets each case pin a token to a fresh
// project (and therefore a fresh rate-limit bucket + bridge slot) just by
// setting it before `client.connect`.
let currentProjectId = "proj_binding_init";

mock.module("@/lib/mcp/auth", () => ({
	MCP_SCOPES: ["reel:read", "reel:write"] as const,
	scopeForTool,
	verifyProjectToken: async (raw: string) => {
		const token = (raw ?? "").replace(/^Bearer\s+/i, "").trim();
		if (token !== VALID_TOKEN) return null;
		return {
			userId: USER_ID,
			projectId: currentProjectId,
			scopes: ["reel:read", "reel:write"],
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
		new URL("http://mcp.binding.local/api/mcp"),
		{
			fetch: routeFetch,
			requestInit: { headers: { Authorization: `Bearer ${VALID_TOKEN}` } },
		},
	);
	const client = new Client({ name: "binding-test-client", version: "0.0.0" });
	return { client, transport };
}

/**
 * Register a fake executor tab that answers every relayed call instantly.
 * Returns the REAL tabId `registerTab` minted (a `crypto.randomUUID()`) so the
 * caller can unregister it precisely afterwards — `unregisterTab` only
 * deletes an entry when the passed tabId matches the current registration,
 * so tearing down with a placeholder id (e.g. `""`) is a silent no-op and
 * leaks the tab into later tests in this same process (the bridge is a
 * `globalThis`-cached singleton). That leak is exactly what broke the first
 * draft of the cross-user test below: a same-user tab left over from an
 * earlier case was still "live" and got legitimately picked up as the active
 * project, which is correct bridge behavior but wrong test isolation.
 */
function registerFakeTab(projectId: string, userId: string): string {
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

describe("MCP project-binding refusal path", () => {
	const openClients: Client[] = [];
	/**
	 * {projectId, tabId} pairs to precisely tear down — see `registerFakeTab`.
	 * Cleared in `afterEach` (not just `afterAll`): the bridge is a
	 * `globalThis`-cached singleton shared by every test in this file, so a
	 * tab left registered past its own test would still be "live" when a LATER
	 * test's `findActiveProjectForUser` scan runs — exactly the leak the doc
	 * comment on `registerFakeTab` describes, just one test later than where it
	 * was first caught.
	 */
	let liveTabs: Array<{ projectId: string; tabId: string }> = [];

	/** Register a tab AND remember how to tear it down exactly. */
	function registerAndTrack(projectId: string, userId: string): void {
		const tabId = registerFakeTab(projectId, userId);
		liveTabs.push({ projectId, tabId });
	}

	afterEach(() => {
		const bridge = getEditorBridge();
		for (const { projectId, tabId } of liveTabs) {
			bridge.unregisterTab(projectId, tabId);
		}
		liveTabs = [];
	});

	afterAll(async () => {
		for (const c of openClients) await c.close().catch(() => {});
	});

	test("mutating verb + no live bridge anywhere → project-mismatch refusal naming only the bound project", async () => {
		currentProjectId = "proj_binding_mut_none";
		const { client, transport } = newClient();
		openClients.push(client);
		await client.connect(transport);

		const { isError, payload } = await callTool(client, "undo");

		expect(isError).toBe(true);
		expect(payload.ok).toBe(false);
		expect(payload.refusal).toBe("project-mismatch");
		expect(payload.boundProjectId).toBe(currentProjectId);
		expect(payload.activeProjectId).toBeUndefined();
		expect(payload.message as string).toContain(currentProjectId);
		expect(payload.message as string).toMatch(
			/no editor tab is currently connected/i,
		);
	});

	test("mutating verb + the SAME user's bridge is live on a DIFFERENT project → refusal names both projects", async () => {
		const boundProjectId = "proj_binding_mut_bound";
		const otherProjectId = "proj_binding_mut_active";
		currentProjectId = boundProjectId;
		registerAndTrack(otherProjectId, USER_ID);

		const { client, transport } = newClient();
		openClients.push(client);
		await client.connect(transport);

		const { isError, payload } = await callTool(client, "undo");

		expect(isError).toBe(true);
		expect(payload.refusal).toBe("project-mismatch");
		expect(payload.boundProjectId).toBe(boundProjectId);
		expect(payload.activeProjectId).toBe(otherProjectId);
		const message = payload.message as string;
		expect(message).toContain(boundProjectId);
		expect(message).toContain(otherProjectId);
		expect(message).toMatch(/open project/i);
	});

	test("read verb + no live bridge anywhere → bridge-unavailable, NOT project-mismatch", async () => {
		currentProjectId = "proj_binding_read_none";
		const { client, transport } = newClient();
		openClients.push(client);
		await client.connect(transport);

		const { isError, payload } = await callTool(client, "getReel");

		expect(isError).toBe(true);
		expect(payload.refusal).toBe("bridge-unavailable");
		expect(payload.boundProjectId).toBe(currentProjectId);
		expect(payload.message as string).toMatch(/live editor connection/i);
		// Must not use the mutation-refusal framing for a read.
		expect(payload.message as string).not.toMatch(/^Refused:/);
	});

	test("read verb + the SAME user's bridge is live on a DIFFERENT project → bridge-unavailable, still names the active project", async () => {
		const boundProjectId = "proj_binding_read_bound";
		const otherProjectId = "proj_binding_read_active";
		currentProjectId = boundProjectId;
		registerAndTrack(otherProjectId, USER_ID);

		const { client, transport } = newClient();
		openClients.push(client);
		await client.connect(transport);

		const { isError, payload } = await callTool(client, "getReel");

		expect(isError).toBe(true);
		expect(payload.refusal).toBe("bridge-unavailable");
		expect(payload.boundProjectId).toBe(boundProjectId);
		expect(payload.activeProjectId).toBe(otherProjectId);
		expect(payload.message as string).toContain(otherProjectId);
	});

	test("a DIFFERENT user's live tab is never surfaced as the active project (no cross-user leak)", async () => {
		const boundProjectId = "proj_binding_cross_user_bound";
		const strangerProjectId = "proj_binding_cross_user_stranger";
		currentProjectId = boundProjectId;
		registerAndTrack(strangerProjectId, OTHER_USER_ID);

		const { client, transport } = newClient();
		openClients.push(client);
		await client.connect(transport);

		const { payload } = await callTool(client, "undo");

		expect(payload.refusal).toBe("project-mismatch");
		expect(payload.activeProjectId).toBeUndefined();
		expect(payload.message as string).not.toContain(strangerProjectId);
	});

	test("matching bridge for the bound project → the call proceeds normally (no refusal)", async () => {
		currentProjectId = "proj_binding_match";
		registerAndTrack(currentProjectId, USER_ID);

		const { client, transport } = newClient();
		openClients.push(client);
		await client.connect(transport);

		const { isError, payload } = await callTool(client, "undo");

		expect(isError).toBeFalsy();
		expect(payload.ok).toBe(true);
		expect(payload.refusal).toBeUndefined();
		expect(payload.message).toBe("ok:undo");
	});
});

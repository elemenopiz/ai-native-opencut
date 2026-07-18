/**
 * MCP arg-shape conformance guards (campaign C18, §2 of
 * `apps/web/docs/mcp/palmier-conformance-2026-07-17.md`).
 *
 * Two layers of coverage:
 *
 *  1. **Unit** — the extracted pure function `validateToolArgs` is exercised
 *     directly against hand-written schemas, including nested-object and array
 *     cases, to prove the recursion and both guards in isolation.
 *
 *  2. **End-to-end** — the REAL Streamable-HTTP stack (same in-process pattern
 *     as `mcp-e2e-smoke.test.ts` / `mcp-rate-limit.test.ts`): an official SDK
 *     `Client` drives `tools/call` through the shipped `/api/mcp` route into
 *     `build-mcp-server.ts`. Because rejection happens PRE-RELAY, a malformed
 *     call must never reach the editor bridge — the fake executor tab records
 *     every relayed call so we can assert it stayed untouched.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { scopeForTool, type JSONSchema } from "@/lib/director/tool-catalog";
import { validateToolArgs } from "@/lib/mcp/arg-validate";

// ── 1. Unit tests on the extracted pure validator ───────────────────────────

describe("validateToolArgs (unit)", () => {
	const EMPTY: JSONSchema = {
		type: "object",
		properties: {},
		additionalProperties: false,
	};

	test("EMPTY schema accepts no-arg call", () => {
		expect(validateToolArgs(EMPTY, {})).toBeNull();
	});

	test("EMPTY schema rejects any extra key and lists (none) allowed", () => {
		const v = validateToolArgs(EMPTY, { bogus: 1 });
		expect(v).not.toBeNull();
		expect(v?.path).toBe("bogus");
		expect(v?.message).toMatch(/Unknown argument "bogus"/);
		expect(v?.message).toMatch(/\(none\)/);
	});

	test("does NOT reject unknown keys when additionalProperties is not false", () => {
		const loose: JSONSchema = {
			type: "object",
			properties: { a: { type: "string" } },
			// no additionalProperties → lenient
		};
		expect(validateToolArgs(loose, { a: "x", extra: 2 })).toBeNull();
	});

	test("rejects non-finite number values (NaN / Infinity / -Infinity)", () => {
		const schema: JSONSchema = {
			type: "object",
			properties: { budgetUsd: { type: "number" } },
		};
		for (const bad of [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
		]) {
			const v = validateToolArgs(schema, { budgetUsd: bad });
			expect(v).not.toBeNull();
			expect(v?.path).toBe("budgetUsd");
			expect(v?.message).toMatch(/must be a finite number/);
		}
	});

	test("rejects a string that coerces to non-finite; accepts a finite numeric string", () => {
		const schema: JSONSchema = {
			type: "object",
			properties: { n: { type: "integer" } },
		};
		expect(validateToolArgs(schema, { n: "Infinity" })).not.toBeNull();
		expect(validateToolArgs(schema, { n: "abc" })).not.toBeNull();
		expect(validateToolArgs(schema, { n: "5" })).toBeNull(); // finite → ok
		expect(validateToolArgs(schema, { n: 42 })).toBeNull();
	});

	test("catches unknown keys nested inside an object property", () => {
		const schema: JSONSchema = {
			type: "object",
			properties: {
				spec: {
					type: "object",
					properties: { role: { type: "string" } },
					additionalProperties: false,
				},
			},
		};
		const v = validateToolArgs(schema, { spec: { role: "hero", oops: true } });
		expect(v).not.toBeNull();
		expect(v?.path).toBe("spec.oops");
		expect(v?.message).toMatch(/Allowed fields for "spec"/);
	});

	test("catches a non-finite number nested inside an array item", () => {
		const schema: JSONSchema = {
			type: "object",
			properties: {
				shots: {
					type: "array",
					items: {
						type: "object",
						properties: { budgetUsd: { type: "number" } },
						additionalProperties: false,
					},
				},
			},
		};
		const v = validateToolArgs(schema, {
			shots: [{ budgetUsd: 5 }, { budgetUsd: Number.NaN }],
		});
		expect(v).not.toBeNull();
		expect(v?.path).toBe("shots[1].budgetUsd");
	});

	test("catches an unknown key nested inside an array item", () => {
		const schema: JSONSchema = {
			type: "object",
			properties: {
				shots: {
					type: "array",
					items: {
						type: "object",
						properties: { role: { type: "string" } },
						additionalProperties: false,
					},
				},
			},
		};
		const v = validateToolArgs(schema, { shots: [{ role: "hero", junk: 1 }] });
		expect(v).not.toBeNull();
		expect(v?.path).toBe("shots[0].junk");
	});

	test("a fully valid nested payload passes", () => {
		const schema: JSONSchema = {
			type: "object",
			properties: {
				shots: {
					type: "array",
					items: {
						type: "object",
						properties: {
							role: { type: "string" },
							budgetUsd: { type: "number" },
						},
						additionalProperties: false,
					},
				},
			},
			additionalProperties: false,
		};
		expect(
			validateToolArgs(schema, {
				shots: [
					{ role: "hero", budgetUsd: 2.5 },
					{ role: "broll", budgetUsd: 0 },
				],
			}),
		).toBeNull();
	});
});

// ── 2. End-to-end through the real MCP Streamable-HTTP stack ─────────────────

const USER_ID = "user_guards";
const PROJECT_ID = "proj_guards";
const VALID_TOKEN = "mcp_guards_valid_token";

// Mock only the DB-backed token verification; keep the real scope logic. Grant
// BOTH scopes so a mutating verb (setBudget → reel:write) can pass the scope
// gate and reach the arg guard under test.
mock.module("@/lib/mcp/auth", () => ({
	MCP_SCOPES: ["reel:read", "reel:write"] as const,
	scopeForTool,
	verifyProjectToken: async (raw: string) => {
		const token = (raw ?? "").replace(/^Bearer\s+/i, "").trim();
		if (token !== VALID_TOKEN) return null;
		return {
			userId: USER_ID,
			projectId: PROJECT_ID,
			scopes: ["reel:read", "reel:write"],
		};
	},
}));

const route = (await import("@/app/api/mcp/route")) as {
	GET: (req: Request) => Promise<Response>;
	POST: (req: Request) => Promise<Response>;
	DELETE: (req: Request) => Promise<Response>;
};
const { getEditorBridge } = await import("@/lib/mcp/editor-bridge");

const routeFetch = (async (input: string | URL, init?: RequestInit) => {
	const url = typeof input === "string" ? input : input.toString();
	const request = new Request(url, init);
	const method = request.method.toUpperCase();
	if (method === "GET") return route.GET(request);
	if (method === "DELETE") return route.DELETE(request);
	return route.POST(request);
}) as unknown as typeof fetch;

function newClient(): {
	client: Client;
	transport: StreamableHTTPClientTransport;
} {
	const transport = new StreamableHTTPClientTransport(
		new URL("http://mcp.guards.local/api/mcp"),
		{
			fetch: routeFetch,
			requestInit: { headers: { Authorization: `Bearer ${VALID_TOKEN}` } },
		},
	);
	const client = new Client({ name: "guards-test-client", version: "0.0.0" });
	return { client, transport };
}

describe("MCP arg-shape guards (e2e, pre-relay)", () => {
	let unregisterTab: () => void = () => {};
	const openClients: Client[] = [];
	/** Tools the fake bridge tab actually received — must stay empty for rejected calls. */
	const relayedTools: string[] = [];

	beforeAll(() => {
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
				relayedTools.push(call.tool);
				queueMicrotask(() => {
					bridge.resolveCall({
						callId: call.callId,
						projectId: PROJECT_ID,
						userId: USER_ID,
						result: { ok: true, message: `ok:${call.tool}`, data: {} },
					});
				});
			},
			close: () => {},
		});
		unregisterTab = () => bridge.unregisterTab(PROJECT_ID, "");
	});

	afterAll(async () => {
		for (const c of openClients) await c.close().catch(() => {});
		unregisterTab();
	});

	test("unknown extra key on getReel (EMPTY schema) → isError, names key + allowed fields, bridge NOT invoked", async () => {
		relayedTools.length = 0;
		const { client, transport } = newClient();
		openClients.push(client);
		await client.connect(transport);

		const res = (await client.callTool({
			name: "getReel",
			arguments: { bogusKey: 123 },
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
		expect(payload.message).toMatch(/bogusKey/);
		expect(payload.message).toMatch(/Allowed fields/);
		// Pre-relay: the malformed call never reached the editor bridge.
		expect(relayedTools).not.toContain("getReel");
		expect(relayedTools).toHaveLength(0);
	});

	// Note: JSON has no NaN/Infinity literal — a compliant MCP client can't send
	// a raw non-finite *number* over the wire (JSON.stringify turns it into
	// `null`). The realistic over-the-wire case is a model emitting the value as
	// a STRING ("NaN"/"Infinity"), which the guard catches by coercion. The raw
	// numeric NaN/Infinity/-Infinity path is proven by the unit tests above.
	test("non-finite number on setBudget.budgetUsd → isError naming the path, bridge NOT invoked", async () => {
		relayedTools.length = 0;
		const { client, transport } = newClient();
		openClients.push(client);
		await client.connect(transport);

		const res = (await client.callTool({
			name: "setBudget",
			arguments: { budgetUsd: "Infinity" },
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
		expect(payload.message).toMatch(/budgetUsd/);
		expect(payload.message).toMatch(/finite number/);
		expect(relayedTools).toHaveLength(0);
	});

	test("a well-formed setBudget call passes the guard and reaches the bridge", async () => {
		relayedTools.length = 0;
		const { client, transport } = newClient();
		openClients.push(client);
		await client.connect(transport);

		const res = (await client.callTool({
			name: "setBudget",
			arguments: { budgetUsd: 2.5 },
		})) as {
			isError?: boolean;
			content: Array<{ type: string; text: string }>;
		};

		expect(res.isError).toBeFalsy();
		const payload = JSON.parse(res.content[0].text) as {
			ok: boolean;
			message: string;
		};
		expect(payload.ok).toBe(true);
		expect(relayedTools).toContain("setBudget");
	});
});

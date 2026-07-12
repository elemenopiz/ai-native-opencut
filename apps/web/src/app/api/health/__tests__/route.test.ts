/**
 * GET /api/health — the Redis/Upstash reachability branch.
 *
 * The route probes two dependencies: Postgres (`db`) and Upstash (`redis`).
 * These tests pin the DB check to "up" (via a mutable fake `@/lib/db`) so each
 * assertion isolates the Redis branch, then drive `checkRedis` by swapping the
 * Upstash env vars and stubbing the global `fetch` the REST `PING` uses.
 *
 * Key contract under test (see route doc): a CONFIGURED-but-unreachable Redis
 * fails `ok` (503), because production better-auth rate limiting is fail-closed
 * on Redis; an UNCONFIGURED Redis (env unset / placeholder) reports
 * `"not-configured"` and does NOT fail `ok`.
 *
 * `@/lib/db` is mocked BEFORE the handler is imported — the real module opens a
 * Postgres connection at module load. `mock.module` is process-global, so this
 * file only stubs `@/lib/db` (already stubbed by most route tests) and leaves
 * `drizzle-orm` real (its `sql` tagged template needs no connection).
 */
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";

/** Flipped per test to exercise the DB-down path without re-mocking. */
let dbShouldFail = false;

mock.module("@/lib/db", () => ({
	db: {
		execute: async () => {
			if (dbShouldFail) throw new Error("db down");
			return [{ "?column?": 1 }];
		},
	},
}));

const { GET } = await import("../route");

const REAL_URL = "https://real-upstash.example.upstash.io";
const REAL_TOKEN = "AX_realtokenvalue";

const originalFetch = globalThis.fetch;
const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;

/** Records fetch calls so tests can assert the probe was (or wasn't) made. */
let fetchCalls: { url: string; init?: RequestInit }[] = [];

/** Install a fake global fetch that returns `impl` for the Upstash PING. */
function stubFetch(
	impl: (url: string, init?: RequestInit) => Promise<Response> | Response,
): void {
	globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
		const url = typeof input === "string" ? input : String(input);
		fetchCalls.push({ url, init });
		return impl(url, init);
	}) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

beforeEach(() => {
	dbShouldFail = false;
	fetchCalls = [];
	process.env.UPSTASH_REDIS_REST_URL = REAL_URL;
	process.env.UPSTASH_REDIS_REST_TOKEN = REAL_TOKEN;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

afterAll(() => {
	// Restore the env exactly as we found it (unset vs. set both preserved).
	if (originalUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
	else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
	if (originalToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
	else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
});

test("redis reachable → redis:true, ok:true, 200", async () => {
	stubFetch(() => jsonResponse({ result: "PONG" }));

	const res = await GET();
	expect(res.status).toBe(200);
	const json = (await res.json()) as {
		ok: boolean;
		db: boolean;
		redis: unknown;
	};
	expect(json.redis).toBe(true);
	expect(json.db).toBe(true);
	expect(json.ok).toBe(true);

	// The probe hit the Upstash REST PING with a bearer token, no secret leaked
	// into the URL.
	expect(fetchCalls).toHaveLength(1);
	expect(fetchCalls[0].url).toBe(`${REAL_URL}/ping`);
	expect(fetchCalls[0].url).not.toContain(REAL_TOKEN);
	const auth = new Headers(fetchCalls[0].init?.headers).get("authorization");
	expect(auth).toBe(`Bearer ${REAL_TOKEN}`);
});

test("redis unreachable (fetch throws) → redis:false, ok:false, 503", async () => {
	stubFetch(() => {
		throw new Error("connect ECONNREFUSED 127.0.0.1:8079");
	});

	const res = await GET();
	expect(res.status).toBe(503);
	const json = (await res.json()) as { ok: boolean; redis: unknown };
	expect(json.redis).toBe(false);
	expect(json.ok).toBe(false);
});

test("redis configured but returns non-2xx → redis:false, ok:false, 503", async () => {
	stubFetch(() => jsonResponse({ error: "unauthorized" }, 401));

	const res = await GET();
	expect(res.status).toBe(503);
	const json = (await res.json()) as { ok: boolean; redis: unknown };
	expect(json.redis).toBe(false);
	expect(json.ok).toBe(false);
});

test("redis env unset → redis:'not-configured', ok:true, 200, no probe made", async () => {
	delete process.env.UPSTASH_REDIS_REST_URL;
	delete process.env.UPSTASH_REDIS_REST_TOKEN;
	stubFetch(() => jsonResponse({ result: "PONG" }));

	const res = await GET();
	expect(res.status).toBe(200);
	const json = (await res.json()) as { ok: boolean; redis: unknown };
	expect(json.redis).toBe("not-configured");
	expect(json.ok).toBe(true);
	// No network probe when unconfigured.
	expect(fetchCalls).toHaveLength(0);
});

test("redis placeholder env (dev default) → 'not-configured', ok:true, no probe", async () => {
	process.env.UPSTASH_REDIS_REST_URL = "http://localhost:8079";
	process.env.UPSTASH_REDIS_REST_TOKEN = "example_token";
	stubFetch(() => jsonResponse({ result: "PONG" }));

	const res = await GET();
	expect(res.status).toBe(200);
	const json = (await res.json()) as { redis: unknown; ok: boolean };
	expect(json.redis).toBe("not-configured");
	expect(json.ok).toBe(true);
	expect(fetchCalls).toHaveLength(0);
});

test("db down still fails ok even when redis is reachable", async () => {
	dbShouldFail = true;
	stubFetch(() => jsonResponse({ result: "PONG" }));

	const res = await GET();
	expect(res.status).toBe(503);
	const json = (await res.json()) as {
		ok: boolean;
		db: boolean;
		redis: unknown;
	};
	expect(json.db).toBe(false);
	expect(json.redis).toBe(true);
	expect(json.ok).toBe(false);
});

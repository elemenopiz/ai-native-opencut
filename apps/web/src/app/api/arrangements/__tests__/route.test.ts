/**
 * Abuse limiting on the anonymous arrangement publish endpoint. POST
 * /api/arrangements is deliberately unauthenticated (no-login-to-try posture)
 * and inserts a Postgres row per call, so it must be rate limited per IP and
 * must cap the raw body it is willing to parse.
 *
 * This drives the REAL `POST` handler with a fake db and the REAL rate-limit
 * module: the process-wide limiter singleton is replaced with a fresh
 * `InMemoryRateLimiter` before each test so counters never leak between tests.
 *
 * Modules are mocked BEFORE the handler is imported (`@/lib/db` opens a
 * Postgres connection at module load).
 */
import { beforeEach, expect, mock, test } from "bun:test";

/** Rows the fake db "inserted" — lets tests assert a publish actually landed. */
const inserted: Record<string, unknown>[] = [];

mock.module("@/lib/db", () => ({
	db: {
		insert: () => ({
			values: async (row: Record<string, unknown>) => {
				inserted.push(row);
			},
		}),
	},
}));

// Load the REAL rate-limit implementation, immune to cross-file mock leakage.
// Bun's `mock.module` registry is process-global and keyed by RESOLVED module
// path, and other test files (studio/__tests__/credit-metering.test.ts,
// llm/agent/__tests__/route.test.ts) no-op "@/lib/rate-limit" for their own
// routes — in a full-suite run those mocks leak here, so importing the alias
// (or even a plain relative path — same resolved module) would hand us the
// leaked no-op. The query string resolves to a DISTINCT module entry that
// bypasses the mock registry while loading the same real source. The `as
// string` cast keeps tsc from trying to resolve the query-suffixed specifier.
const realRateLimit = (await import(
	"../../../../lib/rate-limit.ts?real" as string
)) as typeof import("@/lib/rate-limit");

// Re-pin the alias to the real implementation, so the route under test sees
// real rate limiting even when another file's no-op mock leaked in first.
// Pass-through of the real exports, nothing stubbed.
mock.module("@/lib/rate-limit", () => ({ ...realRateLimit }));

const { InMemoryRateLimiter, RATE_LIMITS } = realRateLimit;
const { POST } = await import("../route");

const PUBLISH_BURST = RATE_LIMITS["arrangements:publish"].perMinute;

/** A minimal arrangement the validator accepts. */
function validBody(): unknown {
	return {
		arrangement: {
			name: "Test arrangement",
			totalDuration: 5,
			slots: [{ id: "slot-1", kind: "video", startTime: 0, duration: 5 }],
			overlays: [],
		},
	};
}

function makeReq(body: string, ip = "203.0.113.7"): Request {
	return new Request("http://localhost/api/arrangements", {
		method: "POST",
		body,
		headers: {
			"content-type": "application/json",
			"x-forwarded-for": ip,
		},
	});
}

beforeEach(() => {
	// Fresh in-memory limiter per test: reset the process-wide singleton that
	// `enforceRateLimit` reads (cached on globalThis, see lib/rate-limit.ts).
	(
		globalThis as {
			__byornRateLimiter?: InstanceType<typeof InMemoryRateLimiter>;
		}
	).__byornRateLimiter = new InMemoryRateLimiter();
	inserted.length = 0;
});

test("a valid publish succeeds and inserts one row", async () => {
	const res = await POST(makeReq(JSON.stringify(validBody())));

	expect(res.status).toBe(200);
	const json = (await res.json()) as { id: string };
	expect(typeof json.id).toBe("string");
	expect(json.id.length).toBeGreaterThan(0);
	expect(inserted).toHaveLength(1);
	expect(inserted[0].id).toBe(json.id);
});

test("the request after the burst limit is 429 and does NOT insert", async () => {
	// The first `perMinute` publishes from one IP pass...
	for (let i = 0; i < PUBLISH_BURST; i++) {
		const res = await POST(makeReq(JSON.stringify(validBody())));
		expect(res.status).toBe(200);
	}

	// ...and the next one is rejected before touching the db.
	const overflow = await POST(makeReq(JSON.stringify(validBody())));
	expect(overflow.status).toBe(429);
	expect(overflow.headers.get("Retry-After")).toBe("60");
	expect(inserted).toHaveLength(PUBLISH_BURST);

	// Keys are per IP: a different caller is not affected by the exhausted one.
	const other = await POST(
		makeReq(JSON.stringify(validBody()), "198.51.100.9"),
	);
	expect(other.status).toBe(200);
});

test("an oversized body is rejected with 413 before parsing", async () => {
	const huge = JSON.stringify({
		arrangement: { name: "big", description: "x".repeat(512 * 1024) },
	});
	const res = await POST(makeReq(huge));
	expect(res.status).toBe(413);
	expect(inserted).toHaveLength(0);
});

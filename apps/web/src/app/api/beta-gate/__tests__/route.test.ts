import { afterAll, describe, expect, it, mock } from "bun:test";

/**
 * BUG26 regression: POST /api/beta-gate compared the submitted code with a
 * plain `!==`, a non-constant-time comparison. The fix (constantTimeEquals in
 * route.ts) uses node:crypto's timingSafeEqual with a length pre-check (it
 * throws on unequal-length buffers). This suite pins the code-check contract
 * end to end: correct code still succeeds, wrong codes of both matching and
 * differing length still 401 (proving the length guard doesn't throw), and
 * the trim-before-compare behavior is preserved.
 *
 * BETA_ACCESS_CODE is set BEFORE the route is dynamically imported so
 * `betaAccessCode()` (module-level env read, called per-request — see
 * lib/beta-gate.ts) picks it up. Snapshot + restore in afterAll, same
 * convention as credit-metering.test.ts / route-protection.test.ts.
 *
 * `@/lib/rate-limit` is mocked to a no-op — same pattern as
 * studio/audio/__tests__/route.test.ts and telemetry/__tests__/verb-route.test.ts
 * — because bun's `mock.module` is process-global and the real limiter would
 * otherwise make this suite's 5 requests order-dependent with any other test
 * file hitting the "beta:gate" bucket in the same run.
 */

const TEST_CODE = "9999";
const prevBetaCode = process.env.BETA_ACCESS_CODE;
process.env.BETA_ACCESS_CODE = TEST_CODE;

const realRateLimit = { ...(await import("@/lib/rate-limit")) };
mock.module("@/lib/rate-limit", () => ({
	...realRateLimit,
	enforceRateLimit: async () => null,
}));
afterAll(() => {
	mock.module("@/lib/rate-limit", () => realRateLimit);
	if (prevBetaCode === undefined) {
		delete process.env.BETA_ACCESS_CODE;
	} else {
		process.env.BETA_ACCESS_CODE = prevBetaCode;
	}
});

const { POST } = await import("../route");
const { BETA_COOKIE } = await import("@/lib/beta-gate");

function makeRequest(code: unknown): Request {
	return new Request("http://localhost:3000/api/beta-gate", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ code }),
	});
}

describe("POST /api/beta-gate", () => {
	it("correct code → 200 { ok: true } and sets the beta cookie", async () => {
		const res = await POST(makeRequest(TEST_CODE));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		const setCookie = res.headers.get("set-cookie") ?? "";
		expect(setCookie).toContain(`${BETA_COOKIE}=`);
	});

	it("wrong code of the SAME length → 401 invalid_code", async () => {
		// Same length as TEST_CODE ("9999") but different bytes.
		const res = await POST(makeRequest("1234"));
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "invalid_code" });
	});

	it("wrong code of a DIFFERENT length → 401 invalid_code (length guard doesn't throw)", async () => {
		const res = await POST(makeRequest("12345678"));
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "invalid_code" });
	});

	it("missing code → 401 invalid_code", async () => {
		const res = await POST(makeRequest(undefined));
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "invalid_code" });
	});

	it("empty code → 401 invalid_code", async () => {
		const res = await POST(makeRequest(""));
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "invalid_code" });
	});

	it("whitespace-padded correct code → 200 (trim preserved)", async () => {
		const res = await POST(makeRequest(` ${TEST_CODE} `));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});
});

import { afterEach, describe, expect, it } from "bun:test";
import { GET } from "../route";

/**
 * Regression for the Pexels per_page/page NaN guard (commit 207a65d).
 * `Number("abc")` was reaching the Pexels API as the literal string "NaN".
 * The guard must floor to an integer, fall back to defaults on non-finite
 * input, and clamp per_page to [1,30] and page to >=1. We assert on the exact
 * query string the handler sends to `fetch`.
 */

const ORIGINAL_FETCH = globalThis.fetch;

function mockFetch(): () => URLSearchParams {
	let captured: URLSearchParams | undefined;
	globalThis.fetch = (async (url: string) => {
		captured = new URL(url).searchParams;
		return new Response(JSON.stringify({ photos: [], total_results: 0 }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
	return () => {
		if (!captured) throw new Error("fetch was not called");
		return captured;
	};
}

function call(qs: string) {
	// A minimal NextRequest stand-in: the handler only reads `.url` and headers.
	return GET({
		url: `http://localhost/api/images/search?${qs}`,
		headers: new Headers({ "x-pexels-api-key": "test-key" }),
	} as unknown as Parameters<typeof GET>[0]);
}

afterEach(() => {
	globalThis.fetch = ORIGINAL_FETCH;
});

describe("Pexels search — per_page/page NaN guard", () => {
	it("falls back to defaults (per_page=6, page=1) on non-numeric input", async () => {
		const params = mockFetch();
		await call("q=cats&per_page=abc&page=xyz");
		expect(params().get("per_page")).toBe("6");
		expect(params().get("page")).toBe("1");
		// Never the literal 'NaN' string that broke the upstream call.
		expect(params().get("per_page")).not.toBe("NaN");
		expect(params().get("page")).not.toBe("NaN");
	});

	it("floors fractional per_page/page to integers", async () => {
		const params = mockFetch();
		await call("q=cats&per_page=12.9&page=3.7");
		expect(params().get("per_page")).toBe("12");
		expect(params().get("page")).toBe("3");
	});

	it("clamps per_page into [1,30] and page to >=1", async () => {
		const params = mockFetch();
		await call("q=cats&per_page=999&page=-5");
		expect(params().get("per_page")).toBe("30");
		expect(params().get("page")).toBe("1");
	});

	it("raises per_page below 1 up to the minimum of 1", async () => {
		const params = mockFetch();
		await call("q=cats&per_page=0");
		expect(params().get("per_page")).toBe("1");
	});

	it("passes valid values straight through", async () => {
		const params = mockFetch();
		await call("q=cats&per_page=15&page=2");
		expect(params().get("per_page")).toBe("15");
		expect(params().get("page")).toBe("2");
	});

	it("still rejects an empty query before hitting the guard/fetch", async () => {
		globalThis.fetch = (async () => {
			throw new Error("fetch should not be called for an empty query");
		}) as unknown as typeof fetch;
		const res = await call("per_page=abc");
		expect(res.status).toBe(400);
	});
});

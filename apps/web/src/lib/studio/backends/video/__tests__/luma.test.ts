/**
 * Luma Ray 2 adapter — proves billing and submission resolve the SAME duration.
 * Ray-2 renders only 5s or 9s, so `submit` snaps the requested duration and
 * `estimateCost` must bill that same snapped length. This mismatch is
 * BIDIRECTIONAL: 6–7s snaps DOWN to 5s (user was overbilled) while 8s snaps UP
 * to 9s (Byorn's margin was eaten) — both are corrected here.
 *
 * Mocks only `global.fetch` (captured/restored in `afterEach`; see the leak
 * gotcha in `google-veo.test.ts`) and toggles `webEnv.LUMA_API_KEY` directly.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { webEnv } from "@byorn/env/web";
import { costFor } from "@/lib/credits/cost-table";
import { lumaBackend } from "../luma";

const originalFetch = globalThis.fetch;
const originalKey = webEnv.LUMA_API_KEY;
const originalBase = webEnv.LUMA_BASE_URL;

afterEach(() => {
	globalThis.fetch = originalFetch;
	webEnv.LUMA_API_KEY = originalKey;
	webEnv.LUMA_BASE_URL = originalBase;
});

/** Stub Luma's generations endpoint and hand the submitted body back. */
function stubFetch(onBody: (body: Record<string, unknown>) => void) {
	globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
		onBody(JSON.parse((init?.body as string) ?? "{}"));
		return new Response(JSON.stringify({ id: "gen-1", state: "queued" }), {
			status: 200,
		});
	}) as unknown as typeof fetch;
}

describe("lumaBackend.estimateCost — bills the duration Ray-2 actually renders", () => {
	it("bills a 6s request as the snapped-DOWN 5s (fixes the overcharge)", () => {
		const est = lumaBackend.estimateCost({
			modality: "video",
			prompt: "x",
			duration: 6,
		});
		expect(est.credits).toBe(costFor("luma-ray", "video", { seconds: 5 }));
		// The bug billed the raw 6s — MORE than the 5s Ray-2 actually renders.
		expect(est.credits).toBeLessThan(
			costFor("luma-ray", "video", { seconds: 6 }),
		);
		expect(est.basis).toMatch(/× 5s/);
	});

	it("bills an 8s request as the snapped-UP 9s (fixes the eaten margin)", () => {
		const est = lumaBackend.estimateCost({
			modality: "video",
			prompt: "x",
			duration: 8,
		});
		expect(est.credits).toBe(costFor("luma-ray", "video", { seconds: 9 }));
		// The bug billed the raw 8s — LESS than the 9s Ray-2 actually renders.
		expect(est.credits).toBeGreaterThan(
			costFor("luma-ray", "video", { seconds: 8 }),
		);
		expect(est.basis).toMatch(/× 9s/);
	});
});

describe("lumaBackend.submit — sends the same snapped duration it bills", () => {
	it("submits duration '5s' for a 6s request", async () => {
		webEnv.LUMA_API_KEY = "luma-key";
		let body: Record<string, unknown> = {};
		stubFetch((b) => {
			body = b;
		});
		await lumaBackend.submit({ modality: "video", prompt: "x", duration: 6 });
		expect(body.duration).toBe("5s");
	});

	it("submits duration '9s' for an 8s request", async () => {
		webEnv.LUMA_API_KEY = "luma-key";
		let body: Record<string, unknown> = {};
		stubFetch((b) => {
			body = b;
		});
		await lumaBackend.submit({ modality: "video", prompt: "x", duration: 8 });
		expect(body.duration).toBe("9s");
	});
});

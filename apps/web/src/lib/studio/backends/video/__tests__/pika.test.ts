/**
 * Pika adapter — proves billing and submission resolve the SAME duration.
 * Pika 2.2 (via fal.ai) renders only discrete 5s or 10s clips, so `submit` snaps
 * the requested duration and `estimateCost` must bill that same snapped length.
 *
 * Mocks only `global.fetch` (captured/restored in `afterEach`; see the leak
 * gotcha in `google-veo.test.ts`) and toggles `webEnv.FAL_KEY` directly.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { webEnv } from "@byorn/env/web";
import { costFor } from "@/lib/credits/cost-table";
import { pikaBackend } from "../pika";

const originalFetch = globalThis.fetch;
const originalKey = webEnv.FAL_KEY;
const originalBase = webEnv.FAL_BASE_URL;

afterEach(() => {
	globalThis.fetch = originalFetch;
	webEnv.FAL_KEY = originalKey;
	webEnv.FAL_BASE_URL = originalBase;
});

/** Stub fal's queue-submit endpoint and hand the submitted input back. */
function stubFetch(onBody: (body: Record<string, unknown>) => void) {
	globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
		onBody(JSON.parse((init?.body as string) ?? "{}"));
		return new Response(JSON.stringify({ request_id: "req-1" }), {
			status: 200,
		});
	}) as unknown as typeof fetch;
}

describe("pikaBackend.estimateCost — bills the duration Pika actually renders", () => {
	it("bills a 6s request as the snapped 10s (Pika has no 6s)", () => {
		const est = pikaBackend.estimateCost({
			modality: "video",
			prompt: "x",
			duration: 6,
		});
		expect(est.credits).toBe(costFor("pika", "video", { seconds: 10 }));
		expect(est.credits).toBeGreaterThan(
			costFor("pika", "video", { seconds: 6 }),
		);
		expect(est.basis).toMatch(/× 10s/);
	});

	it("bills a 5s request as 5s", () => {
		const est = pikaBackend.estimateCost({
			modality: "video",
			prompt: "x",
			duration: 5,
		});
		expect(est.credits).toBe(costFor("pika", "video", { seconds: 5 }));
		expect(est.basis).toMatch(/× 5s/);
	});
});

describe("pikaBackend.submit — sends the same snapped duration it bills", () => {
	it("submits duration 10 for a 6s request", async () => {
		webEnv.FAL_KEY = "fal-key";
		let body: Record<string, unknown> = {};
		stubFetch((b) => {
			body = b;
		});
		await pikaBackend.submit({ modality: "video", prompt: "x", duration: 6 });
		expect(body.duration).toBe(10);
	});

	it("submits duration 5 for a 5s request", async () => {
		webEnv.FAL_KEY = "fal-key";
		let body: Record<string, unknown> = {};
		stubFetch((b) => {
			body = b;
		});
		await pikaBackend.submit({ modality: "video", prompt: "x", duration: 5 });
		expect(body.duration).toBe(5);
	});
});

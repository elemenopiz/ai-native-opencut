/**
 * Runway adapter — proves billing and submission resolve the SAME duration.
 * Runway renders only discrete 5s or 10s clips, so `submit` snaps the requested
 * duration and `estimateCost` must bill that same snapped length.
 *
 * Mocks only `global.fetch` (captured/restored in `afterEach`; see the leak
 * gotcha in `google-veo.test.ts`) and toggles `webEnv.RUNWAY_API_KEY` directly.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { webEnv } from "@byorn/env/web";
import { costFor } from "@/lib/credits/cost-table";
import { runwayBackend } from "../runway";

const originalFetch = globalThis.fetch;
const originalKey = webEnv.RUNWAY_API_KEY;
const originalBase = webEnv.RUNWAY_BASE_URL;

afterEach(() => {
	globalThis.fetch = originalFetch;
	webEnv.RUNWAY_API_KEY = originalKey;
	webEnv.RUNWAY_BASE_URL = originalBase;
});

/** Stub Runway's task-submit endpoint and hand the submitted body back. */
function stubFetch(onBody: (body: Record<string, unknown>) => void) {
	globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
		onBody(JSON.parse((init?.body as string) ?? "{}"));
		return new Response(JSON.stringify({ id: "task-1", status: "PENDING" }), {
			status: 200,
		});
	}) as unknown as typeof fetch;
}

describe("runwayBackend.estimateCost — bills the duration Runway actually renders", () => {
	it("bills a 6s request as the snapped 10s (Runway has no 6s)", () => {
		const est = runwayBackend.estimateCost({
			modality: "video",
			prompt: "x",
			duration: 6,
		});
		expect(est.credits).toBe(costFor("runway", "video", { seconds: 10 }));
		expect(est.credits).toBeGreaterThan(
			costFor("runway", "video", { seconds: 6 }),
		);
		expect(est.basis).toMatch(/× 10s/);
	});

	it("bills a 5s request as 5s", () => {
		const est = runwayBackend.estimateCost({
			modality: "video",
			prompt: "x",
			duration: 5,
		});
		expect(est.credits).toBe(costFor("runway", "video", { seconds: 5 }));
		expect(est.basis).toMatch(/× 5s/);
	});
});

describe("runwayBackend.submit — sends the same snapped duration it bills", () => {
	it("submits duration 10 for a 6s request", async () => {
		webEnv.RUNWAY_API_KEY = "rw-key";
		let body: Record<string, unknown> = {};
		stubFetch((b) => {
			body = b;
		});
		await runwayBackend.submit({ modality: "video", prompt: "x", duration: 6 });
		expect(body.duration).toBe(10);
	});

	it("submits duration 5 for a 5s request", async () => {
		webEnv.RUNWAY_API_KEY = "rw-key";
		let body: Record<string, unknown> = {};
		stubFetch((b) => {
			body = b;
		});
		await runwayBackend.submit({ modality: "video", prompt: "x", duration: 5 });
		expect(body.duration).toBe(5);
	});
});

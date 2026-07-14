/**
 * Kling adapter — proves billing and submission resolve the SAME duration.
 * Kling v1/v1.6 render only discrete 5s or 10s clips, so `submit` snaps the
 * requested duration; `estimateCost` must bill that same snapped length, not the
 * raw request (the money bug this file guards against).
 *
 * Mocks only `global.fetch` (captured/restored in `afterEach` — `mock.restore()`
 * does NOT undo a direct property assignment, so the stub would otherwise leak
 * process-globally; same gotcha documented in `google-veo.test.ts`) and toggles
 * `webEnv` keys directly.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { webEnv } from "@byorn/env/web";
import { costFor } from "@/lib/credits/cost-table";
import { klingBackend } from "../kling";

const originalFetch = globalThis.fetch;
const originalAccess = webEnv.KLING_ACCESS_KEY;
const originalSecret = webEnv.KLING_SECRET_KEY;
const originalBase = webEnv.KLING_BASE_URL;

afterEach(() => {
	globalThis.fetch = originalFetch;
	webEnv.KLING_ACCESS_KEY = originalAccess;
	webEnv.KLING_SECRET_KEY = originalSecret;
	webEnv.KLING_BASE_URL = originalBase;
});

/** Stub Kling's task endpoint and hand the submitted body back to the caller. */
function stubFetch(onBody: (body: Record<string, unknown>) => void) {
	globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
		onBody(JSON.parse((init?.body as string) ?? "{}"));
		return new Response(
			JSON.stringify({
				code: 0,
				data: { task_id: "task-1", task_status: "submitted" },
			}),
			{ status: 200 },
		);
	}) as unknown as typeof fetch;
}

describe("klingBackend.estimateCost — bills the duration Kling actually renders", () => {
	it("bills a 6s request as the snapped 10s (Kling has no 6s)", () => {
		const est = klingBackend.estimateCost({
			modality: "video",
			prompt: "x",
			duration: 6,
		});
		expect(est.credits).toBe(costFor("kling", "video", { seconds: 10 }));
		// The bug billed the raw 6s — strictly cheaper than the 10s Kling renders.
		expect(est.credits).toBeGreaterThan(
			costFor("kling", "video", { seconds: 6 }),
		);
		expect(est.basis).toMatch(/× 10s/);
	});

	it("bills a 5s request as 5s", () => {
		const est = klingBackend.estimateCost({
			modality: "video",
			prompt: "x",
			duration: 5,
		});
		expect(est.credits).toBe(costFor("kling", "video", { seconds: 5 }));
		expect(est.basis).toMatch(/× 5s/);
	});
});

describe("klingBackend.submit — sends the same snapped duration it bills", () => {
	it("submits duration '10' for a 6s request", async () => {
		webEnv.KLING_ACCESS_KEY = "ak";
		webEnv.KLING_SECRET_KEY = "sk";
		let body: Record<string, unknown> = {};
		stubFetch((b) => {
			body = b;
		});
		await klingBackend.submit({ modality: "video", prompt: "x", duration: 6 });
		expect(body.duration).toBe("10");
	});

	it("submits duration '5' for a 5s request", async () => {
		webEnv.KLING_ACCESS_KEY = "ak";
		webEnv.KLING_SECRET_KEY = "sk";
		let body: Record<string, unknown> = {};
		stubFetch((b) => {
			body = b;
		});
		await klingBackend.submit({ modality: "video", prompt: "x", duration: 5 });
		expect(body.duration).toBe("5");
	});
});

/**
 * MMAudio V2 adapter — mocks only `global.fetch` (real fal.ai queue REST
 * shape: submit at the model's base path, poll at `/requests/{id}/status`,
 * fetch the result at `/requests/{id}`) and toggles `webEnv.FAL_KEY` directly
 * (a plain mutable object, no `mock.module` needed).
 *
 * `global.fetch` is captured/restored in `afterEach` — `mock.restore()` alone
 * does NOT undo a direct property assignment, so without this the stub leaks
 * process-globally to every later test file (bun shares one process; see the
 * known gotcha documented in `agent-streaming.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { webEnv } from "@byorn/env/web";
import { falMmaudioBackend } from "../fal-mmaudio";

const originalFetch = globalThis.fetch;
const originalKey = webEnv.FAL_KEY;
const originalBase = webEnv.FAL_BASE_URL;

afterEach(() => {
	globalThis.fetch = originalFetch;
	webEnv.FAL_KEY = originalKey;
	webEnv.FAL_BASE_URL = originalBase;
});

describe("falMmaudioBackend — availability", () => {
	it("is inert (isAvailable false) without FAL_KEY", () => {
		webEnv.FAL_KEY = "";
		expect(falMmaudioBackend.isAvailable()).toBe(false);
	});

	it("is available once FAL_KEY is set", () => {
		webEnv.FAL_KEY = "test-fal-key";
		expect(falMmaudioBackend.isAvailable()).toBe(true);
	});
});

describe("falMmaudioBackend — capabilities", () => {
	it("declares video-score intent and requiresVideoRef", () => {
		expect(falMmaudioBackend.capabilities.intents).toEqual(["video-score"]);
		expect(falMmaudioBackend.capabilities.requiresVideoRef).toBe(true);
		expect(falMmaudioBackend.capabilities.durationRangeSec).toEqual({
			min: 1,
			max: 30,
		});
	});
});

describe("falMmaudioBackend.submit", () => {
	beforeEach(() => {
		webEnv.FAL_KEY = "test-fal-key";
	});

	it("fails without dispatching a fetch when no source video is supplied", async () => {
		let fetchCalled = false;
		globalThis.fetch = (async () => {
			fetchCalled = true;
			return new Response("{}");
		}) as unknown as typeof fetch;

		const result = await falMmaudioBackend.submit({
			modality: "audio",
			prompt: "rainfall ambience",
		});

		expect(result.status).toBe("failed");
		expect(result.error).toMatch(/source video/i);
		expect(fetchCalled).toBe(false);
	});

	it("posts video_url/prompt/duration/seed to the fal queue base path and returns a pending job", async () => {
		let capturedUrl = "";
		let capturedBody: Record<string, unknown> = {};
		let capturedAuth = "";
		globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
			capturedUrl = String(url);
			capturedBody = JSON.parse(init?.body as string);
			capturedAuth = (init?.headers as Record<string, string>).Authorization;
			return new Response(JSON.stringify({ request_id: "req-1" }), {
				status: 200,
			});
		}) as unknown as typeof fetch;

		const result = await falMmaudioBackend.submit({
			modality: "audio",
			prompt: "rainfall ambience, distant thunder",
			referenceVideos: ["https://cdn.example/span.mp4"],
			duration: 12,
			seed: 42,
		});

		expect(capturedUrl).toBe("https://queue.fal.run/fal-ai/mmaudio-v2");
		expect(capturedAuth).toBe("Key test-fal-key");
		expect(capturedBody).toMatchObject({
			video_url: "https://cdn.example/span.mp4",
			prompt: "rainfall ambience, distant thunder",
			duration: 12,
			seed: 42,
		});
		expect(result).toEqual({ jobId: "req-1", status: "pending" });
	});

	it("clamps an out-of-range duration to the documented 30s max", async () => {
		let capturedBody: Record<string, unknown> = {};
		globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
			capturedBody = JSON.parse(init?.body as string);
			return new Response(JSON.stringify({ request_id: "req-2" }), {
				status: 200,
			});
		}) as unknown as typeof fetch;

		await falMmaudioBackend.submit({
			modality: "audio",
			prompt: "x",
			referenceVideos: ["https://cdn.example/span.mp4"],
			duration: 999,
		});

		expect(capturedBody.duration).toBe(30);
	});

	it("returns a failed SubmitResult (never throws) on a provider error", async () => {
		globalThis.fetch = (async () =>
			new Response("nope", { status: 500 })) as unknown as typeof fetch;

		const result = await falMmaudioBackend.submit({
			modality: "audio",
			prompt: "x",
			referenceVideos: ["https://cdn.example/span.mp4"],
		});

		expect(result.status).toBe("failed");
		expect(result.error).toMatch(/500/);
	});

	it("returns failed with a clear message when FAL_KEY is unset", async () => {
		webEnv.FAL_KEY = "";
		const result = await falMmaudioBackend.submit({
			modality: "audio",
			prompt: "x",
			referenceVideos: ["https://cdn.example/span.mp4"],
		});
		expect(result.status).toBe("failed");
		expect(result.error).toMatch(/FAL_KEY/);
	});
});

describe("falMmaudioBackend.poll", () => {
	beforeEach(() => {
		webEnv.FAL_KEY = "test-fal-key";
	});

	it("maps IN_PROGRESS to processing without fetching the result", async () => {
		let resultFetched = false;
		globalThis.fetch = (async (url: string | URL) => {
			if (String(url).endsWith("/status")) {
				return new Response(JSON.stringify({ status: "IN_PROGRESS" }), {
					status: 200,
				});
			}
			resultFetched = true;
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch;

		const result = await falMmaudioBackend.poll("req-1");
		expect(result.status).toBe("processing");
		expect(resultFetched).toBe(false);
	});

	it("fetches the result and returns the muxed video URL on COMPLETED", async () => {
		globalThis.fetch = (async (url: string | URL) => {
			if (String(url).endsWith("/status")) {
				return new Response(JSON.stringify({ status: "COMPLETED" }), {
					status: 200,
				});
			}
			return new Response(
				JSON.stringify({ video: { url: "https://cdn.example/scored.mp4" } }),
				{ status: 200 },
			);
		}) as unknown as typeof fetch;

		const result = await falMmaudioBackend.poll("req-1");
		expect(result.status).toBe("completed");
		expect(result.mediaUrl).toBe("https://cdn.example/scored.mp4");
	});

	it("maps ERROR to failed", async () => {
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({ status: "ERROR", error: "moderation blocked" }),
				{ status: 200 },
			)) as unknown as typeof fetch;

		const result = await falMmaudioBackend.poll("req-1");
		expect(result.status).toBe("failed");
		expect(result.error).toBe("moderation blocked");
	});
});

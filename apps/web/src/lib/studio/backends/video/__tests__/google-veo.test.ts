/**
 * Google Veo 3.1 (Standard + Fast) adapters — mocks only `global.fetch`
 * (real Gemini API LRO shape: submit at `/models/{model}:predictLongRunning`,
 * poll at `/{operationName}`) and toggles `webEnv.GEMINI_API_KEY`/
 * `GEMINI_VEO_MODEL`/`GEMINI_VEO_FAST_MODEL` directly (plain mutable object,
 * no `mock.module` needed).
 *
 * `global.fetch` is captured/restored in `afterEach` — `mock.restore()` alone
 * does NOT undo a direct property assignment, so without this the stub leaks
 * process-globally to every later test file (bun shares one process; see the
 * known gotcha documented in `agent-streaming.test.ts` and mirrored in the
 * `fal-mmaudio.test.ts` audio adapter tests).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { webEnv } from "@byorn/env/web";
import { costFor } from "@/lib/credits/cost-table";
import { googleVeoBackend } from "../google-veo";
import { googleVeoFastBackend } from "../google-veo-fast";

const originalFetch = globalThis.fetch;
const originalKey = webEnv.GEMINI_API_KEY;
const originalBase = webEnv.GEMINI_BASE_URL;
const originalModel = webEnv.GEMINI_VEO_MODEL;
const originalFastModel = webEnv.GEMINI_VEO_FAST_MODEL;

afterEach(() => {
	globalThis.fetch = originalFetch;
	webEnv.GEMINI_API_KEY = originalKey;
	webEnv.GEMINI_BASE_URL = originalBase;
	webEnv.GEMINI_VEO_MODEL = originalModel;
	webEnv.GEMINI_VEO_FAST_MODEL = originalFastModel;
});

/** A fetch stub that routes Gemini API calls to `onApi` and treats every
 *  other URL as a reference-media download (returns tiny binary bytes). */
function stubFetch(
	onApi: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
	globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
		const u = String(url);
		if (u.includes("generativelanguage.googleapis.com")) {
			return onApi(u, init);
		}
		// Reference-image download.
		return new Response(new Uint8Array([1, 2, 3]), {
			status: 200,
			headers: { "content-type": "image/png" },
		});
	}) as unknown as typeof fetch;
}

describe("googleVeoBackend — availability", () => {
	it("is inert without GEMINI_API_KEY", () => {
		webEnv.GEMINI_API_KEY = "";
		expect(googleVeoBackend.isAvailable()).toBe(false);
		expect(googleVeoFastBackend.isAvailable()).toBe(false);
	});

	it("is available once GEMINI_API_KEY is set (shared by both tiers)", () => {
		webEnv.GEMINI_API_KEY = "test-gemini-key";
		expect(googleVeoBackend.isAvailable()).toBe(true);
		expect(googleVeoFastBackend.isAvailable()).toBe(true);
	});
});

describe("googleVeoBackend — capabilities", () => {
	it("declares video intents, no seed-lock, but reference + last-frame support", () => {
		expect(googleVeoBackend.capabilities.supportsSeedLock).toBe(false);
		expect(googleVeoBackend.capabilities.supportsOmniReference).toBe(true);
		expect(googleVeoBackend.capabilities.supportsLastFrame).toBe(true);
		expect(googleVeoBackend.capabilities.intents).toEqual([
			"character-video",
			"broll-video",
		]);
	});

	it("does not expose the 4k tier through the shared VideoResolution union", () => {
		expect(googleVeoBackend.capabilities.resolutions).toEqual([
			"720p",
			"1080p",
		]);
		expect(googleVeoFastBackend.capabilities.resolutions).toEqual([
			"720p",
			"1080p",
		]);
	});
});

describe("googleVeoBackend.estimateCost / googleVeoFastBackend.estimateCost", () => {
	it("prices Standard well above Fast for the same duration (sourced from cost-table)", () => {
		const standard = googleVeoBackend.estimateCost({
			modality: "video",
			prompt: "x",
			duration: 5,
		});
		const fast = googleVeoFastBackend.estimateCost({
			modality: "video",
			prompt: "x",
			duration: 5,
		});
		expect(standard.credits).toBeGreaterThan(fast.credits);
		expect(standard.basis).toMatch(/native audio/i);
		expect(fast.basis).toMatch(/Fast/);
	});
});

describe("googleVeoBackend.estimateCost — bills the duration Veo actually renders", () => {
	// Regression guard for the billing/submit duration mismatch: submit() snaps
	// the requested duration to Veo's discrete 4/6/8s (and forces 8s at 1080p or
	// with reference images), so estimateCost() must bill that SAME resolved
	// length, not the raw request.
	it("bills a 1080p request for the forced 8s floor, not the requested 4s", () => {
		const est = googleVeoBackend.estimateCost({
			modality: "video",
			prompt: "x",
			duration: 4,
			resolution: "1080p",
		});
		expect(est.credits).toBe(
			costFor("google-veo", "video", { seconds: 8, resolution: "1080p" }),
		);
		// The old behavior billed the raw 4s — strictly cheaper than the 8s truth.
		expect(est.credits).toBeGreaterThan(
			costFor("google-veo", "video", { seconds: 4, resolution: "1080p" }),
		);
		expect(est.basis).toMatch(/× 8s/);
	});

	it("bills reference-conditioned requests for the forced 8s floor", () => {
		const est = googleVeoBackend.estimateCost({
			modality: "video",
			prompt: "x",
			duration: 4,
			referenceImages: ["https://cdn.example/a.png"],
		});
		expect(est.credits).toBe(
			costFor("google-veo", "video", { seconds: 8, resolution: undefined }),
		);
		expect(est.basis).toMatch(/× 8s/);
	});

	it("bills the nearest supported step for a plain 720p request (7s → 8s)", () => {
		const est = googleVeoBackend.estimateCost({
			modality: "video",
			prompt: "x",
			duration: 7,
		});
		expect(est.credits).toBe(costFor("google-veo", "video", { seconds: 8 }));
		expect(est.basis).toMatch(/× 8s/);
	});

	it("Fast tier applies the same resolution rule (1080p → 8s)", () => {
		const est = googleVeoFastBackend.estimateCost({
			modality: "video",
			prompt: "x",
			duration: 4,
			resolution: "1080p",
		});
		expect(est.credits).toBe(
			costFor("google-veo-fast", "video", { seconds: 8, resolution: "1080p" }),
		);
		expect(est.basis).toMatch(/× 8s/);
	});
});

describe("googleVeoBackend.submit", () => {
	beforeEach(() => {
		webEnv.GEMINI_API_KEY = "test-gemini-key";
	});

	it("posts to /models/{model}:predictLongRunning with the default model id", async () => {
		let capturedUrl = "";
		let capturedAuth = "";
		let capturedBody: Record<string, unknown> = {};
		stubFetch((url, init) => {
			capturedUrl = url;
			capturedAuth = (init?.headers as Record<string, string>)[
				"x-goog-api-key"
			];
			capturedBody = JSON.parse(init?.body as string);
			return new Response(
				JSON.stringify({
					name: "models/veo-3.1-generate-preview/operations/op-1",
				}),
				{ status: 200 },
			);
		});

		const result = await googleVeoBackend.submit({
			modality: "video",
			prompt: "a dog running on a beach",
			duration: 5,
			orientation: "landscape",
		});

		expect(capturedUrl).toBe(
			"https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-generate-preview:predictLongRunning",
		);
		expect(capturedAuth).toBe("test-gemini-key");
		expect(capturedBody).toMatchObject({
			instances: [{ prompt: "a dog running on a beach" }],
			parameters: {
				aspectRatio: "16:9",
				resolution: "720p",
				numberOfVideos: 1,
				personGeneration: "allow_all",
			},
		});
		expect(result).toEqual({
			jobId: "models/veo-3.1-generate-preview/operations/op-1",
			status: "processing",
		});
	});

	it("uses GEMINI_VEO_MODEL override when set", async () => {
		webEnv.GEMINI_VEO_MODEL = "veo-3.1-custom";
		let capturedUrl = "";
		stubFetch((url) => {
			capturedUrl = url;
			return new Response(JSON.stringify({ name: "op-1", done: true }), {
				status: 200,
			});
		});

		await googleVeoBackend.submit({ modality: "video", prompt: "x" });
		expect(capturedUrl).toContain("veo-3.1-custom:predictLongRunning");
	});

	it("forces durationSeconds to 8 and personGeneration to allow_adult for a 1080p request", async () => {
		let capturedBody: Record<string, unknown> = {};
		stubFetch((_url, init) => {
			capturedBody = JSON.parse(init?.body as string);
			return new Response(JSON.stringify({ name: "op-1" }), { status: 200 });
		});

		await googleVeoBackend.submit({
			modality: "video",
			prompt: "x",
			duration: 4,
			resolution: "1080p",
			mode: "image-to-video",
			referenceImageUrl: "https://cdn.example/frame.png",
		});

		const params = capturedBody.parameters as Record<string, unknown>;
		expect(params.durationSeconds).toBe("8");
		expect(params.resolution).toBe("1080p");
		expect(params.personGeneration).toBe("allow_adult");
		const instances = capturedBody.instances as Array<Record<string, unknown>>;
		expect(instances[0].image).toBeDefined();
	});

	it("caps referenceImages at 3 and marks the request as reference-conditioned", async () => {
		let capturedBody: Record<string, unknown> = {};
		stubFetch((_url, init) => {
			capturedBody = JSON.parse(init?.body as string);
			return new Response(JSON.stringify({ name: "op-1" }), { status: 200 });
		});

		await googleVeoBackend.submit({
			modality: "video",
			prompt: "x",
			referenceImages: [
				"https://cdn.example/a.png",
				"https://cdn.example/b.png",
				"https://cdn.example/c.png",
				"https://cdn.example/d.png",
			],
		});

		const instances = capturedBody.instances as Array<Record<string, unknown>>;
		const refs = instances[0].referenceImages as unknown[];
		expect(refs).toHaveLength(3);
		const params = capturedBody.parameters as Record<string, unknown>;
		expect(params.personGeneration).toBe("allow_adult");
		// Reference conditioning also forces the 8s duration floor.
		expect(params.durationSeconds).toBe("8");
	});

	it("returns a failed SubmitResult (never throws) on a provider error", async () => {
		stubFetch(() => new Response("nope", { status: 500 }));

		const result = await googleVeoBackend.submit({
			modality: "video",
			prompt: "x",
		});
		expect(result.status).toBe("failed");
		expect(result.error).toMatch(/500/);
	});

	it("returns failed with a clear message when GEMINI_API_KEY is unset", async () => {
		webEnv.GEMINI_API_KEY = "";
		const result = await googleVeoBackend.submit({
			modality: "video",
			prompt: "x",
		});
		expect(result.status).toBe("failed");
		expect(result.error).toMatch(/GEMINI_API_KEY/);
	});
});

describe("googleVeoFastBackend.submit", () => {
	beforeEach(() => {
		webEnv.GEMINI_API_KEY = "test-gemini-key";
	});

	it("posts to the Fast model id by default", async () => {
		let capturedUrl = "";
		stubFetch((url) => {
			capturedUrl = url;
			return new Response(JSON.stringify({ name: "op-1" }), { status: 200 });
		});

		await googleVeoFastBackend.submit({ modality: "video", prompt: "x" });
		expect(capturedUrl).toContain(
			"veo-3.1-fast-generate-preview:predictLongRunning",
		);
	});

	it("uses GEMINI_VEO_FAST_MODEL override when set", async () => {
		webEnv.GEMINI_VEO_FAST_MODEL = "veo-3.1-fast-custom";
		let capturedUrl = "";
		stubFetch((url) => {
			capturedUrl = url;
			return new Response(JSON.stringify({ name: "op-1" }), { status: 200 });
		});

		await googleVeoFastBackend.submit({ modality: "video", prompt: "x" });
		expect(capturedUrl).toContain("veo-3.1-fast-custom:predictLongRunning");
	});
});

describe("googleVeoBackend.poll", () => {
	beforeEach(() => {
		webEnv.GEMINI_API_KEY = "test-gemini-key";
	});

	it("maps done:false to processing", async () => {
		stubFetch(
			() =>
				new Response(JSON.stringify({ name: "op-1", done: false }), {
					status: 200,
				}),
		);
		const result = await googleVeoBackend.poll(
			"models/veo-3.1-generate-preview/operations/op-1",
		);
		expect(result.status).toBe("processing");
	});

	it("extracts the generated video URI on completion", async () => {
		stubFetch(
			() =>
				new Response(
					JSON.stringify({
						name: "op-1",
						done: true,
						response: {
							generateVideoResponse: {
								generatedSamples: [
									{ video: { uri: "https://cdn.example/veo-output.mp4" } },
								],
							},
						},
					}),
					{ status: 200 },
				),
		);
		const result = await googleVeoBackend.poll("op-1");
		expect(result.status).toBe("completed");
		expect(result.mediaUrl).toBe("https://cdn.example/veo-output.mp4");
	});

	it("maps a done operation with an error to failed", async () => {
		stubFetch(
			() =>
				new Response(
					JSON.stringify({
						name: "op-1",
						done: true,
						error: { message: "content policy violation" },
					}),
					{ status: 200 },
				),
		);
		const result = await googleVeoBackend.poll("op-1");
		expect(result.status).toBe("failed");
		expect(result.error).toBe("content policy violation");
	});

	it("returns a failed PollResult (never throws) on a provider error", async () => {
		stubFetch(() => new Response("nope", { status: 500 }));
		const result = await googleVeoBackend.poll("op-1");
		expect(result.status).toBe("failed");
		expect(result.error).toMatch(/500/);
	});
});

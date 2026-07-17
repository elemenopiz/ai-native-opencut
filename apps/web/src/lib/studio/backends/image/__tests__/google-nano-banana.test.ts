/**
 * Nano Banana Pro (Gemini 3 Pro Image) adapter — mocks `global.fetch` for the
 * `generateContent` call and toggles `webEnv.GEMINI_API_KEY`/
 * `GEMINI_NANO_BANANA_MODEL` directly (plain mutable object).
 *
 * Reference-image downloads (`referenceImageUrl`/`referenceImages[]`) are
 * routed through the shared SSRF-guarded `fetchReferenceMediaSafely`
 * (`@/lib/studio/reference-fetch`), which pins its own socket and bypasses
 * `global.fetch` entirely — that module is mocked here instead (it's fully
 * covered on its own in `../../__tests__/reference-fetch.test.ts`). Per this
 * repo's `mock.module`-before-dynamic-import convention (see
 * `upload-url-route.test.ts`), the mock is registered before the adapter is
 * imported so the binding baked into `google-nano-banana.ts` is the mock.
 *
 * `global.fetch` is captured/restored in `afterEach` — `mock.restore()`
 * alone does not undo a direct property assignment (see the leak gotcha
 * documented in `agent-streaming.test.ts` / `google-veo.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { webEnv } from "@byorn/env/web";

const referenceFetchCalls: string[] = [];
let referenceFetchShouldFail = false;

mock.module("@/lib/studio/reference-fetch", () => ({
	fetchReferenceMediaSafely: async (url: string) => {
		referenceFetchCalls.push(url);
		if (referenceFetchShouldFail) {
			throw new Error("Failed to fetch reference media");
		}
		return {
			contentType: "image/jpeg",
			arrayBuffer: new Uint8Array([9, 9, 9]).buffer,
		};
	},
}));

const { googleNanoBananaBackend } = await import("../google-nano-banana");

const originalFetch = globalThis.fetch;
const originalKey = webEnv.GEMINI_API_KEY;
const originalModel = webEnv.GEMINI_NANO_BANANA_MODEL;

afterEach(() => {
	globalThis.fetch = originalFetch;
	webEnv.GEMINI_API_KEY = originalKey;
	webEnv.GEMINI_NANO_BANANA_MODEL = originalModel;
	referenceFetchCalls.length = 0;
	referenceFetchShouldFail = false;
});

beforeEach(() => {
	webEnv.GEMINI_API_KEY = "test-gemini-key";
});

function stubGenerateContent(
	handler: (init?: RequestInit) => Response | Promise<Response>,
) {
	globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
		const u = String(url);
		if (u.includes("generativelanguage.googleapis.com")) return handler(init);
		throw new Error(`unexpected global.fetch call in test: ${u}`);
	}) as unknown as typeof fetch;
}

function inlineImageResponse(base64 = "aW1n", mimeType = "image/png") {
	return new Response(
		JSON.stringify({
			candidates: [
				{ content: { parts: [{ inlineData: { mimeType, data: base64 } }] } },
			],
		}),
		{ status: 200 },
	);
}

describe("googleNanoBananaBackend.submit — reference images go through the SSRF guard", () => {
	it("fetches referenceImageUrl and referenceImages[] via fetchReferenceMediaSafely, not a bare fetch", async () => {
		let capturedBody: Record<string, unknown> = {};
		stubGenerateContent((init) => {
			capturedBody = JSON.parse(init?.body as string);
			return inlineImageResponse();
		});

		await googleNanoBananaBackend.submit({
			modality: "image",
			prompt: "a cat",
			referenceImageUrl: "https://cdn.example/a.png",
			referenceImages: [
				"https://cdn.example/b.png",
				"https://cdn.example/c.png",
			],
		});

		expect(referenceFetchCalls.sort()).toEqual(
			[
				"https://cdn.example/a.png",
				"https://cdn.example/b.png",
				"https://cdn.example/c.png",
			].sort(),
		);
		const parts = (capturedBody.contents as Array<{ parts: unknown[] }>)[0]
			.parts;
		// prompt text part + 3 inlineData reference parts.
		expect(parts).toHaveLength(4);
	});

	it("preserves the base64/mimeType output shape for a fetched reference", async () => {
		let capturedBody: Record<string, unknown> = {};
		stubGenerateContent((init) => {
			capturedBody = JSON.parse((init?.body as string) ?? "{}");
			return inlineImageResponse();
		});

		await googleNanoBananaBackend.submit({
			modality: "image",
			prompt: "a cat",
			referenceImageUrl: "https://cdn.example/a.png",
		});

		const parts = (
			capturedBody.contents as Array<{ parts: Array<Record<string, unknown>> }>
		)[0].parts;
		const inlinePart = parts.find((p) => "inlineData" in p) as {
			inlineData: { mimeType: string; data: string };
		};
		expect(inlinePart.inlineData.mimeType).toBe("image/jpeg");
		expect(inlinePart.inlineData.data).toBe(
			Buffer.from(new Uint8Array([9, 9, 9])).toString("base64"),
		);
	});

	it("returns a failed SubmitResult with a generic message when a reference URL is SSRF-rejected", async () => {
		referenceFetchShouldFail = true;
		stubGenerateContent(() => inlineImageResponse());

		const result = await googleNanoBananaBackend.submit({
			modality: "image",
			prompt: "a cat",
			referenceImageUrl: "http://169.254.169.254/latest/meta-data/",
		});

		expect(result.status).toBe("failed");
		expect(result.error).toBe("Failed to fetch reference media");
		// No leakage of the rejected host/IP into the client-visible error.
		expect(result.error).not.toMatch(/169\.254/);
	});

	it("still submits normally with no reference images (no behavior change)", async () => {
		let capturedBody: Record<string, unknown> = {};
		stubGenerateContent((init) => {
			capturedBody = JSON.parse(init?.body as string);
			return inlineImageResponse("cGxhaW4=", "image/webp");
		});

		const result = await googleNanoBananaBackend.submit({
			modality: "image",
			prompt: "a cat, no refs",
		});

		expect(referenceFetchCalls).toHaveLength(0);
		expect(result.status).toBe("completed");
		expect(result.mediaUrl).toBe("data:image/webp;base64,cGxhaW4=");
		const parts = (capturedBody.contents as Array<{ parts: unknown[] }>)[0]
			.parts;
		expect(parts).toHaveLength(1); // prompt only
	});
});

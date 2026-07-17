/**
 * Ideogram 3.0 adapter — mocks `global.fetch` for the
 * `/v1/ideogram-v3/generate` call and toggles `webEnv.IDEOGRAM_API_KEY`
 * directly (plain mutable object).
 *
 * The `character_reference_images` download (`req.referenceImageUrl`) is
 * routed through the shared SSRF-guarded `fetchReferenceMediaSafely`
 * (`@/lib/studio/reference-fetch`), which pins its own socket and bypasses
 * `global.fetch` entirely — that module is mocked here instead (it's fully
 * covered on its own in `../../__tests__/reference-fetch.test.ts`). Per this
 * repo's `mock.module`-before-dynamic-import convention (see
 * `upload-url-route.test.ts`), the mock is registered before the adapter is
 * imported so the binding baked into `ideogram.ts` is the mock.
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
			contentType: "image/webp",
			arrayBuffer: new Uint8Array([7, 7, 7]).buffer,
		};
	},
}));

const { ideogramBackend } = await import("../ideogram");

const originalFetch = globalThis.fetch;
const originalKey = webEnv.IDEOGRAM_API_KEY;

afterEach(() => {
	globalThis.fetch = originalFetch;
	webEnv.IDEOGRAM_API_KEY = originalKey;
	referenceFetchCalls.length = 0;
	referenceFetchShouldFail = false;
});

beforeEach(() => {
	webEnv.IDEOGRAM_API_KEY = "test-ideogram-key";
});

function stubGenerate(
	handler: (init?: RequestInit) => Response | Promise<Response>,
) {
	globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
		const u = String(url);
		if (u.includes("api.ideogram.ai")) return handler(init);
		throw new Error(`unexpected global.fetch call in test: ${u}`);
	}) as unknown as typeof fetch;
}

function ideogramResponse(url = "https://cdn.ideogram.ai/out.png", seed = 42) {
	return new Response(JSON.stringify({ data: [{ url, seed }] }), {
		status: 200,
	});
}

describe("ideogramBackend.submit — character_reference_images goes through the SSRF guard", () => {
	it("fetches referenceImageUrl via fetchReferenceMediaSafely, not a bare fetch", async () => {
		let capturedForm: FormData | undefined;
		stubGenerate((init) => {
			capturedForm = init?.body as FormData;
			return ideogramResponse();
		});

		await ideogramBackend.submit({
			modality: "image",
			prompt: "a dog",
			referenceImageUrl: "https://cdn.example/ref.png",
		});

		expect(referenceFetchCalls).toEqual(["https://cdn.example/ref.png"]);
		expect(capturedForm).toBeInstanceOf(FormData);
		const blob = capturedForm?.get("character_reference_images");
		expect(blob).toBeInstanceOf(Blob);
		expect((blob as Blob).type).toBe("image/webp");
	});

	it("returns a failed SubmitResult with a generic message when the reference URL is SSRF-rejected", async () => {
		referenceFetchShouldFail = true;
		stubGenerate(() => ideogramResponse());

		const result = await ideogramBackend.submit({
			modality: "image",
			prompt: "a dog",
			referenceImageUrl: "http://10.0.0.5/internal",
		});

		expect(result.status).toBe("failed");
		expect(result.error).toBe("Failed to fetch reference media");
		// No raw host/IP leakage into the client-visible error.
		expect(result.error).not.toMatch(/10\.0\.0\.5/);
	});

	it("still submits normally with no reference image (no behavior change)", async () => {
		stubGenerate(() =>
			ideogramResponse("https://cdn.ideogram.ai/plain.png", 7),
		);

		const result = await ideogramBackend.submit({
			modality: "image",
			prompt: "a dog, no ref",
		});

		expect(referenceFetchCalls).toHaveLength(0);
		expect(result.status).toBe("completed");
		expect(result.mediaUrl).toBe("https://cdn.ideogram.ai/plain.png");
		expect(result.seed).toBe(7);
	});
});

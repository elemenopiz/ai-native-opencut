/**
 * FLUX1.1 [pro] Ultra / Kontext (Black Forest Labs) adapter — mocks
 * `global.fetch` for the submit + poll (`polling_url`) calls and toggles
 * `webEnv.BFL_API_KEY` directly (plain mutable object).
 *
 * Only the `flux-kontext-pro` `input_image` download (`req.referenceImageUrl`)
 * is caller-controlled and routed through the shared SSRF-guarded
 * `fetchReferenceMediaSafely` (`@/lib/studio/reference-fetch`), which pins
 * its own socket and bypasses `global.fetch` entirely — that module is
 * mocked here instead (it's fully covered on its own in
 * `../../__tests__/reference-fetch.test.ts`). `pollOnce`'s GET against BFL's
 * own `polling_url` is NOT caller-controlled (BFL mints and returns it) and
 * intentionally still goes through the plain `global.fetch` stub below —
 * that's the "leave it alone" case called out in the SSRF fix's scope.
 *
 * Per this repo's `mock.module`-before-dynamic-import convention (see
 * `upload-url-route.test.ts`), the `reference-fetch` mock is registered
 * before the adapter is imported so the binding baked into `bfl-flux.ts` is
 * the mock.
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
			contentType: "image/png",
			arrayBuffer: new Uint8Array([5, 5, 5]).buffer,
		};
	},
}));

const { bflFluxBackend } = await import("../bfl-flux");

const originalFetch = globalThis.fetch;
const originalKey = webEnv.BFL_API_KEY;

afterEach(() => {
	globalThis.fetch = originalFetch;
	webEnv.BFL_API_KEY = originalKey;
	referenceFetchCalls.length = 0;
	referenceFetchShouldFail = false;
});

beforeEach(() => {
	webEnv.BFL_API_KEY = "test-bfl-key";
});

const fetchedUrls: string[] = [];

/** `onSubmit` handles the `POST /v1/flux-*` call; `onPoll` handles the GET
 *  against the returned `polling_url` (BFL's own URL, not caller-supplied —
 *  intentionally still a plain `global.fetch` stub, not the SSRF-guard mock).
 *  Every hit URL is recorded to `fetchedUrls` so tests can assert which
 *  endpoint (kontext vs ultra) was actually called. */
function stubBfl(
	onSubmit: (init?: RequestInit) => Response | Promise<Response>,
	onPoll: () => Response | Promise<Response> = () =>
		new Response(
			JSON.stringify({
				status: "Ready",
				result: { sample: "https://bfl.example/out.png" },
			}),
			{ status: 200 },
		),
) {
	fetchedUrls.length = 0;
	globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
		const u = String(url);
		fetchedUrls.push(u);
		if (u.includes("api.bfl.ai/v1/flux-")) return onSubmit(init);
		if (u.includes("polling-url.bfl.example")) return onPoll();
		throw new Error(`unexpected global.fetch call in test: ${u}`);
	}) as unknown as typeof fetch;
}

describe("bflFluxBackend.submit — flux-kontext-pro input_image goes through the SSRF guard", () => {
	it("fetches referenceImageUrl via fetchReferenceMediaSafely and base64-encodes it as input_image", async () => {
		let capturedBody: Record<string, unknown> = {};
		stubBfl((init) => {
			capturedBody = JSON.parse(init?.body as string);
			return new Response(
				JSON.stringify({
					id: "job-1",
					polling_url: "https://polling-url.bfl.example/job-1",
				}),
				{ status: 200 },
			);
		});

		await bflFluxBackend.submit({
			modality: "image",
			prompt: "a cat",
			referenceImageUrl: "https://cdn.example/ref.png",
		});

		expect(referenceFetchCalls).toEqual(["https://cdn.example/ref.png"]);
		expect(fetchedUrls.some((u) => u.includes("flux-kontext-pro"))).toBe(true);
		expect(capturedBody.input_image).toBe(
			Buffer.from(new Uint8Array([5, 5, 5])).toString("base64"),
		);
	});

	it("returns a failed SubmitResult with a generic message when the reference URL is SSRF-rejected", async () => {
		referenceFetchShouldFail = true;
		stubBfl(
			() =>
				new Response(
					JSON.stringify({
						id: "job-1",
						polling_url: "https://polling-url.bfl.example/job-1",
					}),
					{ status: 200 },
				),
		);

		const result = await bflFluxBackend.submit({
			modality: "image",
			prompt: "a cat",
			referenceImageUrl: "http://[::1]/internal",
		});

		expect(result.status).toBe("failed");
		expect(result.error).toBe("Failed to fetch reference media");
		expect(result.error).not.toMatch(/::1/);
	});

	it("still submits via flux-pro-1.1-ultra with no reference image (no behavior change)", async () => {
		stubBfl(
			() =>
				new Response(
					JSON.stringify({
						id: "job-2",
						polling_url: "https://polling-url.bfl.example/job-2",
					}),
					{ status: 200 },
				),
		);

		const result = await bflFluxBackend.submit({
			modality: "image",
			prompt: "a cat, no ref",
		});

		expect(referenceFetchCalls).toHaveLength(0);
		expect(fetchedUrls.some((u) => u.includes("flux-pro-1.1-ultra"))).toBe(
			true,
		);
		expect(result.status).toBe("completed");
		expect(result.mediaUrl).toBe("https://bfl.example/out.png");
	});

	it("pollOnce's fetch against BFL's own polling_url is untouched by the reference SSRF guard", async () => {
		stubBfl(
			() =>
				new Response(
					JSON.stringify({
						id: "job-3",
						polling_url: "https://polling-url.bfl.example/job-3",
					}),
					{ status: 200 },
				),
			() =>
				new Response(
					JSON.stringify({
						status: "Ready",
						result: { sample: "https://bfl.example/out3.png" },
					}),
					{ status: 200 },
				),
		);

		const result = await bflFluxBackend.submit({
			modality: "image",
			prompt: "x",
		});

		// The polling_url fetch happened via the plain global.fetch stub, not
		// fetchReferenceMediaSafely — this call site is intentionally untouched
		// (BFL mints polling_url itself, it's not caller-controlled).
		expect(referenceFetchCalls).toHaveLength(0);
		expect(result.status).toBe("completed");
		expect(result.mediaUrl).toBe("https://bfl.example/out3.png");
	});
});

/**
 * `generateVideo`'s BytePlus submit path — specifically the new reference
 * role-contract wiring (`referenceImageRefs` → `buildReferenceContractSentence`
 * → appended prompt text). The existing submit/poll plumbing (job id, status
 * mapping) is exercised indirectly here and isn't otherwise under test, so a
 * couple of baseline assertions are included alongside the new behavior.
 *
 * `global.fetch` is captured/restored in `afterEach` per this repo's
 * documented gotcha (a direct property assignment survives `mock.restore()`)
 * — see `backends/video/__tests__/google-veo.test.ts`'s header for the same
 * note.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { webEnv } from "@byorn/env/web";
import { generateVideo } from "../provider-adapter";

const originalFetch = globalThis.fetch;
const originalKey = webEnv.BYTEPLUS_API_KEY;

afterEach(() => {
	globalThis.fetch = originalFetch;
	webEnv.BYTEPLUS_API_KEY = originalKey;
});

function stubFetch(capture: { body?: Record<string, unknown> }) {
	globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
		capture.body = JSON.parse(String(init?.body));
		return new Response(JSON.stringify({ id: "task-123" }), { status: 200 });
	}) as unknown as typeof fetch;
}

describe("generateVideo — reference role contract", () => {
	it("sends the prompt verbatim when no referenceImageRefs are supplied", async () => {
		webEnv.BYTEPLUS_API_KEY = "test-key";
		const capture: { body?: Record<string, unknown> } = {};
		stubFetch(capture);

		await generateVideo({
			prompt: "A man walks into a room.",
			referenceImages: ["https://x/a.png"],
			resolution: "720p",
			orientation: "landscape",
			duration: 5,
		});

		const content = capture.body!.content as Array<Record<string, unknown>>;
		expect(content[0]).toEqual({
			type: "text",
			text: "A man walks into a room.",
		});
	});

	it("appends the explicit-use contract sentence when referenceImageRefs carry roles", async () => {
		webEnv.BYTEPLUS_API_KEY = "test-key";
		const capture: { body?: Record<string, unknown> } = {};
		stubFetch(capture);

		await generateVideo({
			prompt: "A man walks into a room.",
			referenceImages: ["https://x/a.png", "https://x/b.png"],
			referenceImageRefs: [
				{ url: "https://x/a.png", role: "appearance", handle: "Orlando" },
				{ url: "https://x/b.png", role: "environment" },
			],
			resolution: "720p",
			orientation: "landscape",
			duration: 5,
		});

		const content = capture.body!.content as Array<Record<string, unknown>>;
		expect(content[0]).toEqual({
			type: "text",
			text:
				"A man walks into a room. Use @Orlando exclusively for the character's appearance; " +
				"use image 2 only for the environment, lighting, atmosphere, materials, and architectural language.",
		});
		// The reference images themselves are still sent via the plain array,
		// unaffected by the roled/named form riding alongside it.
		expect(content.filter((c) => c.role === "reference_image")).toHaveLength(2);
	});

	it("leaves the prompt untouched when referenceImageRefs is present but roleless", async () => {
		webEnv.BYTEPLUS_API_KEY = "test-key";
		const capture: { body?: Record<string, unknown> } = {};
		stubFetch(capture);

		await generateVideo({
			prompt: "A man walks into a room.",
			referenceImages: ["https://x/a.png"],
			referenceImageRefs: [{ url: "https://x/a.png" }],
			resolution: "720p",
			orientation: "landscape",
			duration: 5,
		});

		const content = capture.body!.content as Array<Record<string, unknown>>;
		expect(content[0]).toEqual({
			type: "text",
			text: "A man walks into a room.",
		});
	});
});

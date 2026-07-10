import { afterEach, describe, expect, test } from "bun:test";
import {
	LAST_FRAME_EPSILON_S,
	extractLastFrame,
	fetchVideoAsFile,
	lastFrameTimestamp,
	videoFetchUrl,
} from "@/lib/media/last-frame";

describe("lastFrameTimestamp", () => {
	test("samples just before the reported end", () => {
		expect(lastFrameTimestamp(5)).toBeCloseTo(5 - LAST_FRAME_EPSILON_S, 6);
	});

	test("honors a custom epsilon", () => {
		expect(lastFrameTimestamp(10, 0.2)).toBeCloseTo(9.8, 6);
	});

	test("clamps to 0 for zero / negative / non-finite durations", () => {
		expect(lastFrameTimestamp(0)).toBe(0);
		expect(lastFrameTimestamp(-3)).toBe(0);
		expect(lastFrameTimestamp(Number.NaN)).toBe(0);
		expect(lastFrameTimestamp(Number.POSITIVE_INFINITY)).toBe(0);
	});

	test("never returns a negative timestamp for sub-epsilon clips", () => {
		expect(lastFrameTimestamp(0.01)).toBeGreaterThanOrEqual(0);
	});
});

describe("videoFetchUrl", () => {
	const origin = "https://app.byorn.test";

	test("routes a cross-origin provider URL through the studio proxy", () => {
		const remote = "https://cdn.byteplus.example/gen/abc123.mp4";
		expect(videoFetchUrl(remote, origin)).toBe(
			`/api/studio/proxy?url=${encodeURIComponent(remote)}`,
		);
	});

	test("fetches a same-origin URL directly (no proxy)", () => {
		const local = `${origin}/media/take.mp4`;
		expect(videoFetchUrl(local, origin)).toBe(local);
	});

	test("fetches blob: and data: URLs directly (no proxy)", () => {
		const blobUrl = "blob:https://app.byorn.test/9f2c-uuid";
		const dataUrl = "data:video/mp4;base64,AAAA";
		expect(videoFetchUrl(blobUrl, origin)).toBe(blobUrl);
		expect(videoFetchUrl(dataUrl, origin)).toBe(dataUrl);
	});

	test("proxies http/https regardless of case when origin is unknown", () => {
		const remote = "HTTP://example.com/x.mp4";
		expect(videoFetchUrl(remote, "")).toBe(
			`/api/studio/proxy?url=${encodeURIComponent(remote)}`,
		);
	});
});

describe("fetchVideoAsFile", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	test("proxies a remote URL and wraps the blob as an mp4 File", async () => {
		let requestedUrl = "";
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			requestedUrl = String(input);
			return new Response(new Blob([new Uint8Array([1, 2, 3])]), {
				status: 200,
				headers: { "Content-Type": "video/mp4" },
			});
		}) as unknown as typeof fetch;

		const remote = "https://cdn.provider.example/out.mp4";
		const file = await fetchVideoAsFile(remote, "shot-1");

		expect(requestedUrl).toBe(
			`/api/studio/proxy?url=${encodeURIComponent(remote)}`,
		);
		expect(file).toBeInstanceOf(File);
		expect(file.type).toBe("video/mp4");
		expect(file.name).toBe("shot-1.mp4");
	});

	test("defaults a missing/non-video content-type to video/mp4", async () => {
		globalThis.fetch = (async () =>
			new Response(new Blob([new Uint8Array([0])]), {
				status: 200,
			})) as unknown as typeof fetch;

		const file = await fetchVideoAsFile(
			"https://cdn.provider.example/out",
			"take.mp4",
		);
		expect(file.type).toBe("video/mp4");
		// Already ends with .mp4 — not doubled up.
		expect(file.name).toBe("take.mp4");
	});

	test("throws on a non-ok response", async () => {
		globalThis.fetch = (async () =>
			new Response(null, { status: 502 })) as unknown as typeof fetch;
		await expect(
			fetchVideoAsFile("https://cdn.provider.example/out.mp4"),
		).rejects.toThrow("fetch failed 502");
	});
});

describe("extractLastFrame", () => {
	test("returns undefined when neither videoFile nor videoUrl is given", async () => {
		expect(await extractLastFrame({})).toBeUndefined();
	});

	test("swallows decode/fetch errors and returns undefined (remix falls back)", async () => {
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async () => {
			throw new Error("network down");
		}) as unknown as typeof fetch;
		try {
			expect(
				await extractLastFrame({ videoUrl: "https://x.example/v.mp4" }),
			).toBeUndefined();
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});

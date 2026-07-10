import { afterEach, describe, expect, mock, test } from "bun:test";

// Track how the decode pipeline is exercised. `generateThumbnails` is the
// single-decode (open-once, sample-many) helper; a true single decode calls it
// ONCE for a whole multi-frame review, not once per frame. `getVideoInfo` is
// the one duration probe. We assert both below.
const decodeCalls: { generateThumbnails: number[][]; getVideoInfo: number } = {
	generateThumbnails: [],
	getVideoInfo: 0,
};

mock.module("@/lib/media/processing", () => ({
	generateThumbnails: async ({
		timesInSeconds,
	}: {
		timesInSeconds: number[];
	}) => {
		decodeCalls.generateThumbnails.push(timesInSeconds);
		return timesInSeconds.map((t) => `data:image/jpeg;base64,frame-${t}`);
	},
	generateThumbnail: async ({ timeInSeconds }: { timeInSeconds: number }) =>
		`data:image/jpeg;base64,frame-${timeInSeconds}`,
}));

mock.module("@/lib/media/mediabunny", () => ({
	getVideoInfo: async () => {
		decodeCalls.getVideoInfo += 1;
		return { duration: 6, width: 1920, height: 1080, fps: 30 };
	},
}));

// Import AFTER the mocks are registered so `last-frame` binds the stubbed decode
// path (matches this repo's mock.module + dynamic-import convention).
const {
	LAST_FRAME_EPSILON_S,
	MAX_REVIEW_FRAMES,
	extractFrames,
	extractLastFrame,
	fetchVideoAsFile,
	lastFrameTimestamp,
	reviewFrameTimestamps,
	videoFetchUrl,
} = await import("@/lib/media/last-frame");

describe("reviewFrameTimestamps", () => {
	test("samples first / mid / last for a normal clip", () => {
		const ts = reviewFrameTimestamps(6);
		expect(ts).toHaveLength(3);
		expect(ts[0]).toBe(0);
		expect(ts[2]).toBeCloseTo(6 - LAST_FRAME_EPSILON_S, 5);
		expect(ts[1]).toBeCloseTo((6 - LAST_FRAME_EPSILON_S) / 2, 5);
	});

	test("count 1 returns only the last frame (matches lastFrameTimestamp)", () => {
		expect(reviewFrameTimestamps(6, 1)).toEqual([lastFrameTimestamp(6)]);
	});

	test("count 2 returns first + last", () => {
		const ts = reviewFrameTimestamps(6, 2);
		expect(ts).toHaveLength(2);
		expect(ts[0]).toBe(0);
		expect(ts[1]).toBeCloseTo(6 - LAST_FRAME_EPSILON_S, 5);
	});

	test("clamps count to 1..MAX_REVIEW_FRAMES; 0/NaN fall back to one frame", () => {
		expect(reviewFrameTimestamps(6, 99)).toHaveLength(MAX_REVIEW_FRAMES);
		expect(reviewFrameTimestamps(6, 0)).toEqual([lastFrameTimestamp(6)]);
		expect(reviewFrameTimestamps(6, Number.NaN)).toEqual([
			lastFrameTimestamp(6),
		]);
	});

	test("collapses to a single frame for zero / invalid durations", () => {
		expect(reviewFrameTimestamps(0)).toEqual([0]);
		expect(reviewFrameTimestamps(-3)).toEqual([0]);
		expect(reviewFrameTimestamps(Number.NaN)).toEqual([0]);
	});

	test("de-duplicates timestamps that collapse together on a tiny clip", () => {
		expect(reviewFrameTimestamps(0.06, 3)).toEqual([0]);
	});

	test("returns strictly ascending, in-range timestamps", () => {
		const duration = 12.5;
		const ts = reviewFrameTimestamps(duration, 3);
		for (let i = 1; i < ts.length; i++) {
			expect(ts[i]).toBeGreaterThan(ts[i - 1]);
		}
		expect(ts[0]).toBeGreaterThanOrEqual(0);
		expect(ts[ts.length - 1]).toBeLessThan(duration);
	});
});

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

describe("extractFrames", () => {
	afterEach(() => {
		decodeCalls.generateThumbnails = [];
		decodeCalls.getVideoInfo = 0;
	});

	test("opens the decoder ONCE for a multi-frame review (single decode pass)", async () => {
		const file = new File([new Uint8Array([1, 2, 3])], "take.mp4", {
			type: "video/mp4",
		});

		const frames = await extractFrames({ videoFile: file }, MAX_REVIEW_FRAMES);

		// One duration probe + one open-once/sample-many decode — NOT one decode
		// per frame (the E1 bug re-parsed the whole video per timestamp).
		expect(decodeCalls.getVideoInfo).toBe(1);
		expect(decodeCalls.generateThumbnails).toHaveLength(1);

		// That single decode was handed ALL the requested timestamps at once.
		expect(decodeCalls.generateThumbnails[0]).toEqual(
			reviewFrameTimestamps(6, MAX_REVIEW_FRAMES),
		);
		expect(frames).toHaveLength(
			reviewFrameTimestamps(6, MAX_REVIEW_FRAMES).length,
		);
	});

	test("returns [] for a source with neither file nor url (no decode)", async () => {
		expect(await extractFrames({})).toEqual([]);
		expect(decodeCalls.getVideoInfo).toBe(0);
		expect(decodeCalls.generateThumbnails).toHaveLength(0);
	});
});

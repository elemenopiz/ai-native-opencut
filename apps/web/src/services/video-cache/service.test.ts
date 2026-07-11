import { beforeEach, describe, expect, it, mock } from "bun:test";

/**
 * Regression tests for the deterministic playback hiccups: steady playback
 * must never escalate a late prefetch into a full keyframe re-seek
 * (sink.canvases()), and warm() must position a clip's decoder off the
 * render path.
 */

const FRAME = 1 / 30;

/** Timestamps passed to CanvasSink.canvases() — i.e. full decoder re-seeks. */
let seekCalls: number[] = [];

/**
 * When set, the mock decoder blocks before yielding the frame at this
 * timestamp until `gate.resolve()` is called — simulates one slow decode
 * (large keyframe / high-motion GOP).
 */
let slowFrame: { timestamp: number; promise: Promise<void> } | null = null;

function mockFrame(timestamp: number) {
	return {
		timestamp,
		duration: FRAME,
		canvas: { width: 16, height: 16 } as unknown as HTMLCanvasElement,
	};
}

async function* frameIterator(startTime: number) {
	let index = Math.floor(startTime / FRAME + 1e-6);
	while (true) {
		const timestamp = index * FRAME;
		if (slowFrame && Math.abs(timestamp - slowFrame.timestamp) < 1e-6) {
			await slowFrame.promise;
		}
		yield mockFrame(timestamp);
		index += 1;
	}
}

/** Options each constructed CanvasSink was created with, in creation order. */
let sinkConstructions: Array<Record<string, unknown>> = [];
let disposeCalls = 0;

/** Native source dimensions reported by the mock video track. */
const SOURCE_WIDTH = 3840;
const SOURCE_HEIGHT = 2160;

class MockCanvasSink {
	constructor(_track: unknown, options?: Record<string, unknown>) {
		sinkConstructions.push(options ?? {});
	}
	canvases(startTime: number) {
		seekCalls.push(startTime);
		return frameIterator(startTime);
	}
}

class MockInput {
	async getPrimaryVideoTrack() {
		return {
			canDecode: async () => true,
			displayWidth: SOURCE_WIDTH,
			displayHeight: SOURCE_HEIGHT,
		};
	}
	dispose() {
		disposeCalls++;
	}
}

mock.module("mediabunny", () => ({
	Input: MockInput,
	CanvasSink: MockCanvasSink,
	BlobSource: class {},
	ALL_FORMATS: [],
}));

const { VideoCache } = await import("./service");

const file = new File(["stub"], "clip.mp4");

/** Let the fire-and-forget prefetch chain settle between frames. */
function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
	seekCalls = [];
	slowFrame = null;
	sinkConstructions = [];
	disposeCalls = 0;
});

describe("VideoCache sequential playback", () => {
	it("serves monotonic frame requests with a single decoder seek", async () => {
		const cache = new VideoCache();

		for (let index = 0; index * FRAME <= 3.0; index++) {
			const time = index * FRAME;
			const frame = await cache.getFrameAt({ mediaId: "m1", file, time });
			// The returned frame must contain the requested time (float-safe).
			expect(Math.abs((frame?.timestamp ?? -1) - time)).toBeLessThan(FRAME);
			await flush();
		}

		expect(seekCalls).toEqual([0]);
	});

	it("waits for a late prefetch instead of re-seeking, even >2s past the last seek", async () => {
		const cache = new VideoCache();

		// Steady playback to ~2.47s, all frames served off the prefetch fast path.
		const slowIndex = 75; // 2.5s — beyond the 2s window from the initial seek at 0
		for (let index = 0; index < slowIndex; index++) {
			await cache.getFrameAt({ mediaId: "m1", file, time: index * FRAME });
			await flush();
		}
		expect(seekCalls).toEqual([0]);

		// The next frame's decode is slow: the prefetch for it is now pending.
		let release = () => {};
		slowFrame = {
			timestamp: slowIndex * FRAME,
			promise: new Promise((resolve) => {
				release = resolve;
			}),
		};

		const pending = cache.getFrameAt({
			mediaId: "m1",
			file,
			time: slowIndex * FRAME,
		});
		release();
		const frame = await pending;

		expect(frame?.timestamp).toBeCloseTo(slowIndex * FRAME, 5);
		// The regression: a stale lastTime escalated this to sink.canvases(2.5).
		expect(seekCalls).toEqual([0]);
	});
});

describe("VideoCache.warm", () => {
	it("pre-seeks a cold sink so the first getFrameAt is served from cache", async () => {
		const cache = new VideoCache();

		await cache.warm({ mediaId: "m2", file, time: 5.0 });
		expect(seekCalls).toEqual([5.0]);

		const frame = await cache.getFrameAt({ mediaId: "m2", file, time: 5.0 });
		expect(frame?.timestamp).toBeCloseTo(5.0, 5);
		expect(seekCalls).toEqual([5.0]);
	});

	it("does not reposition a sink that another clip is actively rendering from", async () => {
		const cache = new VideoCache();

		await cache.getFrameAt({ mediaId: "m3", file, time: 1.0 });
		expect(seekCalls).toEqual([1.0]);

		// lastAccess is fresh, so a lookahead warm for a far-away position of the
		// same media must not thrash the live iterator.
		await cache.warm({ mediaId: "m3", file, time: 30.0 });
		expect(seekCalls).toEqual([1.0]);
	});
});

describe("VideoCache sink tiers", () => {
	it("keeps the full tier unsized and caps the preview tier's long edge", async () => {
		const cache = new VideoCache();

		await cache.getFrameAt({ mediaId: "m4", file, time: 0 });
		await cache.getFrameAt({
			mediaId: "m4",
			file,
			time: 0,
			tier: "preview",
			previewMaxSize: 1920,
		});

		expect(sinkConstructions).toHaveLength(2);
		// Export/snapshot tier: native decode size (no width/height requested).
		expect(sinkConstructions[0].width).toBeUndefined();
		expect(sinkConstructions[0].height).toBeUndefined();
		// Preview tier: long edge capped, aspect preserved.
		expect(sinkConstructions[1].width).toBe(1920);
		expect(sinkConstructions[1].height).toBe(1080);
	});

	it("does not downsize sources already within the preview cap", async () => {
		const cache = new VideoCache();

		await cache.getFrameAt({
			mediaId: "m5",
			file,
			time: 0,
			tier: "preview",
			previewMaxSize: SOURCE_WIDTH * 2,
		});

		expect(sinkConstructions).toHaveLength(1);
		expect(sinkConstructions[0].width).toBeUndefined();
		expect(sinkConstructions[0].height).toBeUndefined();
	});

	it("gives each tier its own independent decoder position", async () => {
		const cache = new VideoCache();

		await cache.getFrameAt({ mediaId: "m6", file, time: 0 });
		// Same media, preview tier, far position: must seek its OWN sink, not
		// steal the full tier's iterator.
		const frame = await cache.getFrameAt({
			mediaId: "m6",
			file,
			time: 10.0,
			tier: "preview",
			previewMaxSize: 1920,
		});
		expect(frame?.timestamp).toBeCloseTo(10.0, 5);
		expect(seekCalls).toEqual([0, 10.0]);

		// The full tier's frame at 0 is still cached — no extra seek.
		const fullFrame = await cache.getFrameAt({ mediaId: "m6", file, time: 0 });
		expect(fullFrame?.timestamp).toBeCloseTo(0, 5);
		expect(seekCalls).toEqual([0, 10.0]);
	});

	it("rebuilds the preview sink when the cap changes", async () => {
		const cache = new VideoCache();

		await cache.getFrameAt({
			mediaId: "m7",
			file,
			time: 0,
			tier: "preview",
			previewMaxSize: 1920,
		});
		await cache.getFrameAt({
			mediaId: "m7",
			file,
			time: 0,
			tier: "preview",
			previewMaxSize: 3840,
		});

		expect(sinkConstructions).toHaveLength(2);
		expect(disposeCalls).toBe(1);
		expect(cache.getStats().totalSinks).toBe(1);
	});

	it("clearVideo disposes both tiers", async () => {
		const cache = new VideoCache();

		await cache.getFrameAt({ mediaId: "m8", file, time: 0 });
		await cache.getFrameAt({
			mediaId: "m8",
			file,
			time: 0,
			tier: "preview",
			previewMaxSize: 1920,
		});
		expect(cache.getStats().totalSinks).toBe(2);

		cache.clearVideo({ mediaId: "m8" });

		expect(disposeCalls).toBe(2);
		expect(cache.getStats().totalSinks).toBe(0);
	});

	it("clearAll disposes every sink across tiers", async () => {
		const cache = new VideoCache();

		await cache.getFrameAt({ mediaId: "m9", file, time: 0 });
		await cache.getFrameAt({
			mediaId: "m9",
			file,
			time: 0,
			tier: "preview",
			previewMaxSize: 1920,
		});
		await cache.getFrameAt({ mediaId: "m10", file, time: 0 });

		cache.clearAll();

		expect(disposeCalls).toBe(3);
		expect(cache.getStats().totalSinks).toBe(0);
	});
});

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

class MockCanvasSink {
	canvases(startTime: number) {
		seekCalls.push(startTime);
		return frameIterator(startTime);
	}
}

class MockInput {
	async getPrimaryVideoTrack() {
		return { canDecode: async () => true };
	}
	dispose() {}
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

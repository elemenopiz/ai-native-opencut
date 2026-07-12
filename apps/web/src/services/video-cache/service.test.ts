import { beforeEach, describe, expect, it, mock } from "bun:test";

/**
 * Regression tests for the deterministic playback hiccups and the prefetch
 * ring: steady playback must never escalate a late decode into a full
 * keyframe re-seek (sink.canvases()), warm() must position a clip's decoder
 * off the render path, realtime consumers must never await a mid-window
 * decode (drop policy), and all iterator access for one mediaId must be
 * strictly serialized regardless of caller concurrency.
 */

const FRAME = 1 / 30;

/** Timestamps passed to CanvasSink.canvases() — i.e. full decoder re-seeks. */
let seekCalls: number[] = [];

/** Total frames yielded by all iterators — bounds the ring fill. */
let framesYielded = 0;

/** Input.dispose() calls — clearVideo must free decoder resources. */
let disposeCalls = 0;

/** iterator.return() completions (via generator finally). */
let iteratorsClosed = 0;

/**
 * When set, the mock decoder blocks before yielding the frame at this
 * timestamp until `gate.resolve()` is called — simulates one slow decode
 * (large keyframe / high-motion GOP).
 */
let slowFrame: { timestamp: number; promise: Promise<void> } | null = null;

function gateFrame(timestamp: number): () => void {
	let release = () => {};
	slowFrame = {
		timestamp,
		promise: new Promise((resolve) => {
			release = resolve;
		}),
	};
	return release;
}

function mockFrame(timestamp: number) {
	return {
		timestamp,
		duration: FRAME,
		canvas: { width: 16, height: 16 } as unknown as HTMLCanvasElement,
	};
}

async function* frameIterator(startTime: number) {
	let index = Math.floor(startTime / FRAME + 1e-6);
	try {
		while (true) {
			const timestamp = index * FRAME;
			if (slowFrame && Math.abs(timestamp - slowFrame.timestamp) < 1e-6) {
				await slowFrame.promise;
			}
			framesYielded += 1;
			yield mockFrame(timestamp);
			index += 1;
		}
	} finally {
		iteratorsClosed += 1;
	}
}

/** Options each constructed CanvasSink was created with, in creation order. */
let sinkConstructions: Array<Record<string, unknown>> = [];

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
		disposeCalls += 1;
	}
}

mock.module("mediabunny", () => ({
	Input: MockInput,
	CanvasSink: MockCanvasSink,
	BlobSource: class {},
	ALL_FORMATS: [],
}));

const { VideoCache, PREFETCH_RING_CAPACITY } = await import("./service");

const file = new File(["stub"], "clip.mp4");

/** Let the fire-and-forget fill chain settle between frames. */
function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
	seekCalls = [];
	framesYielded = 0;
	disposeCalls = 0;
	iteratorsClosed = 0;
	slowFrame = null;
	sinkConstructions = [];
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

	it("waits for a late fill instead of re-seeking, even >2s past the last seek", async () => {
		const cache = new VideoCache();

		// Steady playback to ~2.47s, all frames served off the ring fast path.
		const slowIndex = 75; // 2.5s — beyond the 2s window from the initial seek at 0
		for (let index = 0; index < slowIndex; index++) {
			await cache.getFrameAt({ mediaId: "m1", file, time: index * FRAME });
			await flush();
		}
		expect(seekCalls).toEqual([0]);

		// The next frame's decode is slow: the fill for it is now pending.
		const release = gateFrame(slowIndex * FRAME);

		// Exact mode (export/snapshot): must await the late decode.
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

	it("skips ring frames cleanly at playbackRate>1 (every 3rd source frame)", async () => {
		const cache = new VideoCache();

		for (let index = 0; index <= 30; index += 3) {
			const time = index * FRAME;
			const frame = await cache.getFrameAt({ mediaId: "m1", file, time });
			expect(frame?.timestamp).toBeCloseTo(time, 5);
			await flush();
		}

		expect(seekCalls).toEqual([0]);
	});

	it("escalates to a real seek outside the sequential window (forward and back)", async () => {
		const cache = new VideoCache();

		await cache.getFrameAt({ mediaId: "m1", file, time: 0 });
		await flush();

		const forward = await cache.getFrameAt({ mediaId: "m1", file, time: 10 });
		expect(forward?.timestamp).toBeCloseTo(10, 5);

		const backward = await cache.getFrameAt({ mediaId: "m1", file, time: 1 });
		expect(backward?.timestamp).toBeCloseTo(1, 5);

		expect(seekCalls).toEqual([0, 10, 1]);
	});
});

describe("VideoCache prefetch ring", () => {
	it("fills at most PREFETCH_RING_CAPACITY frames ahead of the consumer", async () => {
		const cache = new VideoCache();

		await cache.getFrameAt({ mediaId: "m1", file, time: 0 });
		for (let i = 0; i < 5; i++) {
			await flush();
		}

		// 1 frame served + the buffered lookahead; the fill must stop there —
		// CanvasSink's pool recycles canvases, so an unbounded ring would alias
		// live frames onto reused canvases.
		expect(framesYielded).toBe(1 + PREFETCH_RING_CAPACITY);
	});

	it("serves later requests from the ring without touching the decoder", async () => {
		const cache = new VideoCache();

		await cache.getFrameAt({ mediaId: "m1", file, time: 0 });
		for (let i = 0; i < 5; i++) {
			await flush();
		}
		const yieldedAfterFill = framesYielded;

		// Block the decoder completely: ring-served frames must not need it.
		const release = gateFrame((1 + PREFETCH_RING_CAPACITY) * FRAME);

		for (let index = 1; index <= PREFETCH_RING_CAPACITY; index++) {
			const frame = await cache.getFrameAt({
				mediaId: "m1",
				file,
				time: index * FRAME,
				tolerateStale: true,
			});
			expect(frame?.timestamp).toBeCloseTo(index * FRAME, 5);
		}

		expect(framesYielded).toBe(yieldedAfterFill);
		expect(seekCalls).toEqual([0]);
		release();
	});
});

describe("VideoCache drop policy (tolerateStale)", () => {
	it("returns the newest frame <= time immediately when the exact frame's decode is in flight", async () => {
		const cache = new VideoCache();

		await cache.getFrameAt({ mediaId: "m1", file, time: 0 });
		await flush();

		// Frame 5's decode never completes until released.
		const stuckIndex = 1 + PREFETCH_RING_CAPACITY;
		const release = gateFrame(stuckIndex * FRAME);

		// Drain the ring (frames 1..capacity); the fill re-kicks and blocks on
		// the gated frame.
		for (let index = 1; index < stuckIndex; index++) {
			await cache.getFrameAt({
				mediaId: "m1",
				file,
				time: index * FRAME,
				tolerateStale: true,
			});
			await flush();
		}

		// The exact frame isn't buffered and its decode is pending: a realtime
		// consumer gets the newest available frame back IMMEDIATELY — this is
		// the await that used to stall the whole render tree.
		const stale = await cache.getFrameAt({
			mediaId: "m1",
			file,
			time: stuckIndex * FRAME,
			tolerateStale: true,
		});
		expect(stale?.timestamp).toBeCloseTo((stuckIndex - 1) * FRAME, 5);
		// And it never escalated to a keyframe re-seek.
		expect(seekCalls).toEqual([0]);

		// Once the decode lands, the same request serves the exact frame.
		release();
		slowFrame = null;
		await flush();
		const exact = await cache.getFrameAt({
			mediaId: "m1",
			file,
			time: stuckIndex * FRAME,
			tolerateStale: true,
		});
		expect(exact?.timestamp).toBeCloseTo(stuckIndex * FRAME, 5);
		expect(seekCalls).toEqual([0]);
	});
});

describe("VideoCache same-media serialization", () => {
	it("runs concurrent getFrameAt calls for one mediaId strictly one at a time", async () => {
		const cache = new VideoCache();

		// First caller's initial seek blocks on its first decode.
		const release = gateFrame(0);

		const first = cache.getFrameAt({ mediaId: "m1", file, time: 0 });
		const second = cache.getFrameAt({ mediaId: "m1", file, time: 5 });

		await flush();
		// The second caller must NOT have touched the sink yet — its seek would
		// tear down the first caller's iterator mid-decode.
		expect(seekCalls).toEqual([0]);

		release();
		const [frameA, frameB] = await Promise.all([first, second]);

		expect(frameA?.timestamp).toBeCloseTo(0, 5);
		expect(frameB?.timestamp).toBeCloseTo(5, 5);
		expect(seekCalls).toEqual([0, 5]);
	});

	it("still fetches DIFFERENT media in parallel", async () => {
		const cache = new VideoCache();

		// m1's first decode blocks; m2 must not be held up by it.
		const release = gateFrame(0);

		const blocked = cache.getFrameAt({ mediaId: "m1", file, time: 0 });
		const other = await cache.getFrameAt({ mediaId: "m2", file, time: 2 });

		expect(other?.timestamp).toBeCloseTo(2, 5);

		release();
		slowFrame = null;
		const frame = await blocked;
		expect(frame?.timestamp).toBeCloseTo(0, 5);
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

	it("never interleaves a warm's pre-seek with a concurrent getFrameAt", async () => {
		const cache = new VideoCache();

		// The warm's first decode blocks mid-seek.
		const release = gateFrame(5.0);

		const warming = cache.warm({ mediaId: "m4", file, time: 5.0 });
		const fetching = cache.getFrameAt({ mediaId: "m4", file, time: 5.0 });

		await flush();
		// getFrameAt is queued behind the warm — it must not have started a
		// second competing seek while the warm's iterator is mid-decode.
		expect(seekCalls).toEqual([5.0]);

		release();
		slowFrame = null;
		await warming;
		const frame = await fetching;

		// Served straight from the warmed position: still exactly one seek.
		expect(frame?.timestamp).toBeCloseTo(5.0, 5);
		expect(seekCalls).toEqual([5.0]);
	});
});

describe("VideoCache.clearVideo", () => {
	it("disposes the input, closes the iterator, and drops all ring frames", async () => {
		const cache = new VideoCache();

		await cache.getFrameAt({ mediaId: "m1", file, time: 0 });
		await flush();
		expect(cache.getStats().bufferedFrames).toBeGreaterThan(0);

		cache.clearVideo({ mediaId: "m1" });
		await flush();

		expect(disposeCalls).toBe(1);
		expect(iteratorsClosed).toBe(1);
		expect(cache.getStats()).toEqual({
			totalSinks: 0,
			activeSinks: 0,
			cachedFrames: 0,
			bufferedFrames: 0,
		});

		// A fresh request re-initializes from scratch (new seek).
		const frame = await cache.getFrameAt({ mediaId: "m1", file, time: 1 });
		expect(frame?.timestamp).toBeCloseTo(1, 5);
		expect(seekCalls).toEqual([0, 1]);
	});

	it("clearAll clears every sink", async () => {
		const cache = new VideoCache();

		await cache.getFrameAt({ mediaId: "a", file, time: 0 });
		await cache.getFrameAt({ mediaId: "b", file, time: 0 });
		await flush();

		cache.clearAll();

		expect(disposeCalls).toBe(2);
		expect(cache.getStats().totalSinks).toBe(0);
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

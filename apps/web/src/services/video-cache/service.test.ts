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

/** When set, constructing a prefer-hardware CanvasSink throws once. */
let failPreferHardware = false;

class MockCanvasSink {
	constructor(_track: unknown, options?: Record<string, unknown>) {
		const decoderOptions = options?.decoderOptions as
			| { hardwareAcceleration?: string }
			| undefined;
		if (
			failPreferHardware &&
			decoderOptions?.hardwareAcceleration === "prefer-hardware"
		) {
			throw new Error("simulated hardware decoder init failure");
		}
		sinkConstructions.push(options ?? {});
	}
	canvases(startTime: number) {
		seekCalls.push(startTime);
		return frameIterator(startTime);
	}
}

/** Toggle to simulate `videoTrack.canDecode()` returning false. */
let decodeSupported = true;

/** Toggle to simulate no primary video track at all (a different init failure). */
let noVideoTrack = false;

/** `new Input(...)` construction count — bounds re-probe attempts on a known-bad sink. */
let inputConstructions = 0;

class MockInput {
	constructor() {
		inputConstructions += 1;
	}
	async getPrimaryVideoTrack() {
		if (noVideoTrack) return null;
		return {
			canDecode: async () => decodeSupported,
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

/** Captures every sonner call the un-silenced initializeSink catch makes. */
const toastCalls: { warning: string[] } = { warning: [] };
mock.module("sonner", () => ({
	toast: {
		warning: (msg: string) => {
			toastCalls.warning.push(msg);
		},
		error: () => {},
		success: () => {},
		info: () => {},
		loading: () => "toast-id",
		dismiss: () => {},
	},
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
	failPreferHardware = false;
	decodeSupported = true;
	noVideoTrack = false;
	inputConstructions = 0;
	toastCalls.warning.length = 0;
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

describe("VideoCache hardware-decode hint (perf audit #5)", () => {
	it("constructs the sink with decoderOptions.hardwareAcceleration: prefer-hardware", async () => {
		const cache = new VideoCache();

		await cache.getFrameAt({ mediaId: "hw1", file, time: 0 });

		expect(sinkConstructions).toHaveLength(1);
		expect(sinkConstructions[0].decoderOptions).toEqual({
			hardwareAcceleration: "prefer-hardware",
		});
	});

	it("falls back to no-preference (and still serves a frame) if the prefer-hardware sink fails to construct", async () => {
		failPreferHardware = true;
		const cache = new VideoCache();

		const frame = await cache.getFrameAt({ mediaId: "hw2", file, time: 0 });

		expect(frame?.timestamp).toBeCloseTo(0, 5);
		// Two constructor attempts: the failed prefer-hardware one (never
		// recorded — it throws before pushing) and the successful fallback.
		expect(sinkConstructions).toHaveLength(1);
		expect(sinkConstructions[0].decoderOptions).toBeUndefined();
	});
});

/**
 * Part 2 of the HEVC cross-browser decode fallback design (Option A, gap 1):
 * `initializeSink` used to throw "Video codec not supported for decoding"
 * with no catch anywhere in the call chain the moment `canDecode()` came back
 * false — an unhandled rejection and a dead preview. It must now degrade to
 * the SAME "nothing to render yet" path getFrameAt/warm already use for an
 * out-of-range clip, surface a toast once, and remember the failure so a
 * broken sink isn't re-probed (and re-toasted) on every render-loop frame.
 */
describe("VideoCache un-silences a codec-unsupported sink (HEVC fallback P2)", () => {
	it("getFrameAt resolves to null instead of throwing when canDecode() is false", async () => {
		decodeSupported = false;
		const cache = new VideoCache();

		const frame = await cache.getFrameAt({ mediaId: "bad1", file, time: 0 });

		expect(frame).toBeNull();
		expect(cache.getStats().totalSinks).toBe(0);
	});

	it("warm resolves (does not throw) when canDecode() is false", async () => {
		decodeSupported = false;
		const cache = new VideoCache();

		await expect(
			cache.warm({ mediaId: "bad2", file, time: 5 }),
		).resolves.toBeUndefined();
	});

	it("surfaces exactly one toast, and never re-probes the decoder again, across repeated calls", async () => {
		decodeSupported = false;
		const cache = new VideoCache();

		await cache.getFrameAt({ mediaId: "bad3", file, time: 0 });
		await cache.getFrameAt({ mediaId: "bad3", file, time: 1 });
		await cache.warm({ mediaId: "bad3", file, time: 2 });

		expect(toastCalls.warning).toHaveLength(1);
		expect(toastCalls.warning[0]).toContain("clip.mp4");
		expect(toastCalls.warning[0]).toContain("unsupported codec");
		// One real construction attempt only — later calls short-circuit on the
		// remembered failure instead of hammering WebCodecs every frame.
		expect(inputConstructions).toBe(1);
		expect(disposeCalls).toBe(1); // the failed Input is still disposed, not leaked
	});

	it("records the reason via getSinkInitFailure, distinguishing codec-unsupported from other init failures", async () => {
		decodeSupported = false;
		const cache = new VideoCache();
		await cache.getFrameAt({ mediaId: "bad4", file, time: 0 });

		expect(cache.getSinkInitFailure({ mediaId: "bad4" })).toBe(
			"codec-unsupported",
		);
		// A tier that was never attempted has no recorded failure.
		expect(
			cache.getSinkInitFailure({ mediaId: "bad4", tier: "export" }),
		).toBeNull();
		// An unrelated, never-touched mediaId has no recorded failure either.
		expect(cache.getSinkInitFailure({ mediaId: "never-touched" })).toBeNull();
	});

	it("treats a missing video track as a generic init failure, not codec-unsupported", async () => {
		noVideoTrack = true;
		const cache = new VideoCache();

		const frame = await cache.getFrameAt({ mediaId: "bad5", file, time: 0 });

		expect(frame).toBeNull();
		expect(cache.getSinkInitFailure({ mediaId: "bad5" })).toBe("init-failed");
		expect(toastCalls.warning).toHaveLength(1);
		expect(toastCalls.warning[0]).not.toContain("unsupported codec");
	});

	it("clearVideo clears the remembered failure so a later retry gets a fresh attempt", async () => {
		decodeSupported = false;
		const cache = new VideoCache();

		const first = await cache.getFrameAt({ mediaId: "bad6", file, time: 0 });
		expect(first).toBeNull();
		expect(cache.getSinkInitFailure({ mediaId: "bad6" })).toBe(
			"codec-unsupported",
		);

		cache.clearVideo({ mediaId: "bad6" });
		expect(cache.getSinkInitFailure({ mediaId: "bad6" })).toBeNull();

		// Browser/asset situation "improves" (e.g. this is really testing that
		// the cache doesn't wedge a mediaId as permanently broken) — a fresh
		// attempt now succeeds.
		decodeSupported = true;
		const second = await cache.getFrameAt({ mediaId: "bad6", file, time: 0 });
		expect(second?.timestamp).toBeCloseTo(0, 5);
	});

	it("clearAll clears remembered failures that never had a sinks entry", async () => {
		decodeSupported = false;
		const cache = new VideoCache();
		await cache.getFrameAt({ mediaId: "bad7", file, time: 0 });
		expect(cache.getSinkInitFailure({ mediaId: "bad7" })).toBe(
			"codec-unsupported",
		);

		cache.clearAll();

		expect(cache.getSinkInitFailure({ mediaId: "bad7" })).toBeNull();
	});
});

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type {
	ProxyGenerateOptions,
	ProxyGenerateResult,
} from "./proxy-generator";

// ---------------------------------------------------------------------------
// mediabunny mock harness
//
// Mirrors the repo precedent in normalize-media.test.ts / video-cache
// service.test.ts: mock.module("mediabunny") with just the names the module
// under test imports. The fake source is a 1920x1080 track, 10/30 s long at
// 30 fps, which yields exactly 10 frames through the encode loop.
// ---------------------------------------------------------------------------

const TRACK_WIDTH = 1920;
const TRACK_HEIGHT = 1080;
const FRAME_DURATION = 1 / 30;
const FRAME_TOTAL = 10;
const TRACK_DURATION = FRAME_TOTAL * FRAME_DURATION;

const harness = {
	canvasSourceCanvases: [] as unknown[],
	framesAdded: [] as Array<{ timestamp: number; duration: number }>,
	outputCancelled: 0,
	inputDisposed: 0,
	iteratorClosed: 0,
};

function resetHarness() {
	harness.canvasSourceCanvases = [];
	harness.framesAdded = [];
	harness.outputCancelled = 0;
	harness.inputDisposed = 0;
	harness.iteratorClosed = 0;
}

const fakeFrameCanvas = {} as HTMLCanvasElement;

const fakeVideoTrack = {
	canDecode: async () => true,
	displayWidth: TRACK_WIDTH,
	displayHeight: TRACK_HEIGHT,
	computeDuration: async () => TRACK_DURATION,
	computePacketStats: async () => ({ averagePacketRate: 30 }),
};

class FakeInput {
	async getPrimaryVideoTrack() {
		return fakeVideoTrack;
	}
	dispose() {
		harness.inputDisposed++;
	}
}

class FakeBlobSource {}

class FakeCanvasSink {
	async *canvases(_start: number) {
		try {
			for (let i = 0; i < FRAME_TOTAL; i++) {
				yield {
					canvas: fakeFrameCanvas,
					timestamp: i * FRAME_DURATION,
					duration: FRAME_DURATION,
				};
			}
		} finally {
			harness.iteratorClosed++;
		}
	}
}

class FakeBufferTarget {
	buffer: ArrayBuffer | null = null;
}

class FakeOutput {
	target: FakeBufferTarget;
	constructor(opts: { target: FakeBufferTarget }) {
		this.target = opts.target;
	}
	addVideoTrack(_source: unknown, _opts: unknown) {}
	async start() {}
	async cancel() {
		harness.outputCancelled++;
	}
	async finalize() {
		this.target.buffer = new ArrayBuffer(8);
	}
}

class FakeCanvasSource {
	constructor(canvas: unknown, _config: unknown) {
		harness.canvasSourceCanvases.push(canvas);
	}
	async add(timestamp: number, duration: number) {
		harness.framesAdded.push({ timestamp, duration });
	}
	close() {}
}

class FakeMp4OutputFormat {}

mock.module("mediabunny", () => ({
	Input: FakeInput,
	ALL_FORMATS: [],
	BlobSource: FakeBlobSource,
	CanvasSink: FakeCanvasSink,
	Output: FakeOutput,
	Mp4OutputFormat: FakeMp4OutputFormat,
	BufferTarget: FakeBufferTarget,
	CanvasSource: FakeCanvasSource,
	QUALITY_LOW: 1,
}));

const { generateProxy, runProxyEncode } = await import("./proxy-generator");

// ---------------------------------------------------------------------------
// Canvas + document stubs
// ---------------------------------------------------------------------------

interface FakeCtx {
	clearRect: ReturnType<typeof mock>;
	drawImage: ReturnType<typeof mock>;
}

function makeFakeCanvas(): {
	canvas: HTMLCanvasElement;
	ctx: FakeCtx;
} {
	const ctx: FakeCtx = {
		clearRect: mock(() => {}),
		drawImage: mock(() => {}),
	};
	const canvas = {
		width: 0,
		height: 0,
		getContext: (_id: string) => ctx,
	} as unknown as HTMLCanvasElement;
	return { canvas, ctx };
}

/**
 * Installs a `document` stub whose createElement("canvas") is spied, runs the
 * callback, and restores the original global afterwards (property assignment
 * on globalThis leaks across bun test files unless explicitly restored — see
 * the agent-streaming global.fetch incident).
 */
async function withDocumentStub<T>(
	run: (createElementSpy: ReturnType<typeof mock>) => Promise<T>,
): Promise<{ result: T; createdCanvases: HTMLCanvasElement[] }> {
	const originalDescriptor = Object.getOwnPropertyDescriptor(
		globalThis,
		"document",
	);
	const createdCanvases: HTMLCanvasElement[] = [];
	const createElementSpy = mock((tag: string) => {
		if (tag !== "canvas") throw new Error(`Unexpected createElement: ${tag}`);
		const { canvas } = makeFakeCanvas();
		createdCanvases.push(canvas);
		return canvas;
	});
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		writable: true,
		value: { createElement: createElementSpy },
	});
	try {
		const result = await run(createElementSpy);
		return { result, createdCanvases };
	} finally {
		if (originalDescriptor) {
			Object.defineProperty(globalThis, "document", originalDescriptor);
		} else {
			delete (globalThis as { document?: unknown }).document;
		}
	}
}

function makeSourceFile() {
	return new File([new Uint8Array([1, 2, 3])], "test.mov", {
		type: "video/quicktime",
	});
}

beforeEach(resetHarness);

// ---------------------------------------------------------------------------
// generateProxy public contract (unchanged by the refactor)
// ---------------------------------------------------------------------------

describe("generateProxy public contract", () => {
	it("accepts the exact ProxyGenerateOptions shape and resolves the ProxyGenerateResult shape", async () => {
		const progress: number[] = [];
		const controller = new AbortController();

		const { result, createdCanvases } = await withDocumentStub(
			async (createElementSpy) => {
				const options: ProxyGenerateOptions = {
					file: makeSourceFile(),
					resolution: "480p",
					onProgress: (p) => progress.push(p),
					signal: controller.signal,
				};
				const res: ProxyGenerateResult = await generateProxy(options);
				expect(createElementSpy).toHaveBeenCalledTimes(1);
				expect(createElementSpy).toHaveBeenCalledWith("canvas");
				return res;
			},
		);

		// ProxyGenerateResult shape: { file, width, height }.
		expect(Object.keys(result).sort()).toEqual(["file", "height", "width"]);
		expect(result.file).toBeInstanceOf(File);
		expect(result.file.name).toBe("proxy_test.mov");
		expect(result.file.type).toBe("video/mp4");
		// 1920x1080 @ 480p preset → even-snapped 852x480 (computeProxyDimensions).
		expect(result.width).toBe(852);
		expect(result.height).toBe(480);

		// The DOM canvas generateProxy created is the one handed to the encoder,
		// sized to the proxy dimensions.
		expect(createdCanvases).toHaveLength(1);
		expect(harness.canvasSourceCanvases).toEqual([createdCanvases[0]]);
		expect(createdCanvases[0].width).toBe(852);
		expect(createdCanvases[0].height).toBe(480);

		// Progress: every 5th frame (5/10, then 10/10 capped at 0.99), then 1.
		expect(progress).toEqual([0.5, 0.99, 1]);

		// All 10 frames encoded; source cleaned up.
		expect(harness.framesAdded).toHaveLength(FRAME_TOTAL);
		expect(harness.inputDisposed).toBe(1);
		expect(harness.iteratorClosed).toBe(1);
	});

	it("rejects with the cancellation error when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();

		await withDocumentStub(async () => {
			await expect(
				generateProxy({
					file: makeSourceFile(),
					resolution: "480p",
					signal: controller.signal,
				}),
			).rejects.toThrow("Proxy generation cancelled");
			return null;
		});

		expect(harness.outputCancelled).toBe(1);
		expect(harness.framesAdded).toHaveLength(0);
		expect(harness.inputDisposed).toBe(1);
		expect(harness.iteratorClosed).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// runProxyEncode injected-canvas seam
// ---------------------------------------------------------------------------

describe("runProxyEncode injected canvas", () => {
	it("uses the injected canvas and never touches document.createElement", async () => {
		const { canvas: injected, ctx } = makeFakeCanvas();
		const createCanvas = mock((_w: number, _h: number) => injected);

		const { result } = await withDocumentStub(async (createElementSpy) => {
			const res = await runProxyEncode({
				file: makeSourceFile(),
				resolution: "480p",
				createCanvas,
			});
			// The core must not reach for the DOM when a canvas is injected.
			expect(createElementSpy).not.toHaveBeenCalled();
			return res;
		});

		// Factory called once with the computed proxy dimensions.
		expect(createCanvas).toHaveBeenCalledTimes(1);
		expect(createCanvas).toHaveBeenCalledWith(852, 480);

		// The injected canvas is what the encoder consumes, sized correctly.
		expect(harness.canvasSourceCanvases).toEqual([injected]);
		expect(injected.width).toBe(852);
		expect(injected.height).toBe(480);

		// Every decoded frame was drawn into the injected canvas's context.
		expect(ctx.clearRect).toHaveBeenCalledTimes(FRAME_TOTAL);
		expect(ctx.drawImage).toHaveBeenCalledTimes(FRAME_TOTAL);
		expect(ctx.drawImage).toHaveBeenCalledWith(fakeFrameCanvas, 0, 0, 852, 480);

		// Same result contract as generateProxy.
		expect(result.width).toBe(852);
		expect(result.height).toBe(480);
		expect(result.file.type).toBe("video/mp4");
	});

	it("works without any document global at all (worker-like environment)", async () => {
		// In a Web Worker there is no document. The core must not depend on it.
		const originalDescriptor = Object.getOwnPropertyDescriptor(
			globalThis,
			"document",
		);
		if (originalDescriptor) {
			delete (globalThis as { document?: unknown }).document;
		}
		try {
			const { canvas: injected } = makeFakeCanvas();
			const result = await runProxyEncode({
				file: makeSourceFile(),
				resolution: "480p",
				createCanvas: () => injected,
			});
			expect(result.width).toBe(852);
			expect(result.height).toBe(480);
			expect(harness.canvasSourceCanvases).toEqual([injected]);
		} finally {
			if (originalDescriptor) {
				Object.defineProperty(globalThis, "document", originalDescriptor);
			}
		}
	});
});

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type {
	ProxyGenerateOptions,
	ProxyGenerateResult,
} from "../proxy-generator";

// ---------------------------------------------------------------------------
// generateProxy mock — the fallback target on every "unsupported" / boot-
// failure path. Mocked at the module the controller actually imports from
// ("../proxy-generator", i.e. "@/services/proxy/proxy-generator") so the
// fallback assertions don't depend on mediabunny or a real DOM canvas at
// all (mirrors the "@/services/proxy" mock in
// media-manager-decode-reprobe.test.ts).
// ---------------------------------------------------------------------------

const fallbackResult: ProxyGenerateResult = {
	file: new File([new Uint8Array([1])], "proxy_fallback.mp4", {
		type: "video/mp4",
	}),
	width: 640,
	height: 360,
};

const generateProxyMock = mock(
	async (_options: ProxyGenerateOptions): Promise<ProxyGenerateResult> =>
		fallbackResult,
);

mock.module("@/services/proxy/proxy-generator", () => ({
	generateProxy: generateProxyMock,
}));

const { generateProxyOffThread, isWorkerProxyEncodeSupported } = await import(
	"./proxy-encoder-controller"
);

// ---------------------------------------------------------------------------
// Global stubbing helpers — bun test leaks property assignments on
// globalThis across files unless explicitly restored (see the
// agent-streaming global.fetch incident this repo already hit), so every
// stub here is paired with an exact restore.
// ---------------------------------------------------------------------------

function stubGlobal(name: string, value: unknown): () => void {
	const original = Object.getOwnPropertyDescriptor(globalThis, name);
	Object.defineProperty(globalThis, name, {
		configurable: true,
		writable: true,
		value,
	});
	return () => {
		if (original) {
			Object.defineProperty(globalThis, name, original);
		} else {
			delete (globalThis as Record<string, unknown>)[name];
		}
	};
}

const restoreFns: Array<() => void> = [];
function stub(name: string, value: unknown) {
	restoreFns.push(stubGlobal(name, value));
}

afterEach(() => {
	for (const restore of restoreFns.splice(0)) restore();
	generateProxyMock.mockClear();
});

class FakeOffscreenCanvas {}
class FakeVideoEncoder {}

/** Stubs all four capability-detection globals as present. */
function stubFullySupported() {
	stub("window", {});
	stub("Worker", FakeWorker);
	stub("OffscreenCanvas", FakeOffscreenCanvas);
	stub("VideoEncoder", FakeVideoEncoder);
}

// ---------------------------------------------------------------------------
// Fake Worker — captures postMessage calls and lets tests drive
// onmessage/onerror the way a real worker's message events would.
// ---------------------------------------------------------------------------

class FakeWorker {
	static instances: FakeWorker[] = [];
	static shouldThrowOnConstruct = false;

	onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
	onerror: ((event: ErrorEvent) => void) | null = null;
	posted: unknown[] = [];
	terminated = 0;

	constructor(
		public url: string | URL,
		public opts?: WorkerOptions,
	) {
		if (FakeWorker.shouldThrowOnConstruct) {
			throw new Error("Worker construction blocked");
		}
		FakeWorker.instances.push(this);
	}

	postMessage(message: unknown) {
		this.posted.push(message);
	}

	terminate() {
		this.terminated++;
	}

	emitMessage(data: unknown) {
		this.onmessage?.({ data } as MessageEvent<unknown>);
	}

	emitError(message: string) {
		this.onerror?.({ message } as ErrorEvent);
	}
}

beforeEach(() => {
	FakeWorker.instances = [];
	FakeWorker.shouldThrowOnConstruct = false;
});

function makeOptions(
	overrides: Partial<ProxyGenerateOptions> = {},
): ProxyGenerateOptions {
	return {
		file: new File([new Uint8Array([1, 2, 3])], "clip.mov", {
			type: "video/quicktime",
		}),
		resolution: "480p",
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// isWorkerProxyEncodeSupported
// ---------------------------------------------------------------------------

describe("isWorkerProxyEncodeSupported", () => {
	it("is false when window is undefined (SSR-safe)", () => {
		stub("window", undefined);
		expect(isWorkerProxyEncodeSupported()).toBe(false);
	});

	it("is false when Worker is undefined", () => {
		stub("window", {});
		stub("Worker", undefined);
		expect(isWorkerProxyEncodeSupported()).toBe(false);
	});

	it("is false when OffscreenCanvas is undefined", () => {
		stub("window", {});
		stub("Worker", FakeWorker);
		stub("OffscreenCanvas", undefined);
		expect(isWorkerProxyEncodeSupported()).toBe(false);
	});

	it("is false when VideoEncoder is undefined", () => {
		stub("window", {});
		stub("Worker", FakeWorker);
		stub("OffscreenCanvas", FakeOffscreenCanvas);
		stub("VideoEncoder", undefined);
		expect(isWorkerProxyEncodeSupported()).toBe(false);
	});

	it("is true when window, Worker, OffscreenCanvas, and VideoEncoder are all present", () => {
		stubFullySupported();
		expect(isWorkerProxyEncodeSupported()).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// generateProxyOffThread — unsupported-environment fallback
// ---------------------------------------------------------------------------

describe("generateProxyOffThread fallback (unsupported environment)", () => {
	it("calls the main-thread generateProxy with the exact same options and returns its result", async () => {
		stub("window", undefined); // unsupported: no window at all

		const options = makeOptions();
		const result = await generateProxyOffThread(options);

		expect(generateProxyMock).toHaveBeenCalledTimes(1);
		expect(generateProxyMock.mock.calls[0][0]).toBe(options);
		expect(result).toBe(fallbackResult);
	});
});

// ---------------------------------------------------------------------------
// generateProxyOffThread — worker path
// ---------------------------------------------------------------------------

describe("generateProxyOffThread worker path", () => {
	it("spawns a worker, posts start with file+resolution, forwards progress, resolves on result, and terminates the worker", async () => {
		stubFullySupported();

		const options = makeOptions({ resolution: "720p" });
		const progress: number[] = [];
		options.onProgress = (p) => progress.push(p);

		const pending = generateProxyOffThread(options);

		expect(FakeWorker.instances).toHaveLength(1);
		const worker = FakeWorker.instances[0];
		expect(worker.posted).toEqual([
			{ type: "start", file: options.file, resolution: "720p" },
		]);

		worker.emitMessage({ type: "progress", progress: 0.5 });
		worker.emitMessage({ type: "progress", progress: 0.99 });
		const workerResult: ProxyGenerateResult = {
			file: options.file,
			width: 1280,
			height: 720,
		};
		worker.emitMessage({ type: "result", result: workerResult });

		const result = await pending;

		expect(progress).toEqual([0.5, 0.99]);
		expect(result).toBe(workerResult);
		expect(worker.terminated).toBe(1);
		// The worker path resolved a real job — the main-thread fallback must
		// never have been invoked.
		expect(generateProxyMock).not.toHaveBeenCalled();
	});

	it("rejects with the worker's error message on a genuine mid-encode failure (no fallback)", async () => {
		stubFullySupported();

		const pending = generateProxyOffThread(makeOptions());
		const worker = FakeWorker.instances[0];

		worker.emitMessage({ type: "error", message: "No video track found" });

		await expect(pending).rejects.toThrow("No video track found");
		expect(worker.terminated).toBe(1);
		expect(generateProxyMock).not.toHaveBeenCalled();
	});

	it("falls back to generateProxy once when the Worker constructor throws synchronously", async () => {
		stubFullySupported();
		FakeWorker.shouldThrowOnConstruct = true;

		const options = makeOptions();
		const result = await generateProxyOffThread(options);

		expect(FakeWorker.instances).toHaveLength(0);
		expect(generateProxyMock).toHaveBeenCalledTimes(1);
		expect(generateProxyMock.mock.calls[0][0]).toBe(options);
		expect(result).toBe(fallbackResult);
	});

	it("falls back to generateProxy once on a boot-time worker error (no prior message received)", async () => {
		stubFullySupported();

		const options = makeOptions();
		const pending = generateProxyOffThread(options);
		const worker = FakeWorker.instances[0];

		// Nothing has come back yet — this simulates the worker module failing
		// to load, not a mid-encode failure (which always arrives as a typed
		// "error" message instead, per the worker's own try/catch).
		worker.emitError("Failed to load module script");

		const result = await pending;

		expect(worker.terminated).toBe(1);
		expect(generateProxyMock).toHaveBeenCalledTimes(1);
		expect(generateProxyMock.mock.calls[0][0]).toBe(options);
		expect(result).toBe(fallbackResult);
	});

	it("rejects with the real worker error (not a fallback) once a message has already been received", async () => {
		stubFullySupported();

		const pending = generateProxyOffThread(makeOptions());
		const worker = FakeWorker.instances[0];

		worker.emitMessage({ type: "progress", progress: 0.2 });
		worker.emitError("worker crashed mid-encode");

		await expect(pending).rejects.toThrow("worker crashed mid-encode");
		expect(generateProxyMock).not.toHaveBeenCalled();
	});

	it("rejects immediately with the cancellation error when the signal is already aborted, without spawning a worker", async () => {
		stubFullySupported();

		const controller = new AbortController();
		controller.abort();

		await expect(
			generateProxyOffThread(makeOptions({ signal: controller.signal })),
		).rejects.toThrow("Proxy generation cancelled");
		expect(FakeWorker.instances).toHaveLength(0);
	});

	it("cancellation: posts a cancel message on abort, and the worker's own cancellation error settles the promise", async () => {
		stubFullySupported();

		const controller = new AbortController();
		const options = makeOptions({ signal: controller.signal });
		const pending = generateProxyOffThread(options);
		const worker = FakeWorker.instances[0];

		controller.abort();
		expect(worker.posted).toEqual([
			{ type: "start", file: options.file, resolution: "480p" },
			{ type: "cancel" },
		]);

		// The core's own per-frame abort check throws "Proxy generation
		// cancelled" and the worker posts it verbatim as an "error" message —
		// simulate that real-world race landing before the grace timer.
		worker.emitMessage({
			type: "error",
			message: "Proxy generation cancelled",
		});

		await expect(pending).rejects.toThrow("Proxy generation cancelled");
		expect(worker.terminated).toBe(1);
	});

	it("cancellation: a result racing in after cancel still resolves as a cancellation, not a silent success", async () => {
		stubFullySupported();

		const controller = new AbortController();
		const pending = generateProxyOffThread(
			makeOptions({ signal: controller.signal }),
		);
		const worker = FakeWorker.instances[0];

		controller.abort();
		// The job actually finished right before the cancel was observed —
		// the worker posts a normal result instead of an error.
		worker.emitMessage({
			type: "result",
			result: { file: new File([], "x.mp4"), width: 10, height: 10 },
		});

		await expect(pending).rejects.toThrow("Proxy generation cancelled");
	});

	it("cancellation: settles with the cancellation error via the grace timer if the worker never responds", async () => {
		stubFullySupported();

		const controller = new AbortController();
		const pending = generateProxyOffThread(
			makeOptions({ signal: controller.signal }),
		);
		controller.abort();

		await expect(pending).rejects.toThrow("Proxy generation cancelled");
	});
});

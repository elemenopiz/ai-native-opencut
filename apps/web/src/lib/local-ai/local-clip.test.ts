import { describe, expect, it } from "bun:test";
import { LOCAL_CLIP_MODEL_ID, LocalClip } from "./local-clip";
import { type EditorActivitySource, LocalAIScheduler } from "./scheduler";
import type { Timers } from "./timers";

/** Message the client posts to the worker. */
type ClipRequest = {
	kind: "texts" | "images";
	payload: { texts?: string[]; blobs?: Blob[] };
	modelId: string;
	device: "webgpu" | "wasm";
};

/** Messages the worker posts back, plus a test-only crash directive. */
type FakeReply =
	| { type: "load-progress"; payload: unknown }
	| { type: "result"; payload: { vectors: number[][] } }
	| { type: "error"; message: string }
	| { type: "crash"; message: string };

/**
 * Minimal fake Worker: each postMessage is answered (async, like a real
 * worker) with the message(s) `reply` produces for that request. A "crash"
 * reply is delivered to `error` listeners, like a real worker-script death.
 */
function fakeWorker(
	reply: (msg: ClipRequest) => FakeReply | FakeReply[],
	hooks: { onTerminate?: () => void } = {},
) {
	// biome-ignore lint/complexity/noBannedTypes: test double stores raw listeners.
	const listeners: Record<string, Function[]> = {
		message: [],
		error: [],
		messageerror: [],
	};
	return {
		// biome-ignore lint/complexity/noBannedTypes: test double stores raw listeners.
		addEventListener: (type: string, fn: Function) => {
			listeners[type]?.push(fn);
		},
		// biome-ignore lint/complexity/noBannedTypes: matches addEventListener above.
		removeEventListener: (type: string, fn: Function) => {
			const list = listeners[type];
			if (!list) return;
			const index = list.indexOf(fn);
			if (index !== -1) list.splice(index, 1);
		},
		terminate: () => hooks.onTerminate?.(),
		postMessage: (msg: ClipRequest) => {
			queueMicrotask(() => {
				const responses = reply(msg);
				for (const response of Array.isArray(responses)
					? responses
					: [responses]) {
					if (response.type === "crash") {
						for (const fn of [...listeners.error])
							fn({ message: response.message });
					} else {
						for (const fn of [...listeners.message]) fn({ data: response });
					}
				}
			});
		},
	} as unknown as Worker;
}

describe("LocalClip.embedTexts", () => {
	it("posts a texts request and resolves the worker's vectors as Float32Arrays", async () => {
		const seen: ClipRequest[] = [];
		const clip = new LocalClip({
			createWorker: () =>
				fakeWorker((msg) => {
					seen.push(msg);
					return {
						type: "result",
						payload: {
							vectors: [
								[1, 0, 0],
								[0, 1, 0],
							],
						},
					};
				}),
		});

		const vectors = await clip.embedTexts(["a cat", "a dog"]);

		expect(seen).toHaveLength(1);
		expect(seen[0].kind).toBe("texts");
		expect(seen[0].payload.texts).toEqual(["a cat", "a dog"]);
		expect(seen[0].modelId).toBe(LOCAL_CLIP_MODEL_ID);
		expect(["webgpu", "wasm"]).toContain(seen[0].device);

		expect(vectors).toHaveLength(2);
		expect(vectors[0]).toBeInstanceOf(Float32Array);
		expect(vectors[1]).toBeInstanceOf(Float32Array);
		expect(Array.from(vectors[0])).toEqual([1, 0, 0]);
		expect(Array.from(vectors[1])).toEqual([0, 1, 0]);
	});

	it("maps worker load-progress messages onto onProgress", async () => {
		const clip = new LocalClip({
			createWorker: () =>
				fakeWorker(() => [
					{
						type: "load-progress",
						payload: { status: "progress", progress: 50, file: "model.onnx" },
					},
					{ type: "result", payload: { vectors: [[1]] } },
				]),
		});

		const updates: Array<{
			stage: string;
			progress: number;
			message?: string;
		}> = [];
		await clip.embedTexts(["x"], (p) => updates.push(p));

		const loading = updates.filter(
			(u) => u.stage === "loading-model" && u.progress === 0.5,
		);
		expect(loading).toHaveLength(1);
		expect(loading[0].message).toBe("model.onnx");
		// Terminal update signals the embed itself finished.
		expect(updates.at(-1)).toMatchObject({ stage: "embedding", progress: 1 });
	});
});

describe("LocalClip.embedImages", () => {
	it("posts an images request with the blobs and resolves vectors", async () => {
		const blobs = [new Blob(["a"]), new Blob(["b"])];
		const seen: ClipRequest[] = [];
		const clip = new LocalClip({
			createWorker: () =>
				fakeWorker((msg) => {
					seen.push(msg);
					return {
						type: "result",
						payload: {
							vectors: [
								[0.5, 0.5],
								[1, 0],
							],
						},
					};
				}),
		});

		const vectors = await clip.embedImages(blobs);

		expect(seen).toHaveLength(1);
		expect(seen[0].kind).toBe("images");
		expect(seen[0].payload.blobs).toHaveLength(2);
		expect(seen[0].payload.blobs?.[0]).toBe(blobs[0]);
		expect(vectors).toHaveLength(2);
		expect(vectors[0]).toBeInstanceOf(Float32Array);
		expect(Array.from(vectors[1])).toEqual([1, 0]);
	});
});

describe("LocalClip error handling", () => {
	it("rejects when the worker reports an error, then recovers", async () => {
		let calls = 0;
		const clip = new LocalClip({
			createWorker: () =>
				fakeWorker(() => {
					calls += 1;
					if (calls === 1) return { type: "error", message: "model exploded" };
					return { type: "result", payload: { vectors: [[1]] } };
				}),
		});

		await expect(clip.embedTexts(["boom"])).rejects.toThrow("model exploded");
		// The queue must not stay poisoned after a failed request.
		const vectors = await clip.embedTexts(["ok"]);
		expect(Array.from(vectors[0])).toEqual([1]);
	});

	it("recycles a crashed worker so the next request gets a fresh one", async () => {
		let workersCreated = 0;
		let terminations = 0;
		const clip = new LocalClip({
			createWorker: () => {
				workersCreated += 1;
				const dies = workersCreated === 1;
				return fakeWorker(
					() =>
						dies
							? { type: "crash", message: "script blew up" }
							: { type: "result", payload: { vectors: [[1]] } },
					{ onTerminate: () => terminations++ },
				);
			},
		});

		await expect(clip.embedTexts(["boom"])).rejects.toThrow("script blew up");
		expect(terminations).toBe(1);

		// The dead worker must not be reused — a fresh one serves the retry.
		const vectors = await clip.embedTexts(["ok"]);
		expect(workersCreated).toBe(2);
		expect(Array.from(vectors[0])).toEqual([1]);
	});
});

/** Controllable activity source standing in for the editor's play/export state. */
function fakeActivity(initialBusy: boolean) {
	let busy = initialBusy;
	const listeners = new Set<() => void>();
	const source: EditorActivitySource = {
		getIsBusy: () => busy,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	return {
		source,
		setBusy(next: boolean) {
			busy = next;
			for (const fn of [...listeners]) fn();
		},
	};
}

/** Manual timers: nothing fires until the test says so. */
function fakeTimers() {
	let nextId = 1;
	const pending = new Map<number, { fn: () => void; ms: number }>();
	const timers: Timers = {
		schedule: (fn, ms) => {
			const id = nextId++;
			pending.set(id, { fn, ms });
			return id;
		},
		cancel: (handle) => {
			pending.delete(handle as number);
		},
	};
	return {
		timers,
		pending,
		fire() {
			const batch = [...pending.values()];
			pending.clear();
			for (const { fn } of batch) fn();
		},
	};
}

/** Let queued microtasks/macrotasks (worker replies, queue chaining) run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("LocalClip editor-priority scheduling", () => {
	it("holds a queued request while the editor is busy and dispatches on idle", async () => {
		const activity = fakeActivity(true);
		const scheduler = new LocalAIScheduler();
		scheduler.attach(activity.source);

		const seen: ClipRequest[] = [];
		const clip = new LocalClip({
			scheduler,
			createWorker: () =>
				fakeWorker((msg) => {
					seen.push(msg);
					return { type: "result", payload: { vectors: [[1]] } };
				}),
		});

		let resolved = false;
		const pending = clip.embedTexts(["held"]).then((v) => {
			resolved = true;
			return v;
		});
		await settle();
		// Nothing reached the worker while the editor is busy.
		expect(seen).toHaveLength(0);
		expect(resolved).toBe(false);

		activity.setBusy(false);
		const vectors = await pending;
		expect(seen).toHaveLength(1);
		expect(Array.from(vectors[0])).toEqual([1]);
	});

	it("lets an in-flight request finish when the editor goes busy mid-request, holding the next", async () => {
		const activity = fakeActivity(false);
		const scheduler = new LocalAIScheduler();
		scheduler.attach(activity.source);

		// Worker that only replies when the test says so.
		const posted: Array<() => void> = [];
		// biome-ignore lint/complexity/noBannedTypes: test double stores raw listeners.
		const listeners: Record<string, Function[]> = { message: [], error: [] };
		const worker = {
			// biome-ignore lint/complexity/noBannedTypes: test double stores raw listeners.
			addEventListener: (type: string, fn: Function) =>
				listeners[type]?.push(fn),
			// biome-ignore lint/complexity/noBannedTypes: matches addEventListener.
			removeEventListener: (type: string, fn: Function) => {
				const index = listeners[type]?.indexOf(fn) ?? -1;
				if (index !== -1) listeners[type]?.splice(index, 1);
			},
			terminate: () => {},
			postMessage: () => {
				posted.push(() => {
					for (const fn of [...listeners.message])
						fn({ data: { type: "result", payload: { vectors: [[7]] } } });
				});
			},
		} as unknown as Worker;

		const clip = new LocalClip({ scheduler, createWorker: () => worker });

		const first = clip.embedTexts(["in-flight"]);
		await settle();
		expect(posted).toHaveLength(1);

		// Editor goes busy while the first request is mid-flight.
		activity.setBusy(true);
		const second = clip.embedTexts(["queued"]);
		await settle();

		// The in-flight request is not aborted: delivering its result resolves it.
		posted[0]();
		const firstVectors = await first;
		expect(Array.from(firstVectors[0])).toEqual([7]);

		// The queued request stays held until the editor idles again.
		await settle();
		expect(posted).toHaveLength(1);

		activity.setBusy(false);
		await settle();
		expect(posted).toHaveLength(2);
		posted[1]();
		await second;
	});

	it("starvation valve releases a held request after the busy cap", async () => {
		const clock = fakeTimers();
		const activity = fakeActivity(true);
		const scheduler = new LocalAIScheduler({ timers: clock.timers });
		scheduler.attach(activity.source);

		const clip = new LocalClip({
			scheduler,
			createWorker: () =>
				fakeWorker(() => ({ type: "result", payload: { vectors: [[1]] } })),
		});

		const pending = clip.embedTexts(["starved"]);
		await settle();

		// Still busy — but the valve fires and lets the request trickle through.
		clock.fire();
		const vectors = await pending;
		expect(Array.from(vectors[0])).toEqual([1]);
	});
});

describe("LocalClip idle unload", () => {
	function makeClip() {
		const clock = fakeTimers();
		let workersCreated = 0;
		let terminations = 0;
		const clip = new LocalClip({
			scheduler: new LocalAIScheduler(),
			timers: clock.timers,
			createWorker: () => {
				workersCreated += 1;
				return fakeWorker(
					() => ({ type: "result", payload: { vectors: [[1]] } }),
					{ onTerminate: () => terminations++ },
				);
			},
		});
		return {
			clip,
			clock,
			created: () => workersCreated,
			terminated: () => terminations,
		};
	}

	it("terminates the warm worker after the idle timeout; next request recreates it", async () => {
		const c = makeClip();
		await c.clip.embedTexts(["warm"]);
		expect(c.created()).toBe(1);
		expect(c.clock.pending.size).toBe(1);

		c.clock.fire();
		expect(c.terminated()).toBe(1);

		// Next request spins up a fresh worker exactly like first use.
		await c.clip.embedTexts(["cold-start"]);
		expect(c.created()).toBe(2);
	});

	it("resets the unload countdown on new requests", async () => {
		const c = makeClip();
		await c.clip.embedTexts(["one"]);
		await c.clip.embedTexts(["two"]);

		// Only the latest countdown is pending; the worker stayed warm across
		// both requests.
		expect(c.clock.pending.size).toBe(1);
		expect(c.created()).toBe(1);
		expect(c.terminated()).toBe(0);

		c.clock.fire();
		expect(c.terminated()).toBe(1);
	});
});

describe("LocalClip request serialization", () => {
	it("runs one request at a time on a single warm worker and routes results correctly", async () => {
		let workersCreated = 0;
		const clip = new LocalClip({
			createWorker: () => {
				workersCreated += 1;
				// Echo a vector derived from the request. Without serialization
				// both callers' listeners are attached when the first result
				// arrives, so both would resolve with the *first* echo — the
				// per-caller assertions below catch that.
				return fakeWorker((msg) => ({
					type: "result",
					payload: { vectors: [[msg.payload.texts?.length ?? -1]] },
				}));
			},
		});

		const [a, b] = await Promise.all([
			clip.embedTexts(["one"]),
			clip.embedTexts(["one", "two"]),
		]);

		expect(workersCreated).toBe(1);
		expect(Array.from(a[0])).toEqual([1]);
		expect(Array.from(b[0])).toEqual([2]);
	});
});

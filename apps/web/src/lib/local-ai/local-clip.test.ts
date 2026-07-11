import { describe, expect, it } from "bun:test";
import { LOCAL_CLIP_MODEL_ID, LocalClip } from "./local-clip";

/** Message the client posts to the worker. */
type ClipRequest = {
	kind: "texts" | "images";
	payload: { texts?: string[]; blobs?: Blob[] };
	modelId: string;
	device: "webgpu" | "wasm";
};

/** Messages the worker posts back. */
type ClipResponse =
	| { type: "load-progress"; payload: unknown }
	| { type: "result"; payload: { vectors: number[][] } }
	| { type: "error"; message: string };

/**
 * Minimal fake Worker: each postMessage is answered (async, like a real
 * worker) with the message(s) `reply` produces for that request.
 */
function fakeWorker(
	reply: (msg: ClipRequest) => ClipResponse | ClipResponse[],
) {
	// biome-ignore lint/complexity/noBannedTypes: test double stores raw listeners.
	const listeners: Record<string, Function[]> = { message: [], error: [] };
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
		postMessage: (msg: ClipRequest) => {
			queueMicrotask(() => {
				const responses = reply(msg);
				for (const response of Array.isArray(responses)
					? responses
					: [responses]) {
					for (const fn of [...listeners.message]) fn({ data: response });
				}
			});
		},
	} as unknown as Worker;
}

describe("LocalClip.embedTexts", () => {
	it("posts a texts request and resolves normalized Float32Array vectors", async () => {
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

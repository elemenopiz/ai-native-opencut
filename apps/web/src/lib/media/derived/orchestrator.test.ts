import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import type { MediaAsset } from "@/types/assets";

/**
 * Mocks decode-audio and visual-analysis (real audio decode needs
 * `AudioContext`, real frame sampling needs `HTMLVideoElement`/canvas —
 * neither exists in bun test) so this file exercises ONLY the orchestration
 * logic: which kinds run, how status transitions, dedup/force behavior.
 * "Import AFTER the mocks" convention, matching `auto-cut/apply.test.ts`.
 *
 * Deliberately does NOT mock `./derived-store`: `mock.module` replaces a
 * module for the WHOLE bun test process, and a partial (or behaviorally
 * inert) stub would clobber `derived-store.roundtrip.test.ts`'s real
 * round-trip coverage if both files run together. Instead this file installs
 * the SAME small fake-IndexedDB fixture that file uses (see its own comment
 * for why bun test has no real IndexedDB) so `runDerivedAnalysis` persists
 * through the real `derived-store.ts` — genuine persistence behavior, no
 * global-module collision risk.
 */

let decodeImpl: () => Promise<Float32Array> = async () =>
	new Float32Array(16000);
mock.module("@/lib/media/decode-audio", () => ({
	DECODE_SAMPLE_RATE: 16000,
	decodeToMono16k: () => decodeImpl(),
}));

let visualImpl: () => Promise<{
	shots: { timeSec: number; strength: number }[];
	motionEnergy: { startSec: number; stepSec: number; values: Uint8Array };
	headTail: { head: null; tail: null };
	sampleCount: number;
}> = async () => ({
	shots: [],
	motionEnergy: { startSec: 0, stepSec: 1, values: new Uint8Array(0) },
	headTail: { head: null, tail: null },
	sampleCount: 0,
});
mock.module("./visual-analysis", () => ({
	analyzeVisualDerivations: () => visualImpl(),
}));

// ── Minimal fake IndexedDB (mirrors derived-store.roundtrip.test.ts) ────────

class FakeRequest<T> {
	result: T | undefined;
	onsuccess: (() => void) | null = null;
	onerror: (() => void) | null = null;
	succeed(result: T): void {
		this.result = result;
		queueMicrotask(() => this.onsuccess?.());
	}
}

class FakeObjectStore {
	private records = new Map<string, unknown>();
	constructor(private keyPath: string) {}
	put(value: Record<string, unknown>): FakeRequest<string> {
		const req = new FakeRequest<string>();
		const key = value[this.keyPath] as string;
		this.records.set(key, structuredClone(value));
		req.succeed(key);
		return req;
	}
	get(key: string): FakeRequest<unknown> {
		const req = new FakeRequest<unknown>();
		req.succeed(this.records.get(key));
		return req;
	}
	delete(key: string): FakeRequest<undefined> {
		const req = new FakeRequest<undefined>();
		this.records.delete(key);
		req.succeed(undefined);
		return req;
	}
	clear(): FakeRequest<undefined> {
		const req = new FakeRequest<undefined>();
		this.records.clear();
		req.succeed(undefined);
		return req;
	}
}

class FakeTransaction {
	constructor(private store: FakeObjectStore) {}
	objectStore(): FakeObjectStore {
		return this.store;
	}
}

class FakeDatabase {
	private stores = new Map<string, FakeObjectStore>();
	objectStoreNames = { contains: (name: string) => this.stores.has(name) };
	createObjectStore(name: string, opts: { keyPath: string }): FakeObjectStore {
		const store = new FakeObjectStore(opts.keyPath);
		this.stores.set(name, store);
		return store;
	}
	transaction(name: string): FakeTransaction {
		const store = this.stores.get(name);
		if (!store) throw new Error(`no such store: ${name}`);
		return new FakeTransaction(store);
	}
}

let realIndexedDB: unknown;

beforeAll(() => {
	realIndexedDB = (globalThis as { indexedDB?: unknown }).indexedDB;
	const db = new FakeDatabase();
	const fakeIndexedDB = {
		open(_name: string, _version: number) {
			const req =
				new FakeRequest<FakeDatabase>() as FakeRequest<FakeDatabase> & {
					onupgradeneeded:
						| ((event: { target: { result: FakeDatabase } }) => void)
						| null;
				};
			req.onupgradeneeded = null;
			queueMicrotask(() => {
				req.onupgradeneeded?.({ target: { result: db } });
				req.succeed(db);
			});
			return req;
		},
	};
	(globalThis as { indexedDB: unknown }).indexedDB = fakeIndexedDB;
});

afterAll(() => {
	(globalThis as { indexedDB: unknown }).indexedDB = realIndexedDB;
});

const { runDerivedAnalysis } = await import("./orchestrator");
const {
	getDerivedStatus,
	getSilenceAnalysis,
	getLoudnessAnalysis,
	getBeatAnalysis,
} = await import("./derived-store");

function videoAsset(id: string): MediaAsset {
	return {
		id,
		name: `${id}.mp4`,
		type: "video",
		file: new File([new Uint8Array([1, 2, 3])], `${id}.mp4`, {
			type: "video/mp4",
		}),
		url: `blob:${id}`,
	} as MediaAsset;
}

function audioAsset(id: string): MediaAsset {
	return {
		id,
		name: `${id}.wav`,
		type: "audio",
		file: new File([new Uint8Array([1, 2, 3])], `${id}.wav`, {
			type: "audio/wav",
		}),
	} as MediaAsset;
}

function imageAsset(id: string): MediaAsset {
	return {
		id,
		name: `${id}.png`,
		type: "image",
		file: new File([new Uint8Array([1, 2, 3])], `${id}.png`, {
			type: "image/png",
		}),
	} as MediaAsset;
}

/** A loud, clearly non-silent, rhythmically-clicking PCM buffer. */
function clickTrackSamples(): Float32Array {
	const sampleRate = 16000;
	const samples = new Float32Array(sampleRate * 4);
	for (let t = 0; t < 4; t += 0.5) {
		const start = Math.round(t * sampleRate);
		for (let i = start; i < Math.min(samples.length, start + 160); i++)
			samples[i] = 1;
	}
	return samples;
}

describe("runDerivedAnalysis — orchestration", () => {
	it("computes and persists silence/loudness/beats/shots for a video asset", async () => {
		decodeImpl = async () => clickTrackSamples();
		visualImpl = async () => ({
			shots: [{ timeSec: 3, strength: 1.2 }],
			motionEnergy: {
				startSec: 0,
				stepSec: 1,
				values: new Uint8Array([10, 20]),
			},
			headTail: { head: null, tail: null },
			sampleCount: 4,
		});

		const derived = await runDerivedAnalysis(videoAsset("orc-v1"));

		expect(derived.silence.state).toBe("ready");
		expect(derived.loudness.state).toBe("ready");
		expect(derived.beats.state).toBe("ready");
		expect(derived.shots.state).toBe("ready");
		// Kinds this module doesn't own are left exactly as seeded.
		expect(derived.transcript.state).toBe("absent");

		const persisted = await getDerivedStatus("orc-v1");
		expect(persisted?.derived.shots.state).toBe("ready");
	});

	it("marks loudness/beats empty (not failed, not absent) for a genuinely silent audio asset", async () => {
		decodeImpl = async () => new Float32Array(16000 * 2); // pure silence
		const derived = await runDerivedAnalysis(audioAsset("orc-a1"));

		expect(derived.loudness.state).toBe("empty");
		expect(derived.loudness.reason).toBeTruthy();
		expect(derived.beats.state).toBe("empty");
		// Silence detection itself still produced a real (if boring) result.
		expect(derived.silence.state).toBe("ready");
		// Audio assets structurally can't have shots.
		expect(derived.shots.state).toBe("unsupported");
	});

	it("marks silence/loudness/beats failed when decode throws, and auto-retries a failed kind on the next call", async () => {
		decodeImpl = async () => {
			throw new Error("boom");
		};
		const first = await runDerivedAnalysis(audioAsset("orc-a2"));
		expect(first.silence.state).toBe("failed");
		expect(first.loudness.state).toBe("failed");
		expect(first.beats.state).toBe("failed");
		// User-safe: no raw error message leaked into `reason`.
		expect(first.silence.reason).not.toContain("boom");

		decodeImpl = async () => clickTrackSamples();
		const second = await runDerivedAnalysis(audioAsset("orc-a2"));
		expect(second.silence.state).toBe("ready");
		expect(second.loudness.state).toBe("ready");
		expect(second.beats.state).toBe("ready");
	});

	it("skips already-settled kinds unless force is set", async () => {
		decodeImpl = async () => clickTrackSamples();
		const asset = audioAsset("orc-a3");

		await runDerivedAnalysis(asset);
		const firstRun = await getLoudnessAnalysis("orc-a3");
		expect(firstRun).toBeDefined();

		// Second call, no force: already "ready" — timestamp must NOT advance.
		await new Promise((resolve) => setTimeout(resolve, 5));
		await runDerivedAnalysis(asset);
		const noForceRerun = await getLoudnessAnalysis("orc-a3");
		expect(noForceRerun?.analyzedAt).toBe(firstRun?.analyzedAt);

		// force: true recomputes (new timestamp) even though already settled.
		await new Promise((resolve) => setTimeout(resolve, 5));
		await runDerivedAnalysis(asset, { force: true });
		const forced = await getLoudnessAnalysis("orc-a3");
		expect(forced?.analyzedAt).toBeGreaterThan(firstRun?.analyzedAt ?? 0);
	});

	it("persists an unsupported-only image asset without touching decode or visual analysis", async () => {
		let decodeCalled = false;
		let visualCalled = false;
		decodeImpl = async () => {
			decodeCalled = true;
			return new Float32Array(0);
		};
		visualImpl = async () => {
			visualCalled = true;
			return {
				shots: [],
				motionEnergy: { startSec: 0, stepSec: 1, values: new Uint8Array(0) },
				headTail: { head: null, tail: null },
				sampleCount: 0,
			};
		};

		const derived = await runDerivedAnalysis(imageAsset("orc-img1"));

		expect(decodeCalled).toBe(false);
		expect(visualCalled).toBe(false);
		expect(derived.silence.state).toBe("unsupported");
		expect(derived.shots.state).toBe("unsupported");

		const persisted = await getDerivedStatus("orc-img1");
		expect(persisted).toBeDefined();
	});

	it("marks shots failed (not thrown) when the asset has no source URL", async () => {
		const asset = videoAsset("orc-v2");
		asset.url = undefined;
		const derived = await runDerivedAnalysis(asset);
		expect(derived.shots.state).toBe("failed");
		expect(derived.shots.reason).toBeTruthy();
	});

	it("still runs silence detection on real (non-mocked) engine logic against decoded samples", async () => {
		// Sanity check that this file's mocks don't accidentally bypass the real
		// pure detectSilenceSegments/computeLUFS/detectBeatGrid — only the
		// browser-only decode/sampling steps are mocked.
		decodeImpl = async () => clickTrackSamples();
		await runDerivedAnalysis(audioAsset("orc-a4"));
		const silence = await getSilenceAnalysis("orc-a4");
		expect(silence?.segments.length).toBeGreaterThan(0);
		expect(silence?.duration).toBeCloseTo(4, 1);
	});
});

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	deleteDerivedMedia,
	getBeatAnalysis,
	getDerivedStatus,
	getLoudnessAnalysis,
	getSilenceAnalysis,
	getVisualAnalysis,
	saveBeatAnalysis,
	saveDerivedStatus,
	saveLoudnessAnalysis,
	saveSilenceAnalysis,
	saveVisualAnalysis,
} from "./derived-store";
import { createInitialDerived, ready, withStatus } from "./derived-status";

// ── I/O: round-trip against a minimal in-memory IndexedDB fake ─────────────
//
// bun test has no real IndexedDB (see director-conversation-store.roundtrip
// test's comment for the established pattern this mirrors). SEPARATE FILE,
// on purpose: `derived-store.ts` memoizes its connection in a module-level
// `dbPromise`, so any other test file that imports it without installing the
// fake first would poison the cache.
//
// Uses `structuredClone` (NOT JSON.stringify/parse) to clone stored values —
// real IndexedDB uses structured clone under the hood, and this module
// persists a real `Uint8Array` (`EncodedMotionEnergy.values`), which
// JSON-round-tripping would silently corrupt into `{}`.

class FakeRequest<T> {
	result: T | undefined;
	error: unknown = null;
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

describe("derived-store — round-trip (fake IndexedDB)", () => {
	it("round-trips a full AssetDerived status record", async () => {
		const derived = withStatus(
			createInitialDerived("video"),
			"silence",
			ready("on-device"),
		);
		await saveDerivedStatus({ mediaId: "rt-asset-1", derived });
		const loaded = await getDerivedStatus("rt-asset-1");
		expect(loaded?.derived.silence.state).toBe("ready");
		expect(loaded?.derived.loudness.state).toBe("absent");
	});

	it("round-trips a silence analysis record", async () => {
		await saveSilenceAnalysis({
			mediaId: "rt-asset-2",
			segments: [{ start: 0, end: 1.2, action: { type: "cut" } }],
			timebase: 30,
			duration: 10,
			analyzedAt: 12345,
		});
		const loaded = await getSilenceAnalysis("rt-asset-2");
		expect(loaded?.segments).toEqual([
			{ start: 0, end: 1.2, action: { type: "cut" } },
		]);
		expect(loaded?.duration).toBe(10);
	});

	it("round-trips a loudness analysis record", async () => {
		await saveLoudnessAnalysis({
			mediaId: "rt-asset-3",
			measurement: {
				integrated: -14,
				shortTerm: -13,
				momentary: -10,
				truePeak: -1,
				range: 5,
			},
			analyzedAt: 999,
		});
		const loaded = await getLoudnessAnalysis("rt-asset-3");
		expect(loaded?.measurement.integrated).toBe(-14);
	});

	it("round-trips a beat analysis record", async () => {
		await saveBeatAnalysis({
			mediaId: "rt-asset-4",
			bpm: 120,
			confidence: 0.9,
			beats: [0, 0.5, 1, 1.5],
			downbeats: [0, 1.5],
			energyClass: "high",
			analyzedAt: 42,
		});
		const loaded = await getBeatAnalysis("rt-asset-4");
		expect(loaded?.beats).toEqual([0, 0.5, 1, 1.5]);
		expect(loaded?.bpm).toBe(120);
	});

	it("round-trips a visual analysis record INCLUDING the Uint8Array motion-energy payload", async () => {
		const values = new Uint8Array([0, 64, 128, 255]);
		await saveVisualAnalysis({
			mediaId: "rt-asset-5",
			shots: [{ timeSec: 3, strength: 1.8 }],
			motionEnergy: { startSec: 0, stepSec: 1, values },
			headTail: { head: null, tail: null },
			sampleCount: 4,
			analyzedAt: 7,
		});
		const loaded = await getVisualAnalysis("rt-asset-5");
		expect(loaded?.shots).toEqual([{ timeSec: 3, strength: 1.8 }]);
		expect(loaded?.motionEnergy.values).toBeInstanceOf(Uint8Array);
		expect(Array.from(loaded?.motionEnergy.values ?? [])).toEqual([
			0, 64, 128, 255,
		]);
	});

	it("deleteDerivedMedia clears every store for that mediaId", async () => {
		await saveDerivedStatus({
			mediaId: "rt-asset-6",
			derived: createInitialDerived("audio"),
		});
		await saveLoudnessAnalysis({
			mediaId: "rt-asset-6",
			measurement: {
				integrated: -20,
				shortTerm: -20,
				momentary: -18,
				truePeak: -3,
				range: 2,
			},
			analyzedAt: 1,
		});

		await deleteDerivedMedia("rt-asset-6");

		expect(await getDerivedStatus("rt-asset-6")).toBeUndefined();
		expect(await getLoudnessAnalysis("rt-asset-6")).toBeUndefined();
	});

	it("returns undefined for a mediaId that was never analyzed", async () => {
		expect(await getDerivedStatus("never-seen")).toBeUndefined();
		expect(await getBeatAnalysis("never-seen")).toBeUndefined();
	});
});

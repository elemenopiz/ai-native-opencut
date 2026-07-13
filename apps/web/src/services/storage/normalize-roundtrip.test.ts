import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	test,
} from "bun:test";
import type { MediaAsset } from "@/types/assets";

// In-memory, shared-by-name adapter backends. saveMediaAsset and loadMediaAsset
// each construct their own adapter instances (via getProjectMediaAdapters), so
// the backing store must persist across instances keyed by name — mirroring how
// IndexedDB/OPFS persist independently of the JS wrapper object.
const metaStores = new Map<string, Map<string, unknown>>();
const fileStores = new Map<string, Map<string, File>>();

function bucket<T>(reg: Map<string, Map<string, T>>, key: string) {
	let m = reg.get(key);
	if (!m) {
		m = new Map<string, T>();
		reg.set(key, m);
	}
	return m;
}

mock.module("@/services/storage/indexeddb-adapter", () => ({
	IndexedDBAdapter: class {
		private store: Map<string, unknown>;
		constructor(dbName: string, storeName: string) {
			this.store = bucket(metaStores, `${dbName}:${storeName}`);
		}
		async get(key: string) {
			return this.store.get(key) ?? null;
		}
		async set(key: string, value: unknown) {
			this.store.set(key, value);
		}
		async remove(key: string) {
			this.store.delete(key);
		}
		async list() {
			return [...this.store.keys()];
		}
		async clear() {
			this.store.clear();
		}
	},
	deleteDatabase: async () => {},
}));

mock.module("@/services/storage/opfs-adapter", () => ({
	OPFSAdapter: class {
		private store: Map<string, File>;
		constructor(dir: string) {
			this.store = bucket(fileStores, dir);
		}
		async get(key: string) {
			return this.store.get(key) ?? null;
		}
		async set(key: string, value: File) {
			this.store.set(key, value);
		}
		async remove(key: string) {
			this.store.delete(key);
		}
		async list() {
			return [...this.store.keys()];
		}
		async clear() {
			this.store.clear();
		}
	},
}));

const { storageService } = await import("@/services/storage/service");

// loadMediaAsset calls URL.createObjectURL; bun has it, but keep the round-trip
// deterministic and independent of blob-url internals.
const realCreate = URL.createObjectURL;
const realRevoke = URL.revokeObjectURL;

beforeEach(() => {
	metaStores.clear();
	fileStores.clear();
	URL.createObjectURL = (() => "blob:stub") as typeof URL.createObjectURL;
	URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
});

afterEach(() => {
	URL.createObjectURL = realCreate;
	URL.revokeObjectURL = realRevoke;
});

// mock.module registrations persist for the whole bun test process — restore
// them when this file is done so the in-memory adapter stubs can't leak into
// later test files that use the real IndexedDB/OPFS adapters.
afterAll(() => {
	mock.restore();
});

describe("saveMediaAsset → loadMediaAsset — normalized provenance round-trip", () => {
	test("normalized provenance survives a save/load cycle", async () => {
		const asset: MediaAsset = {
			id: "asset-1",
			name: "GX010042.mp4",
			type: "video",
			file: new File([new Uint8Array([1, 2, 3])], "GX010042-normalized.mp4", {
				type: "video/mp4",
			}),
			width: 1920,
			height: 1080,
			duration: 5,
			normalized: { originalName: "GX010042.mp4", originalCodec: "hevc" },
		};

		await storageService.saveMediaAsset({ projectId: "p1", mediaAsset: asset });
		const loaded = await storageService.loadMediaAsset({
			projectId: "p1",
			id: "asset-1",
		});

		expect(loaded).not.toBeNull();
		expect(loaded?.normalized).toEqual({
			originalName: "GX010042.mp4",
			originalCodec: "hevc",
		});
	});

	test("a passthrough asset (no normalized field) loads with normalized undefined", async () => {
		const asset: MediaAsset = {
			id: "asset-2",
			name: "clip.mp4",
			type: "video",
			file: new File([new Uint8Array([4, 5])], "clip.mp4", {
				type: "video/mp4",
			}),
		};

		await storageService.saveMediaAsset({ projectId: "p1", mediaAsset: asset });
		const loaded = await storageService.loadMediaAsset({
			projectId: "p1",
			id: "asset-2",
		});

		expect(loaded).not.toBeNull();
		expect(loaded?.normalized).toBeUndefined();
	});
});

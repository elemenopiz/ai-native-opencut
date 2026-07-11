import { describe, expect, it, mock } from "bun:test";
import type {
	EmbeddingStatus,
	MediaEmbedding,
} from "@/lib/search/embedding-types";

// In-memory stand-in for the IndexedDB embedding store. Mirrors the store's
// full export surface — mock.module leaks across test files, so any export
// another file touches must exist here too.
const savedEmbeddings = new Map<string, MediaEmbedding>();
const statuses = new Map<string, EmbeddingStatus>();

mock.module("@/services/search/embedding-store", () => ({
	getEmbedding: async (mediaId: string) => savedEmbeddings.get(mediaId),
	getAllEmbeddings: async () => [...savedEmbeddings.values()],
	saveEmbedding: async (record: MediaEmbedding) => {
		savedEmbeddings.set(record.mediaId, record);
	},
	deleteEmbedding: async (mediaId: string) => {
		savedEmbeddings.delete(mediaId);
		statuses.delete(mediaId);
	},
	clearAllEmbeddings: async () => {
		savedEmbeddings.clear();
		statuses.clear();
	},
	listIndexedMediaIds: async (modelName?: string) =>
		[...savedEmbeddings.values()]
			.filter((r) => modelName === undefined || r.modelName === modelName)
			.map((r) => r.mediaId),
	setStatus: async (status: EmbeddingStatus) => {
		statuses.set(status.mediaId, status);
	},
	getStatus: async (mediaId: string) => statuses.get(mediaId),
	getAllStatuses: async () => [...statuses.values()],
	getIndexedCount: async () => savedEmbeddings.size,
}));

// Import AFTER the mock is registered so the cache binds the stub store
// (repo convention: mock.module + dynamic import).
const { createSearchIndexCache, indexDigest } = await import(
	"./search-index-cache"
);

function record(
	mediaId: string,
	modelName: string,
	createdAt: number,
): MediaEmbedding {
	return {
		id: mediaId,
		mediaId,
		frames: [{ timestampSec: 0, vector: Float32Array.from([1, 0]) }],
		createdAt,
		modelName,
		tags: [],
	};
}

function indexedStatus(mediaId: string, createdAt: number): EmbeddingStatus {
	return { state: "indexed", mediaId, frameCount: 1, createdAt };
}

/** Seed one asset as the OLD server backend left it (stale vector space). */
function seedStale(mediaId: string, createdAt = 1_000) {
	savedEmbeddings.set(mediaId, record(mediaId, "ViT-B-32", createdAt));
	statuses.set(mediaId, indexedStatus(mediaId, createdAt));
}

/**
 * Simulate the migration re-index finishing for one asset, exactly as
 * indexMedia does it: keyed put of the record (store COUNT unchanged) plus an
 * "indexed" status with a fresh createdAt.
 */
function completeReindex(mediaId: string, createdAt = 2_000) {
	savedEmbeddings.set(mediaId, record(mediaId, "clip-vit-b32-web", createdAt));
	statuses.set(mediaId, indexedStatus(mediaId, createdAt));
}

describe("search index cache staleness", () => {
	it("reports stale before the first refresh", async () => {
		savedEmbeddings.clear();
		statuses.clear();
		const cache = createSearchIndexCache();
		expect(await cache.isStale()).toBe(true);
	});

	it("detects an in-place migration re-index even though the store count never changes", async () => {
		// The regression: an all-stale library re-indexed in the background.
		// saveEmbedding is a keyed put, so the raw record count is IDENTICAL
		// before and after — a count-based drift check never fires and the user
		// would see empty search results all session.
		savedEmbeddings.clear();
		statuses.clear();
		seedStale("clip-a");
		seedStale("clip-b");

		const cache = createSearchIndexCache();
		await cache.refresh();
		// All records are in the retired space: nothing searchable yet.
		expect(cache.records).toEqual([]);

		completeReindex("clip-a");
		completeReindex("clip-b");
		expect(savedEmbeddings.size).toBe(2); // count unchanged — the trap

		// The next search's pre-check MUST notice and re-read the vectors.
		expect(await cache.isStale()).toBe(true);
		await cache.refresh();
		expect(cache.records.map((r) => r.mediaId).sort()).toEqual([
			"clip-a",
			"clip-b",
		]);
	});

	it("stays fresh when nothing changed (no per-keystroke churn)", async () => {
		savedEmbeddings.clear();
		statuses.clear();
		completeReindex("clip-a");

		const cache = createSearchIndexCache();
		await cache.refresh();

		expect(await cache.isStale()).toBe(false);
		expect(await cache.isStale()).toBe(false);
	});

	it("ignores in-flight 'indexing' progress rows", async () => {
		// Progress rows mutate on every embed batch; reacting to them would
		// re-read all vectors per keystroke while a background pass runs.
		savedEmbeddings.clear();
		statuses.clear();
		completeReindex("clip-a");

		const cache = createSearchIndexCache();
		await cache.refresh();

		statuses.set("clip-b", {
			state: "indexing",
			mediaId: "clip-b",
			progress: 0.5,
			phase: "embedding",
		});
		expect(await cache.isStale()).toBe(false);

		// ...but the same asset FINISHING is a real change.
		statuses.set("clip-b", indexedStatus("clip-b", 3_000));
		savedEmbeddings.set("clip-b", record("clip-b", "clip-vit-b32-web", 3_000));
		expect(await cache.isStale()).toBe(true);
	});

	it("detects deletions (embedding + status rows removed together)", async () => {
		savedEmbeddings.clear();
		statuses.clear();
		completeReindex("clip-a");
		completeReindex("clip-b");

		const cache = createSearchIndexCache();
		await cache.refresh();

		savedEmbeddings.delete("clip-b");
		statuses.delete("clip-b");
		expect(await cache.isStale()).toBe(true);
	});
});

describe("indexDigest", () => {
	it("is order-independent and keyed on mediaId + createdAt", () => {
		const a = indexedStatus("a", 1);
		const b = indexedStatus("b", 2);
		expect(indexDigest([a, b])).toBe(indexDigest([b, a]));
		expect(indexDigest([a, b])).not.toBe(
			indexDigest([a, indexedStatus("b", 3)]),
		);
	});
});

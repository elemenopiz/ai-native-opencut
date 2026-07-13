import { describe, expect, it, mock } from "bun:test";
import type { EditorCore } from "@/core";
import type {
	EmbeddingStatus,
	MediaEmbedding,
} from "@/lib/search/embedding-types";
// Import the REAL module before mocking so the mock can re-export everything
// (LocalClip class, model constants) — bun's mock.module leaks across test
// files in one process, and local-clip.test.ts needs the real class.
import * as realLocalClip from "@/lib/local-ai/local-clip";

// The query embed goes through the `embeddings` seam, whose local adapter
// delegates to this singleton — stubbing here exercises the real seam wiring
// (same rationale as embedding-service.test.ts).
const embedTexts = mock(async (texts: string[]) =>
	texts.map(() => Float32Array.from([1, 0])),
);
const embedImages = mock(async (blobs: Blob[]) =>
	blobs.map(() => Float32Array.from([0, 1])),
);

mock.module("@/lib/local-ai/local-clip", () => ({
	...realLocalClip,
	localClip: { embedTexts, embedImages },
}));

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

// Import AFTER the mocks are registered so the api binds the stubs
// (repo convention: mock.module + dynamic import).
const { createDirectorApi } = await import("./director-api");

/** Minimal EditorCore stub: searchMedia only reads `media.getAssets()`. */
function makeEditor(): EditorCore {
	return {
		timeline: {
			getTotalDuration: () => 0,
			getTracks: () => [],
		},
		command: {
			beginTransaction: () => {},
			commitTransaction: () => {},
			rollbackTransaction: () => {},
			canUndo: () => false,
			canRedo: () => false,
		},
		media: {
			getAssetById: () => undefined,
			getAssets: () => [
				{ id: "fresh-1", name: "fresh.mp4", type: "video" },
				{ id: "stale-1", name: "stale.mp4", type: "video" },
			],
		},
		project: { getActiveOrNull: () => null },
	} as unknown as EditorCore;
}

function record(mediaId: string, modelName: string): MediaEmbedding {
	return {
		id: mediaId,
		mediaId,
		// Identical vectors: the stale record would be the co-top hit (cosine 1)
		// if model provenance were ignored.
		frames: [{ timestampSec: 3, vector: Float32Array.from([1, 0]) }],
		createdAt: 1,
		modelName,
		tags: [],
	};
}

describe("director searchMedia", () => {
	it("embeds the query in-browser and excludes stale-model records", async () => {
		savedEmbeddings.clear();
		embedTexts.mockClear();
		savedEmbeddings.set("fresh-1", record("fresh-1", "clip-vit-b32-web"));
		savedEmbeddings.set("stale-1", record("stale-1", "ViT-B-32"));

		const director = createDirectorApi(makeEditor());
		const result = await director.searchMedia({ query: "a boat at sunset" });

		expect(result.ok).toBe(true);
		expect(result.data).toEqual([
			{
				mediaId: "fresh-1",
				score: 1,
				timestampSec: 3,
				mediaName: "fresh.mp4",
				// The stub asset resolves (id "fresh-1" is in getAssets()) but carries
				// no width/height/duration, and no explicit `source` ⇒ "upload" (that
				// field's contract has no third "unknown" state — see MediaAssetData).
				source: "upload",
			},
		]);

		// The query text went through the local seam, not a server round-trip.
		expect(embedTexts.mock.calls.length).toBe(1);
		expect(embedTexts.mock.calls[0][0]).toEqual(["a boat at sunset"]);
	});

	it("reports 'nothing indexed' when only retired-space records remain", async () => {
		savedEmbeddings.clear();
		embedTexts.mockClear();
		savedEmbeddings.set("stale-1", record("stale-1", "ViT-B-32"));

		const director = createDirectorApi(makeEditor());
		const result = await director.searchMedia({ query: "a boat at sunset" });

		expect(result.ok).toBe(true);
		expect(result.data).toEqual([]);
		expect(result.message).toContain("No media indexed yet");
		// Short-circuits before embedding: no records are searchable at all.
		expect(embedTexts.mock.calls.length).toBe(0);
	});
});

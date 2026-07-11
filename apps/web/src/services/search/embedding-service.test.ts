import { describe, expect, it, mock } from "bun:test";
import {
	type EmbeddingStatus,
	type MediaEmbedding,
	ZERO_SHOT_LABELS,
} from "@/lib/search/embedding-types";
import type { MediaAsset } from "@/types/assets";
// Import the REAL module before mocking so the mock can re-export everything
// (LocalClip class, model constants) — bun's mock.module leaks across test
// files in one process, and local-clip.test.ts needs the real class.
import * as realLocalClip from "@/lib/local-ai/local-clip";

const DIM = ZERO_SHOT_LABELS.length;

/** One-hot vector in the test's DIM-dim space. */
function oneHot(index: number): Float32Array {
	const v = new Float32Array(DIM);
	v[index] = 1;
	return v;
}

/** Which label index the fake image encoder "sees" in every frame. */
const FRAME_LABEL_INDEX = 5; // ZERO_SHOT_LABELS[5] === "nature"

const embedImages = mock(async (blobs: Blob[]) =>
	blobs.map(() => oneHot(FRAME_LABEL_INDEX)),
);
// Each label prompt embeds to its own one-hot axis, so cosine against a frame
// vector cleanly picks out FRAME_LABEL_INDEX as the top zero-shot tag.
const embedTexts = mock(async (texts: string[]) =>
	texts.map((_, i) => oneHot(i)),
);

// The service calls the `embeddings` seam, whose local adapter delegates to
// this singleton — stubbing here exercises the real seam wiring. Mocking the
// seam module itself would collide with embeddings.test.ts (which needs the
// real adapter) via cross-file mock.module leakage.
mock.module("@/lib/local-ai/local-clip", () => ({
	...realLocalClip,
	localClip: { embedImages, embedTexts },
}));

// In-memory stand-in for the IndexedDB embedding store.
const savedEmbeddings = new Map<string, MediaEmbedding>();
const statuses = new Map<string, EmbeddingStatus>();

// Mirrors the store's full export surface — mock.module leaks across test
// files, so any export another file touches must exist here too.
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

// Import AFTER the mocks are registered so embedding-service binds the stubs
// (repo convention: mock.module + dynamic import).
const { embedBatches, findDuplicates, indexMedia } = await import(
	"./embedding-service"
);

/** An image asset backed by a data: URL so sampleImageFrame's fetch works in bun. */
function imageAsset(id: string): MediaAsset {
	return {
		id,
		name: `${id}.jpg`,
		type: "image",
		url: `data:image/jpeg;base64,${btoa(`pixels-${id}`)}`,
	} as MediaAsset;
}

describe("embedBatches", () => {
	it("routes blobs through localClip.embedImages in batches and keeps timestamps", async () => {
		embedImages.mockClear();
		const frames = Array.from({ length: 10 }, (_, i) => ({
			blob: new Blob([`frame-${i}`], { type: "image/jpeg" }),
			timestampSec: i * 2,
		}));
		const fractions: number[] = [];

		const out = await embedBatches(frames, (f) => fractions.push(f));

		// BATCH_SIZE is 8, so 10 frames = one call of 8 + one call of 2.
		expect(embedImages.mock.calls.length).toBe(2);
		expect(embedImages.mock.calls[0][0].length).toBe(8);
		expect(embedImages.mock.calls[1][0].length).toBe(2);
		// Blobs pass through untouched (no FormData wrapping).
		expect(embedImages.mock.calls[0][0][0]).toBe(frames[0].blob);

		expect(out.length).toBe(10);
		for (let i = 0; i < out.length; i++) {
			expect(out[i].timestampSec).toBe(i * 2);
			expect(out[i].vector).toBeInstanceOf(Float32Array);
			expect(out[i].vector.length).toBe(DIM);
		}
		expect(fractions).toEqual([0.8, 1]);
	});
});

describe("indexMedia", () => {
	it("records the local model name and zero-shot tags computed on-device", async () => {
		savedEmbeddings.clear();
		statuses.clear();
		embedImages.mockClear();

		const record = await indexMedia(imageAsset("img-1"));

		expect(record).not.toBeNull();
		expect(record?.modelName).toBe("clip-vit-b32-web");
		expect(record?.frames.length).toBe(1);
		expect(record?.frames[0].vector).toBeInstanceOf(Float32Array);

		// Zero-shot tags: label vectors are one-hot, frame vector is one-hot at
		// FRAME_LABEL_INDEX, so that label must win with cosine score 1.
		expect(record?.tags[0]).toEqual({
			label: ZERO_SHOT_LABELS[FRAME_LABEL_INDEX],
			score: 1,
		});
		expect(record?.tags.length).toBe(5);

		// Label prompts were embedded locally (with a caption template).
		expect(embedTexts.mock.calls.length).toBeGreaterThan(0);
		const prompts = embedTexts.mock.calls[0][0];
		expect(prompts.length).toBe(ZERO_SHOT_LABELS.length);
		expect(prompts[0]).toContain(ZERO_SHOT_LABELS[0]);

		expect(savedEmbeddings.get("img-1")?.modelName).toBe("clip-vit-b32-web");
		expect(statuses.get("img-1")?.state).toBe("indexed");
	});

	it("re-indexes assets stored under the retired server model name", async () => {
		savedEmbeddings.clear();
		statuses.clear();
		embedImages.mockClear();

		// Vectors from the old open_clip backend live in a different space —
		// the model-name mismatch must force a full re-embed, never a reuse.
		savedEmbeddings.set("img-2", {
			id: "img-2",
			mediaId: "img-2",
			frames: [{ timestampSec: 0, vector: oneHot(0) }],
			createdAt: 1,
			modelName: "ViT-B-32",
			tags: [],
		});

		const record = await indexMedia(imageAsset("img-2"));

		expect(embedImages.mock.calls.length).toBe(1);
		expect(record?.modelName).toBe("clip-vit-b32-web");
		expect(record?.createdAt).not.toBe(1);
	});

	it("skips assets already indexed under the local model name", async () => {
		savedEmbeddings.clear();
		statuses.clear();
		embedImages.mockClear();

		const existing: MediaEmbedding = {
			id: "img-3",
			mediaId: "img-3",
			frames: [{ timestampSec: 0, vector: oneHot(0) }],
			createdAt: 42,
			modelName: "clip-vit-b32-web",
			tags: [],
		};
		savedEmbeddings.set("img-3", existing);

		const record = await indexMedia(imageAsset("img-3"));

		expect(embedImages.mock.calls.length).toBe(0);
		expect(record).toBe(existing);
	});

	it("embeds the zero-shot label set only once per session", async () => {
		// Self-contained (no reliance on earlier tests warming the cache): the
		// first indexMedia populates the module-level label-vector cache, the
		// second must reuse it — the static label list never needs re-embedding.
		savedEmbeddings.clear();
		await indexMedia(imageAsset("img-4"));
		const afterFirst = embedTexts.mock.calls.length;
		expect(afterFirst).toBeGreaterThan(0);
		savedEmbeddings.clear();
		await indexMedia(imageAsset("img-5"));
		expect(embedTexts.mock.calls.length).toBe(afterFirst);
	});
});

describe("findDuplicates", () => {
	it("excludes stale-model records from duplicate detection", async () => {
		savedEmbeddings.clear();
		statuses.clear();

		// Three assets with IDENTICAL frame vectors — all would pair up (cosine
		// 1) if model provenance were ignored. One is from the retired server
		// backend; only the fresh-fresh pair may be reported.
		const frame = { timestampSec: 0, vector: oneHot(3) };
		const record = (mediaId: string, modelName: string): MediaEmbedding => ({
			id: mediaId,
			mediaId,
			frames: [frame],
			createdAt: 1,
			modelName,
			tags: [],
		});
		savedEmbeddings.set("dup-a", record("dup-a", "clip-vit-b32-web"));
		savedEmbeddings.set("dup-b", record("dup-b", "clip-vit-b32-web"));
		savedEmbeddings.set("stale-c", record("stale-c", "ViT-B-32"));

		const pairs = await findDuplicates();

		expect(pairs).toEqual([{ mediaIdA: "dup-a", mediaIdB: "dup-b", score: 1 }]);
	});
});

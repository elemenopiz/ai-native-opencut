import { describe, expect, it, mock } from "bun:test";
import type { LocalClipProgress } from "./local-clip";
// Import the REAL module before mocking so the mock can re-export everything
// (LocalClip class, model constants) — bun's mock.module leaks across test
// files in one process, and local-clip.test.ts needs the real class.
import * as realLocalClip from "./local-clip";

const textVectors = [Float32Array.from([1, 0])];
const imageVectors = [Float32Array.from([0, 1])];

const embedTexts = mock(
	async (_texts: string[], _onProgress?: (p: LocalClipProgress) => void) =>
		textVectors,
);
const embedImages = mock(
	async (_blobs: Blob[], _onProgress?: (p: LocalClipProgress) => void) =>
		imageVectors,
);

mock.module("@/lib/local-ai/local-clip", () => ({
	...realLocalClip,
	localClip: { embedTexts, embedImages },
}));

// Import AFTER the mock is registered so the adapter delegates to the stubs
// (repo convention: mock.module + dynamic import).
const { embeddings, filterToCurrentModel } = await import("./embeddings");

describe("embeddings (local CLIP adapter)", () => {
	it("tags vectors with the local model name", () => {
		expect(embeddings.modelName).toBe("clip-vit-b32-web");
	});

	it("delegates embedTexts to localClip, forwarding args and result", async () => {
		embedTexts.mockClear();
		const texts = ["a photo of a dog"];
		const onProgress = () => undefined;

		const out = await embeddings.embedTexts(texts, onProgress);

		expect(out).toBe(textVectors);
		expect(embedTexts.mock.calls.length).toBe(1);
		// Same references through the seam — no copying or re-wrapping.
		expect(embedTexts.mock.calls[0][0]).toBe(texts);
		expect(embedTexts.mock.calls[0][1]).toBe(onProgress);
	});

	it("delegates embedImages to localClip, forwarding args and result", async () => {
		embedImages.mockClear();
		const blobs = [new Blob(["pixels"], { type: "image/jpeg" })];
		const onProgress = () => undefined;

		const out = await embeddings.embedImages(blobs, onProgress);

		expect(out).toBe(imageVectors);
		expect(embedImages.mock.calls.length).toBe(1);
		expect(embedImages.mock.calls[0][0]).toBe(blobs);
		expect(embedImages.mock.calls[0][1]).toBe(onProgress);
	});
});

describe("filterToCurrentModel", () => {
	it("keeps current-model records and drops retired vector spaces", () => {
		// The re-index window's IndexedDB reality: old server-backend records
		// ("ViT-B-32", laion2b space) mixed with fresh in-browser ones.
		const records = [
			{ mediaId: "fresh-1", modelName: "clip-vit-b32-web" },
			{ mediaId: "stale-1", modelName: "ViT-B-32" },
			{ mediaId: "fresh-2", modelName: "clip-vit-b32-web" },
		];

		const kept = filterToCurrentModel(records);

		expect(kept.map((r) => r.mediaId)).toEqual(["fresh-1", "fresh-2"]);
	});

	it("returns empty when every record is from a retired space", () => {
		expect(
			filterToCurrentModel([{ mediaId: "stale-1", modelName: "ViT-B-32" }]),
		).toEqual([]);
	});
});

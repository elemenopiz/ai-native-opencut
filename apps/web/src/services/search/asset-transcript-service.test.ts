import { describe, expect, it, mock } from "bun:test";
import type { AssetTranscript } from "@/lib/search/asset-transcript";
import type { MediaAsset } from "@/types/assets";

// In-memory stand-in for the IndexedDB transcript store. Mirrors the store's
// FULL export surface — mock.module leaks across test files in one bun
// process, so any export another file touches must exist here too.
const saved = new Map<string, AssetTranscript>();
mock.module("@/services/search/asset-transcript-store", () => ({
	saveTranscript: async (record: AssetTranscript) => {
		saved.set(record.mediaId, record);
	},
	getTranscript: async (mediaId: string) => saved.get(mediaId),
	getAllTranscripts: async () => [...saved.values()],
	deleteTranscript: async (mediaId: string) => {
		saved.delete(mediaId);
	},
	clearAllTranscripts: async () => {
		saved.clear();
	},
}));

// Import AFTER the mock so the service + lookup bind the in-memory store
// (repo convention: mock.module + dynamic import).
const { transcribeAsset, transcribeAssetBatch } = await import(
	"./asset-transcript-service"
);
const {
	assetTranscriptLookup,
	assetHasSpeech,
	clearTranscriptCache,
	primeTranscriptCache,
} = await import("@/lib/director/transcript-lookup");

function mediaAsset(id: string, over: Partial<MediaAsset> = {}): MediaAsset {
	return {
		id,
		name: `${id}.mp4`,
		type: "video",
		file: new File([new Uint8Array([1])], `${id}.mp4`),
		...over,
	} as MediaAsset;
}

/** A stubbed transcription call producing one spoken segment. */
const speechResult = {
	segments: [{ id: 0, text: "Hello world.", start: 0.2, end: 1.8, words: [] }],
	language: "en",
	duration: 4,
	engine: "stub",
};

describe("transcribeAsset", () => {
	it("transcribes, persists, and upserts the sync cache", async () => {
		saved.clear();
		clearTranscriptCache();
		const record = await transcribeAsset(mediaAsset("m1"), {
			transcribe: async () => speechResult,
		});
		expect(record?.segments.map((s) => s.text)).toEqual(["Hello world."]);
		expect(saved.get("m1")).toEqual(record ?? undefined);
		// The Director-facing sync cache sees it without a re-prime.
		expect(assetTranscriptLookup("m1")).toEqual(record ?? undefined);
		expect(assetHasSpeech("m1")).toBe(true);
	});

	it("short-circuits on an existing record instead of re-transcribing", async () => {
		saved.clear();
		clearTranscriptCache();
		const transcribe = mock(async () => speechResult);
		await transcribeAsset(mediaAsset("m1"), { transcribe });
		await transcribeAsset(mediaAsset("m1"), { transcribe });
		expect(transcribe).toHaveBeenCalledTimes(1);
	});

	it("persists an empty-segments record for silent footage (a real answer)", async () => {
		saved.clear();
		clearTranscriptCache();
		const record = await transcribeAsset(mediaAsset("silent"), {
			transcribe: async () => ({
				segments: [],
				language: "en",
				duration: 4,
			}),
		});
		expect(record?.segments).toEqual([]);
		expect(saved.has("silent")).toBe(true);
		expect(assetHasSpeech("silent")).toBe(false); // transcribed, no speech
	});

	it("returns null (nothing persisted) on images, missing files, and failures", async () => {
		saved.clear();
		clearTranscriptCache();
		expect(
			await transcribeAsset(mediaAsset("img", { type: "image" }), {
				transcribe: async () => speechResult,
			}),
		).toBeNull();
		expect(
			await transcribeAsset(
				mediaAsset("nofile", { file: undefined as unknown as File }),
				{ transcribe: async () => speechResult },
			),
		).toBeNull();
		expect(
			await transcribeAsset(mediaAsset("boom"), {
				transcribe: async () => {
					throw new Error("decode failed");
				},
			}),
		).toBeNull();
		expect(saved.size).toBe(0); // failures never poison the store
	});
});

describe("transcribeAssetBatch", () => {
	it("runs sequentially, summarizes, and reports per-asset completion", async () => {
		saved.clear();
		clearTranscriptCache();
		const order: string[] = [];
		const summary = await transcribeAssetBatch(
			[mediaAsset("a"), mediaAsset("b"), mediaAsset("img", { type: "image" })],
			{
				transcribe: async () => speechResult,
				onAssetComplete: (id) => order.push(id),
			},
		);
		expect(order).toEqual(["a", "b", "img"]);
		expect(summary).toEqual({ processed: 3, transcribed: 2, withSpeech: 2 });
	});

	it("stops when shouldContinue flips false", async () => {
		saved.clear();
		clearTranscriptCache();
		let calls = 0;
		const summary = await transcribeAssetBatch(
			[mediaAsset("a"), mediaAsset("b")],
			{
				transcribe: async () => {
					calls += 1;
					return speechResult;
				},
				shouldContinue: () => calls === 0,
			},
		);
		expect(summary.processed).toBe(1);
	});
});

describe("transcript-lookup priming", () => {
	it("primes the sync cache from the store and clears on demand", async () => {
		saved.clear();
		clearTranscriptCache();
		saved.set("m9", {
			mediaId: "m9",
			segments: [{ start: 0, end: 1, text: "primed" }],
			language: "en",
			durationSec: 1,
			engine: "stub",
			createdAt: 1,
		});
		await primeTranscriptCache();
		expect(assetTranscriptLookup("m9")?.segments[0]?.text).toBe("primed");
		clearTranscriptCache();
		expect(assetTranscriptLookup("m9")).toBeUndefined();
		expect(assetHasSpeech("m9")).toBeUndefined(); // not transcribed, per the cache
	});
});

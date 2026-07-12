import { describe, expect, it } from "bun:test";
import type { MediaAsset } from "@/types/assets";
import {
	AUTO_TRANSCRIBE_MAX_DURATION_SEC,
	DIGEST_SEGMENT_CAP,
	fromTranscriptionResult,
	hasSpeech,
	renderTranscriptDigest,
	selectTranscriptionCandidates,
	windowSegments,
	type TranscriptSegmentLite,
} from "./asset-transcript";

function seg(start: number, end: number, text: string): TranscriptSegmentLite {
	return { start, end, text };
}

function asset(over: Partial<MediaAsset> = {}): MediaAsset {
	return {
		id: "m1",
		name: "clip.mp4",
		type: "video",
		file: new File([new Uint8Array([1])], "clip.mp4"),
		...over,
	} as MediaAsset;
}

describe("fromTranscriptionResult", () => {
	it("keeps segment timings + text and drops word-level data", () => {
		const t = fromTranscriptionResult(
			"m1",
			{
				segments: [
					{
						id: 0,
						text: " Hello there. ",
						start: 0.5,
						end: 2.4,
						words: [{ word: "Hello", start: 0.5, end: 1.2, confidence: 0.9 }],
					},
				],
				language: "en",
				duration: 10,
				engine: "whisper-local",
			},
			123,
		);
		expect(t).toEqual({
			mediaId: "m1",
			segments: [seg(0.5, 2.4, "Hello there.")],
			language: "en",
			durationSec: 10,
			engine: "whisper-local",
			createdAt: 123,
		});
	});

	it("drops empty segments and clamps negative/inverted spans", () => {
		const t = fromTranscriptionResult("m1", {
			segments: [
				{ id: 0, text: "   ", start: 0, end: 1, words: [] },
				{ id: 1, text: "ok", start: -2, end: -5, words: [] },
			],
			language: "en",
			duration: 5,
		});
		expect(t.segments).toEqual([seg(0, 0, "ok")]);
	});

	it("falls back to the last segment end when duration is missing", () => {
		const t = fromTranscriptionResult("m1", {
			segments: [{ id: 0, text: "hi", start: 1, end: 3.5, words: [] }],
			language: "en",
			duration: undefined as unknown as number,
		});
		expect(t.durationSec).toBe(3.5);
	});
});

describe("hasSpeech", () => {
	it("is true only when a segment carries real text", () => {
		const base = fromTranscriptionResult("m1", {
			segments: [],
			language: "en",
			duration: 5,
		});
		expect(hasSpeech(base)).toBe(false);
		expect(hasSpeech({ ...base, segments: [seg(0, 1, "hi")] })).toBe(true);
	});
});

describe("selectTranscriptionCandidates", () => {
	it("keeps speech-bearing media (video + audio) with a file, in input order", () => {
		const assets = [
			asset({ id: "v", type: "video" }),
			asset({ id: "a", type: "audio" }),
			asset({ id: "i", type: "image" }),
			asset({ id: "nofile", file: undefined as unknown as File }),
		];
		expect(selectTranscriptionCandidates(assets).map((x) => x.id)).toEqual([
			"v",
			"a",
		]);
	});

	it("skips assets over the duration ceiling but keeps unknown durations", () => {
		const assets = [
			asset({ id: "long", duration: AUTO_TRANSCRIBE_MAX_DURATION_SEC + 1 }),
			asset({ id: "short", duration: 30 }),
			asset({ id: "unknown", duration: undefined }),
		];
		expect(selectTranscriptionCandidates(assets).map((x) => x.id)).toEqual([
			"short",
			"unknown",
		]);
	});

	it("honors exclude and cap", () => {
		const assets = [asset({ id: "a" }), asset({ id: "b" }), asset({ id: "c" })];
		expect(
			selectTranscriptionCandidates(assets, {
				exclude: new Set(["a"]),
				cap: 1,
			}).map((x) => x.id),
		).toEqual(["b"]);
	});
});

describe("windowSegments", () => {
	const segments = [seg(0, 2, "one"), seg(2, 4, "two"), seg(4, 6, "three")];

	it("returns everything with no bounds", () => {
		expect(windowSegments(segments)).toHaveLength(3);
	});

	it("includes partial overlaps on both edges", () => {
		expect(windowSegments(segments, 1.5, 4.5).map((s) => s.text)).toEqual([
			"one",
			"two",
			"three",
		]);
		expect(windowSegments(segments, 2.5, 3.5).map((s) => s.text)).toEqual([
			"two",
		]);
	});

	it("excludes segments that only touch the window boundary", () => {
		// seg(0,2) ends exactly at start=2 → not overlapping.
		expect(windowSegments(segments, 2, 4).map((s) => s.text)).toEqual(["two"]);
	});
});

describe("renderTranscriptDigest", () => {
	it("renders compact one-decimal lines", () => {
		const d = renderTranscriptDigest([seg(0.55, 2.111, "Hello there.")]);
		expect(d.lines).toEqual(["[0.6–2.1] Hello there."]);
		expect(d.truncated).toBe(false);
		expect(d.included).toBe(1);
		expect(d.total).toBe(1);
	});

	it("caps at DIGEST_SEGMENT_CAP and flags truncation", () => {
		const many = Array.from({ length: DIGEST_SEGMENT_CAP + 5 }, (_, i) =>
			seg(i, i + 1, `s${i}`),
		);
		const d = renderTranscriptDigest(many);
		expect(d.included).toBe(DIGEST_SEGMENT_CAP);
		expect(d.total).toBe(DIGEST_SEGMENT_CAP + 5);
		expect(d.truncated).toBe(true);
		expect(d.lines).toHaveLength(DIGEST_SEGMENT_CAP);
	});
});

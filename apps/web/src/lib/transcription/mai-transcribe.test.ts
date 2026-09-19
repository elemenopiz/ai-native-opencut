import { describe, expect, it } from "bun:test";
import {
	isAlreadyCovered,
	offsetSegment,
	transcribeWithMai,
	type MaiTranscribeDeps,
} from "@/lib/transcription/mai-transcribe";
import { TRANSCRIBE_CHUNK_TARGET_BYTES } from "@/constants/transcription-constants";
import type { TranscriptionResult, TranscriptionSegment } from "@/types/ai";

/**
 * Coverage for the chunk-window arithmetic — the part of the MAI path that has
 * no counterpart in the old on-device flow and no provider to catch mistakes.
 *
 * The provider returns timestamps relative to the audio IT received, so for a
 * long file every chunk after the first comes back starting near zero. If the
 * offset or the overlap de-duplication is wrong the transcript still looks
 * plausible — it just silently drifts or repeats — which is exactly the kind of
 * bug that survives a manual smoke test.
 *
 * The media decode and the network are injected (see MaiTranscribeDeps), so
 * these run without a browser and without mock.module, which is process-global
 * in bun and leaks into unrelated files.
 */

function segment(
	start: number,
	end: number,
	text = "hello",
): TranscriptionSegment {
	return {
		id: 0,
		text,
		start,
		end,
		words: [{ word: text, start, end, confidence: 0.9 }],
	};
}

function file() {
	return new File([new Uint8Array([0, 1, 2])], "clip.mp4", {
		type: "video/mp4",
	});
}

/** Duration that forces exactly `n` chunks at the configured target size. */
function durationForChunks(n: number): number {
	const secondsPerChunk = TRANSCRIBE_CHUNK_TARGET_BYTES / ((16_000 / 8) * 1.35);
	// Land mid-way into the nth window so ceil() produces exactly n chunks.
	return secondsPerChunk * (n - 0.5);
}

describe("offsetSegment", () => {
	it("shifts the segment and its words onto the source timeline", () => {
		const shifted = offsetSegment(segment(1, 2), 100, 7);
		expect(shifted.start).toBe(101);
		expect(shifted.end).toBe(102);
		expect(shifted.words[0].start).toBe(101);
		expect(shifted.words[0].end).toBe(102);
		expect(shifted.id).toBe(7);
	});
});

describe("isAlreadyCovered", () => {
	// Chunk 1 of a multi-chunk file: its audio actually started at 98 because
	// of the 2s backward overlap, and everything up to 100 is already in hand.
	const windowStart = 98;
	const lastKeptEnd = 100;

	it("drops a segment wholly inside what the previous chunk already covered", () => {
		// Absolute span 98.5..99.5 — entirely behind the high-water mark.
		expect(isAlreadyCovered(segment(0.5, 1.5), windowStart, lastKeptEnd)).toBe(
			true,
		);
	});

	it("keeps a segment that extends past the covered span", () => {
		// Absolute span 99..101 — the tail is new speech, so it must survive
		// even though it starts inside the overlap.
		expect(isAlreadyCovered(segment(1, 3), windowStart, lastKeptEnd)).toBe(
			false,
		);
	});

	it("keeps everything on the first chunk", () => {
		// Nothing is covered yet, so no segment can be discarded — the opening
		// words of a file must never be de-duplicated away.
		expect(isAlreadyCovered(segment(0, 1), 0, 0)).toBe(false);
	});
});

describe("transcribeWithMai", () => {
	function deps(
		perChunk: (index: number) => TranscriptionResult,
		windows: ({ start: number; end: number } | undefined)[] = [],
		duration = 60,
	): MaiTranscribeDeps {
		let index = 0;
		return {
			readDuration: async () => duration,
			extractAudio: async (_file, window) => {
				windows.push(window);
				return new Blob([new Uint8Array([1])]);
			},
			postChunk: async () => perChunk(index++),
		};
	}

	it("sends one un-trimmed request for short audio", async () => {
		const windows: ({ start: number; end: number } | undefined)[] = [];
		const result = await transcribeWithMai(
			file(),
			{},
			deps(
				() => ({
					segments: [segment(1, 2, "only chunk")],
					language: "en-US",
					duration: 60,
				}),
				windows,
				60,
			),
		);

		// A single chunk must not be trimmed at all — see extractAudioWindow.
		expect(windows).toEqual([undefined]);
		expect(result.segments).toHaveLength(1);
		expect(result.segments[0].start).toBe(1);
		expect(result.language).toBe("en-US");
		expect(result.duration).toBe(60);
	});

	it("offsets later chunks onto the source timeline", async () => {
		const duration = durationForChunks(2);
		const step = duration / 2;
		const windows: ({ start: number; end: number } | undefined)[] = [];

		const result = await transcribeWithMai(
			file(),
			{},
			deps(
				(index) => ({
					// Both chunks report a segment 10s into the audio they received.
					segments: [segment(10, 11, `chunk ${index}`)],
					language: "en-US",
					duration: step,
				}),
				windows,
				duration,
			),
		);

		expect(windows).toHaveLength(2);
		expect(result.segments).toHaveLength(2);

		// Chunk 0's window starts at 0, so its timestamps pass through.
		expect(result.segments[0].start).toBe(10);
		// Chunk 1's window starts 2s before the nominal boundary, and its
		// segment must land there — NOT back at 10s on top of chunk 0.
		const chunkOneStart = Math.max(0, step - 2);
		expect(result.segments[1].start).toBe(chunkOneStart + 10);
		expect(result.segments[1].text).toBe("chunk 1");
		// Ids are re-numbered contiguously across the stitch.
		expect(result.segments.map((s) => s.id)).toEqual([0, 1]);
	});

	it("does not emit the same speech twice from the overlap region", async () => {
		const duration = durationForChunks(2);
		const step = duration / 2;

		const result = await transcribeWithMai(
			file(),
			{},
			deps(
				(index) =>
					index === 0
						? {
								// Chunk 0 reaches 1s past its nominal end (forward overlap).
								segments: [segment(step + 0.5, step + 1, "seam")],
								language: "en-US",
								duration: step,
							}
						: {
								// Chunk 1 heard the same words 1.5s into its own audio
								// (it started 2s early), so this is the SAME speech.
								segments: [segment(1.5, 2, "seam")],
								language: "en-US",
								duration: step,
							},
				[],
				duration,
			),
		);

		// Exactly one copy survives: chunk 0 kept it, and chunk 1's copy ends
		// inside the already-covered span. A naive concat would return two.
		expect(result.segments).toHaveLength(1);
		expect(result.segments[0].text).toBe("seam");
	});

	it("reports progress that ends at 1", async () => {
		const seen: number[] = [];
		await transcribeWithMai(
			file(),
			{ onProgress: (p) => seen.push(p.progress) },
			deps(() => ({ segments: [], language: "en-US", duration: 60 }), [], 60),
		);
		expect(seen.at(-1)).toBe(1);
		expect(Math.min(...seen)).toBeGreaterThanOrEqual(0);
	});

	it("stops before calling the provider when already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		let called = false;

		const promise = transcribeWithMai(
			file(),
			{ signal: controller.signal },
			{
				readDuration: async () => 60,
				extractAudio: async () => new Blob([new Uint8Array([1])]),
				postChunk: async () => {
					called = true;
					return { segments: [], language: "en-US", duration: 60 };
				},
			},
		);

		await expect(promise).rejects.toThrow("cancelled");
		expect(called).toBe(false);
	});
});

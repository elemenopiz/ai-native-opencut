import { describe, expect, it } from "bun:test";
import type { TimelineElement, TimelineTrack } from "@/types/timeline";
import type { TranscriptionSegment } from "@/types/ai";
import {
	computeTranscriptSplitPoints,
	ingestOffsetForMedia,
	resolveAssetRangeToTimelineRanges,
	resolveAssetTimeToTimelineTimes,
	resolveTranscriptCuts,
	timelineOffsetForElement,
	timelineRangeToAssetRange,
	toTimelineSegments,
} from "../transcript-timebase";

/**
 * The bug this file exists to stop coming back: transcript segment times are
 * ASSET-RELATIVE, timeline operations are TIMELINE-ABSOLUTE, and the two are
 * only equal for a clip sitting untrimmed at timeline 0. Every case below is
 * deliberately NOT that clip — a trimmed clip at a non-zero start, an asset
 * split into several pieces, a stretch of asset trimmed off entirely.
 *
 * Two earlier versions of this bug shipped (the Captions panel's single-source
 * path hardcoding a zero offset, and the text-timeline bridge doing no
 * conversion at all) precisely because no test covered this path.
 */

let nextId = 0;
function clip({
	mediaId,
	startTime,
	trimStart,
	duration,
}: {
	mediaId: string;
	startTime: number;
	trimStart: number;
	duration: number;
}): TimelineElement {
	return {
		id: `el-${++nextId}`,
		type: "video",
		name: mediaId,
		mediaId,
		startTime,
		trimStart,
		trimEnd: 0,
		duration,
	} as unknown as TimelineElement;
}

function videoTrack(elements: TimelineElement[]): TimelineTrack {
	return {
		id: `track-${++nextId}`,
		name: "Video",
		type: "video",
		elements,
	} as unknown as TimelineTrack;
}

function segment({
	id,
	start,
	end,
	mediaId,
	sourceStart,
	sourceEnd,
	text = "hello",
}: {
	id: number;
	start: number;
	end: number;
	mediaId?: string;
	sourceStart?: number;
	sourceEnd?: number;
	text?: string;
}): TranscriptionSegment {
	return {
		id,
		text,
		start,
		end,
		words: [],
		...(mediaId ? { mediaId } : {}),
		...(sourceStart != null ? { sourceStart } : {}),
		...(sourceEnd != null ? { sourceEnd } : {}),
	};
}

describe("timelineOffsetForElement", () => {
	it("is zero only for an untrimmed clip at timeline 0", () => {
		expect(
			timelineOffsetForElement({ startTime: 0, trimStart: 0 }),
		).toBeCloseTo(0);
	});

	it("accounts for position and trim together", () => {
		// Clip starts at 10s on the timeline showing the asset from 4s in:
		// asset time 4 → timeline 10, so asset 0 would sit at timeline 6.
		expect(
			timelineOffsetForElement({ startTime: 10, trimStart: 4 }),
		).toBeCloseTo(6);
	});

	it("goes negative when a clip is trimmed further in than it is pushed right", () => {
		expect(
			timelineOffsetForElement({ startTime: 0, trimStart: 10 }),
		).toBeCloseTo(-10);
	});
});

describe("ingestOffsetForMedia", () => {
	it("returns null for an asset that isn't on the timeline", () => {
		const tracks = [videoTrack([])];
		expect(ingestOffsetForMedia({ tracks, mediaId: "a" })).toBeNull();
	});

	it("reads the offset off a trimmed clip at a non-zero start", () => {
		const tracks = [
			videoTrack([
				clip({ mediaId: "a", startTime: 10, trimStart: 4, duration: 6 }),
			]),
		];
		expect(ingestOffsetForMedia({ tracks, mediaId: "a" })).toBeCloseTo(6);
	});

	it("takes the EARLIEST offset when the asset was split into pieces", () => {
		// One asset split in two and the halves moved apart: offsets 6 and 20.
		const tracks = [
			videoTrack([
				clip({ mediaId: "a", startTime: 30, trimStart: 10, duration: 5 }),
				clip({ mediaId: "a", startTime: 10, trimStart: 4, duration: 6 }),
			]),
		];
		expect(ingestOffsetForMedia({ tracks, mediaId: "a" })).toBeCloseTo(6);
	});
});

describe("resolveAssetRangeToTimelineRanges", () => {
	const tracks = [
		videoTrack([
			// Shows asset 4s–10s at timeline 10s–16s (offset +6).
			clip({ mediaId: "a", startTime: 10, trimStart: 4, duration: 6 }),
		]),
	];

	it("offsets an asset range onto a trimmed clip at a non-zero start", () => {
		const ranges = resolveAssetRangeToTimelineRanges({
			tracks,
			mediaId: "a",
			range: { start: 5, end: 7 },
		});
		expect(ranges).toEqual([{ start: 11, end: 13 }]);
	});

	it("clamps a range that overhangs the clip's visible window", () => {
		const ranges = resolveAssetRangeToTimelineRanges({
			tracks,
			mediaId: "a",
			range: { start: 0, end: 100 },
		});
		expect(ranges).toEqual([{ start: 10, end: 16 }]);
	});

	it("returns [] when the range is entirely trimmed away", () => {
		// Asset 0s–4s is trimmed off the head of the only clip.
		expect(
			resolveAssetRangeToTimelineRanges({
				tracks,
				mediaId: "a",
				range: { start: 0, end: 3 },
			}),
		).toEqual([]);
	});

	it("returns [] for an asset that isn't on the timeline", () => {
		expect(
			resolveAssetRangeToTimelineRanges({
				tracks,
				mediaId: "ghost",
				range: { start: 5, end: 7 },
			}),
		).toEqual([]);
	});

	it("maps ONE asset range onto SEVERAL timeline ranges when the asset repeats", () => {
		// Same footage placed twice, at different offsets.
		const repeated = [
			videoTrack([
				clip({ mediaId: "a", startTime: 0, trimStart: 0, duration: 10 }),
				clip({ mediaId: "a", startTime: 50, trimStart: 0, duration: 10 }),
			]),
		];
		expect(
			resolveAssetRangeToTimelineRanges({
				tracks: repeated,
				mediaId: "a",
				range: { start: 2, end: 4 },
			}),
		).toEqual([
			{ start: 2, end: 4 },
			{ start: 52, end: 54 },
		]);
	});
});

describe("resolveAssetTimeToTimelineTimes", () => {
	it("keeps only instants strictly inside a clip's visible window", () => {
		const tracks = [
			videoTrack([
				clip({ mediaId: "a", startTime: 10, trimStart: 4, duration: 6 }),
			]),
		];
		expect(
			resolveAssetTimeToTimelineTimes({ tracks, mediaId: "a", assetTime: 7 }),
		).toEqual([13]);
		// Exactly on either visible edge is a no-op split, so it's dropped.
		expect(
			resolveAssetTimeToTimelineTimes({ tracks, mediaId: "a", assetTime: 4 }),
		).toEqual([]);
		expect(
			resolveAssetTimeToTimelineTimes({ tracks, mediaId: "a", assetTime: 10 }),
		).toEqual([]);
		// Trimmed away entirely.
		expect(
			resolveAssetTimeToTimelineTimes({ tracks, mediaId: "a", assetTime: 1 }),
		).toEqual([]);
	});
});

describe("toTimelineSegments", () => {
	it("shifts segments AND words onto the timeline and records provenance", () => {
		const [out] = toTimelineSegments({
			segments: [
				{
					id: 1,
					text: "hi",
					start: 2,
					end: 5,
					words: [{ word: "hi", start: 2, end: 2.4, confidence: 1 }],
				},
			],
			offsetSeconds: 6,
			mediaId: "a",
		});
		expect(out.start).toBeCloseTo(8);
		expect(out.end).toBeCloseTo(11);
		expect(out.words[0].start).toBeCloseTo(8);
		expect(out.words[0].end).toBeCloseTo(8.4);
		// Provenance keeps the ORIGINAL asset-relative numbers.
		expect(out.mediaId).toBe("a");
		expect(out.sourceStart).toBeCloseTo(2);
		expect(out.sourceEnd).toBeCloseTo(5);
	});

	it("round-trips back to the asset range it came from", () => {
		const [out] = toTimelineSegments({
			segments: [{ id: 1, text: "hi", start: 2, end: 5, words: [] }],
			offsetSeconds: 6,
			mediaId: "a",
		});
		expect(
			timelineRangeToAssetRange({
				segment: out,
				range: { start: out.start, end: out.end },
			}),
		).toEqual({ start: 2, end: 5 });
	});

	it("returns null from the round-trip when provenance is absent", () => {
		expect(
			timelineRangeToAssetRange({
				segment: segment({ id: 1, start: 0, end: 1 }),
				range: { start: 0, end: 1 },
			}),
		).toBeNull();
	});
});

describe("resolveTranscriptCuts", () => {
	it("REGRESSION: a trimmed clip at a non-zero start produces correctly-offset ranges", () => {
		// The exact shape the old code got wrong. Asset 4s–10s sits at timeline
		// 10s–16s. Deleting the sentence at asset 5s–7s must cut timeline
		// 11s–13s — NOT 5s–7s, which is where the unconverted code cut.
		const tracks = [
			videoTrack([
				clip({ mediaId: "a", startTime: 10, trimStart: 4, duration: 6 }),
			]),
		];
		const segments = toTimelineSegments({
			segments: [{ id: 1, text: "cut me", start: 5, end: 7, words: [] }],
			offsetSeconds: 6,
			mediaId: "a",
		});
		const { ranges, dropped } = resolveTranscriptCuts({
			tracks,
			segments,
			cuts: [{ start: segments[0].start, end: segments[0].end }],
		});
		expect(ranges).toEqual([{ start: 11, end: 13 }]);
		expect(dropped).toEqual([]);
	});

	it("re-projects onto the clip's CURRENT placement after it is moved", () => {
		// Transcribed while the clip sat at timeline 10 (offset +6), then the
		// user dragged it to timeline 40 (offset +36). The stored segment times
		// are stale; provenance recovers the truth.
		const segments = toTimelineSegments({
			segments: [{ id: 1, text: "cut me", start: 5, end: 7, words: [] }],
			offsetSeconds: 6,
			mediaId: "a",
		});
		const movedTracks = [
			videoTrack([
				clip({ mediaId: "a", startTime: 40, trimStart: 4, duration: 6 }),
			]),
		];
		const { ranges } = resolveTranscriptCuts({
			tracks: movedTracks,
			segments,
			cuts: [{ start: segments[0].start, end: segments[0].end }],
		});
		expect(ranges).toEqual([{ start: 41, end: 43 }]);
	});

	it("maps one sentence onto SEVERAL ranges when its asset was split apart", () => {
		// The asset was split at asset-time 6 and the halves separated. A
		// sentence spanning asset 5s–7s now straddles both pieces.
		const segments = toTimelineSegments({
			segments: [{ id: 1, text: "straddles", start: 5, end: 7, words: [] }],
			offsetSeconds: 0,
			mediaId: "a",
		});
		const tracks = [
			videoTrack([
				// asset 0–6 at timeline 0–6
				clip({ mediaId: "a", startTime: 0, trimStart: 0, duration: 6 }),
				// asset 6–10 at timeline 100–104
				clip({ mediaId: "a", startTime: 100, trimStart: 6, duration: 4 }),
			]),
		];
		const { ranges, dropped } = resolveTranscriptCuts({
			tracks,
			segments,
			cuts: [{ start: 5, end: 7 }],
		});
		expect(ranges).toEqual([
			{ start: 5, end: 6 },
			{ start: 100, end: 101 },
		]);
		expect(dropped).toEqual([]);
	});

	it("reports a cut whose footage is no longer on the timeline instead of cutting the wrong place", () => {
		// The clip now shows only asset 8s onward; the sentence at 5s–7s is gone.
		const segments = toTimelineSegments({
			segments: [{ id: 1, text: "trimmed off", start: 5, end: 7, words: [] }],
			offsetSeconds: 0,
			mediaId: "a",
		});
		const tracks = [
			videoTrack([
				clip({ mediaId: "a", startTime: 0, trimStart: 8, duration: 4 }),
			]),
		];
		const { ranges, dropped } = resolveTranscriptCuts({
			tracks,
			segments,
			cuts: [{ start: 5, end: 7 }],
		});
		expect(ranges).toEqual([]);
		expect(dropped).toEqual([{ start: 5, end: 7 }]);
	});

	it("cuts the part that exists and reports the part that doesn't", () => {
		// Clip shows asset 6s onward; the sentence spans 5s–8s, so only 6s–8s
		// is still on the timeline.
		const segments = toTimelineSegments({
			segments: [{ id: 1, text: "half gone", start: 5, end: 8, words: [] }],
			offsetSeconds: 0,
			mediaId: "a",
		});
		const tracks = [
			videoTrack([
				clip({ mediaId: "a", startTime: 0, trimStart: 6, duration: 4 }),
			]),
		];
		const { ranges, dropped } = resolveTranscriptCuts({
			tracks,
			segments,
			cuts: [{ start: 5, end: 8 }],
		});
		// asset 6–8 → timeline 0–2 (offset -6).
		expect(ranges).toEqual([{ start: 0, end: 2 }]);
		expect(dropped).toEqual([]);
	});

	it("passes cuts through unchanged when segments carry no provenance", () => {
		// Older projects: nothing to re-resolve, so the stored times stand.
		const tracks = [
			videoTrack([
				clip({ mediaId: "a", startTime: 10, trimStart: 4, duration: 6 }),
			]),
		];
		const { ranges, dropped } = resolveTranscriptCuts({
			tracks,
			segments: [segment({ id: 1, start: 5, end: 7 })],
			cuts: [{ start: 5, end: 7 }],
		});
		expect(ranges).toEqual([{ start: 5, end: 7 }]);
		expect(dropped).toEqual([]);
	});

	it("handles a cut spanning two segments from DIFFERENT assets", () => {
		// Two clips, different offsets, one merged cut across the join.
		const tracks = [
			videoTrack([
				// asset a 0–5 at timeline 0–5
				clip({ mediaId: "a", startTime: 0, trimStart: 0, duration: 5 }),
				// asset b 10–15 at timeline 5–10 (offset -5)
				clip({ mediaId: "b", startTime: 5, trimStart: 10, duration: 5 }),
			]),
		];
		const segments = [
			segment({
				id: 1,
				start: 3,
				end: 5,
				mediaId: "a",
				sourceStart: 3,
				sourceEnd: 5,
			}),
			segment({
				id: 2,
				start: 5,
				end: 7,
				mediaId: "b",
				sourceStart: 10,
				sourceEnd: 12,
			}),
		];
		const { ranges, dropped } = resolveTranscriptCuts({
			tracks,
			segments,
			cuts: [{ start: 3, end: 7 }],
		});
		// Each half resolves through its own asset and they merge back together.
		expect(ranges).toEqual([{ start: 3, end: 7 }]);
		expect(dropped).toEqual([]);
	});

	it("ignores degenerate (zero- or negative-width) cuts", () => {
		const tracks = [
			videoTrack([
				clip({ mediaId: "a", startTime: 0, trimStart: 0, duration: 10 }),
			]),
		];
		expect(
			resolveTranscriptCuts({
				tracks,
				segments: [],
				cuts: [{ start: 4, end: 4 }],
			}).ranges,
		).toEqual([]);
	});
});

describe("computeTranscriptSplitPoints", () => {
	it("REGRESSION: boundaries land on the timeline, not on raw asset times", () => {
		// Asset 4s–10s at timeline 10s–16s. Segment boundaries at asset 4/6/8/10
		// must become timeline 12 and 14 — the outer two are the clip's own
		// edges, where a split is a no-op.
		const tracks = [
			videoTrack([
				clip({ mediaId: "a", startTime: 10, trimStart: 4, duration: 6 }),
			]),
		];
		const segments = toTimelineSegments({
			segments: [
				{ id: 1, text: "a", start: 4, end: 6, words: [] },
				{ id: 2, text: "b", start: 6, end: 8, words: [] },
				{ id: 3, text: "c", start: 8, end: 10, words: [] },
			],
			offsetSeconds: 6,
			mediaId: "a",
		});
		expect(computeTranscriptSplitPoints({ tracks, segments })).toEqual([
			12, 14,
		]);
	});

	it("produces a split point per placement when the asset appears twice", () => {
		const tracks = [
			videoTrack([
				clip({ mediaId: "a", startTime: 0, trimStart: 0, duration: 10 }),
				clip({ mediaId: "a", startTime: 50, trimStart: 0, duration: 10 }),
			]),
		];
		const segments = toTimelineSegments({
			segments: [
				{ id: 1, text: "a", start: 0, end: 4, words: [] },
				{ id: 2, text: "b", start: 4, end: 10, words: [] },
			],
			offsetSeconds: 0,
			mediaId: "a",
		});
		expect(computeTranscriptSplitPoints({ tracks, segments })).toEqual([4, 54]);
	});

	it("yields nothing for segments without provenance", () => {
		const tracks = [
			videoTrack([
				clip({ mediaId: "a", startTime: 0, trimStart: 0, duration: 10 }),
			]),
		];
		expect(
			computeTranscriptSplitPoints({
				tracks,
				segments: [segment({ id: 1, start: 0, end: 4 })],
			}),
		).toEqual([]);
	});
});

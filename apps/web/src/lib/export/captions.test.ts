import { describe, expect, test } from "bun:test";
import { collectCaptionCues } from "./captions";
import type {
	AudioElement,
	TextElement,
	TextTrack,
	TimelineTrack,
	VideoElement,
	VideoTrack,
} from "@/types/timeline";
import type { MediaAsset } from "@/types/assets";
import type { TranscriptionSegment } from "@/types/ai";

// ── Fixture builders ────────────────────────────────────────────────────────

function makeTextElement(overrides: Partial<TextElement> = {}): TextElement {
	return {
		id: overrides.id ?? `text-${Math.random()}`,
		name: "Text",
		type: "text",
		content: "cue text",
		duration: 1,
		startTime: 0,
		trimStart: 0,
		trimEnd: 0,
		fontSize: 5,
		fontFamily: "Arial",
		color: "#ffffff",
		background: { enabled: false, color: "#000000" },
		textAlign: "center",
		fontWeight: "normal",
		fontStyle: "normal",
		textDecoration: "none",
		transform: { scale: 1, position: { x: 0, y: 0 }, rotate: 0 },
		opacity: 1,
		...overrides,
	};
}

function makeTextTrack(
	name: string,
	elements: TextElement[],
	overrides: Partial<TextTrack> = {},
): TextTrack {
	return {
		id: overrides.id ?? `track-${name}`,
		name,
		type: "text",
		elements,
		hidden: false,
		...overrides,
	};
}

function makeVideoElement(overrides: Partial<VideoElement> = {}): VideoElement {
	return {
		id: overrides.id ?? `video-${Math.random()}`,
		name: "Video",
		type: "video",
		mediaId: "asset-1",
		duration: 10,
		startTime: 0,
		trimStart: 0,
		trimEnd: 0,
		transform: { scale: 1, position: { x: 0, y: 0 }, rotate: 0 },
		opacity: 1,
		...overrides,
	};
}

function makeVideoTrack(
	elements: VideoElement[],
	overrides: Partial<VideoTrack> = {},
): VideoTrack {
	return {
		id: overrides.id ?? "track-video",
		name: "Video",
		type: "video",
		elements,
		isMain: true,
		muted: false,
		hidden: false,
		...overrides,
	};
}

function makeSegment(
	id: number,
	start: number,
	end: number,
	text = `seg-${id}`,
): TranscriptionSegment {
	return { id, text, start, end, words: [] };
}

function makeMediaAsset(
	id: string,
	type: MediaAsset["type"] = "video",
): MediaAsset {
	return {
		id,
		name: `${id}.mp4`,
		type,
		file: new File([new Uint8Array([1])], `${id}.mp4`),
	};
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("collectCaptionCues — timeline precedence", () => {
	test("uses subtitle text-track cues (source: timeline) when present, ignoring transcript", () => {
		const subsTrack = makeTextTrack("Subs: Original", [
			makeTextElement({ content: "First", startTime: 3, duration: 1 }),
			makeTextElement({ content: "Second", startTime: 1, duration: 1 }),
		]);
		const videoTrack = makeVideoTrack([
			makeVideoElement({ mediaId: "asset-1", startTime: 0, duration: 20 }),
		]);
		const tracks: TimelineTrack[] = [subsTrack, videoTrack];

		const result = collectCaptionCues({
			tracks,
			transcriptSegments: [makeSegment(1, 0, 1, "should be ignored")],
			mediaAssets: [makeMediaAsset("asset-1")],
		});

		expect(result.source).toBe("timeline");
		expect(result.cues).toHaveLength(2);
		// Sorted by start time even though the track wasn't in order.
		expect(result.cues[0]).toEqual({
			text: "Second",
			startTime: 1,
			duration: 1,
		});
		expect(result.cues[1]).toEqual({
			text: "First",
			startTime: 3,
			duration: 1,
		});
	});

	test("ignores text tracks that aren't subtitle tracks (no 'Subs:' prefix)", () => {
		const titleTrack = makeTextTrack("Lower Third", [
			makeTextElement({ content: "Not a caption", startTime: 0, duration: 1 }),
		]);
		const videoTrack = makeVideoTrack([
			makeVideoElement({ mediaId: "asset-1", startTime: 0, duration: 20 }),
		]);

		const result = collectCaptionCues({
			tracks: [titleTrack, videoTrack],
			transcriptSegments: [makeSegment(1, 0, 1, "From transcript")],
			mediaAssets: [makeMediaAsset("asset-1")],
		});

		expect(result.source).toBe("transcript");
		expect(result.cues.map((c) => c.text)).toEqual(["From transcript"]);
	});
});

describe("collectCaptionCues — transcript fallback timebase mapping", () => {
	test("maps asset-relative time to timeline time via element.startTime + (t - trimStart)", () => {
		// Asset-relative 5.0s, trimStart 2.0, element start 10.0 -> timeline 13.0.
		const element = makeVideoElement({
			mediaId: "asset-1",
			startTime: 10,
			trimStart: 2,
			trimEnd: 0,
			duration: 10, // window = [2, 12)
		});
		const tracks: TimelineTrack[] = [makeVideoTrack([element])];

		const result = collectCaptionCues({
			tracks,
			transcriptSegments: [makeSegment(1, 5, 6, "Mapped")],
			mediaAssets: [makeMediaAsset("asset-1")],
		});

		expect(result.source).toBe("transcript");
		expect(result.cues).toHaveLength(1);
		expect(result.cues[0].startTime).toBeCloseTo(13, 6);
		expect(result.cues[0].duration).toBeCloseTo(1, 6);
	});

	test("drops a segment wholly outside the element's trimmed window", () => {
		const element = makeVideoElement({
			mediaId: "asset-1",
			startTime: 10,
			trimStart: 2,
			trimEnd: 0,
			duration: 10, // window = [2, 12)
		});
		const tracks: TimelineTrack[] = [makeVideoTrack([element])];

		const result = collectCaptionCues({
			tracks,
			transcriptSegments: [makeSegment(1, 15, 16, "Outside window")],
			mediaAssets: [makeMediaAsset("asset-1")],
		});

		expect(result.cues).toHaveLength(0);
	});

	test("clips a segment straddling the trimmed window boundary", () => {
		const element = makeVideoElement({
			mediaId: "asset-1",
			startTime: 10,
			trimStart: 2,
			trimEnd: 0,
			duration: 10, // window = [2, 12)
		});
		const tracks: TimelineTrack[] = [makeVideoTrack([element])];

		// Segment [10, 14) straddles the window end at 12 -> clipped to [10, 12).
		const result = collectCaptionCues({
			tracks,
			transcriptSegments: [makeSegment(1, 10, 14, "Straddling")],
			mediaAssets: [makeMediaAsset("asset-1")],
		});

		expect(result.cues).toHaveLength(1);
		// timelineStart = 10 (element start) + (10 - 2) = 18
		expect(result.cues[0].startTime).toBeCloseTo(18, 6);
		// clipped duration = 12 - 10 = 2
		expect(result.cues[0].duration).toBeCloseTo(2, 6);
	});

	test("emits a cue set per on-timeline occurrence when the asset appears more than once", () => {
		const first = makeVideoElement({
			id: "el-1",
			mediaId: "asset-1",
			startTime: 0,
			trimStart: 0,
			duration: 10,
		});
		const second = makeVideoElement({
			id: "el-2",
			mediaId: "asset-1",
			startTime: 100,
			trimStart: 0,
			duration: 10,
		});
		const tracks: TimelineTrack[] = [makeVideoTrack([first, second])];

		const result = collectCaptionCues({
			tracks,
			transcriptSegments: [makeSegment(1, 1, 2, "Repeated")],
			mediaAssets: [makeMediaAsset("asset-1")],
		});

		expect(result.cues).toHaveLength(2);
		const starts = result.cues.map((c) => c.startTime).sort((a, b) => a - b);
		expect(starts[0]).toBeCloseTo(1, 6); // first occurrence: 0 + (1 - 0)
		expect(starts[1]).toBeCloseTo(101, 6); // second occurrence: 100 + (1 - 0)
	});

	test("falls back to the first video/audio element when transcript has no recorded asset linkage", () => {
		// Two unrelated assets on the timeline; TranscriptionSegment carries no
		// mediaId, so the first video/audio element (track order) is used.
		const first = makeVideoElement({
			id: "el-1",
			mediaId: "asset-1",
			startTime: 0,
			duration: 10,
		});
		const second = makeVideoElement({
			id: "el-2",
			mediaId: "asset-2",
			startTime: 100,
			duration: 10,
		});
		const tracks: TimelineTrack[] = [makeVideoTrack([first, second])];

		const result = collectCaptionCues({
			tracks,
			transcriptSegments: [makeSegment(1, 1, 2)],
			mediaAssets: [makeMediaAsset("asset-1"), makeMediaAsset("asset-2")],
		});

		// Only the first asset's occurrence produces a cue.
		expect(result.cues).toHaveLength(1);
		expect(result.cues[0].startTime).toBeCloseTo(1, 6);
	});

	test("returns no cues when there is no transcript and no timeline subtitle track", () => {
		const tracks: TimelineTrack[] = [
			makeVideoTrack([makeVideoElement({ mediaId: "asset-1" })]),
		];
		const result = collectCaptionCues({
			tracks,
			transcriptSegments: [],
			mediaAssets: [makeMediaAsset("asset-1")],
		});
		expect(result.cues).toHaveLength(0);
		expect(result.source).toBe("transcript");
	});

	test("ignores non-upload audio elements (no mediaId) when scanning for a reference element", () => {
		const libraryAudio: AudioElement = {
			id: "audio-1",
			name: "Library audio",
			type: "audio",
			sourceType: "library",
			sourceUrl: "https://example.com/a.mp3",
			duration: 10,
			startTime: 0,
			trimStart: 0,
			trimEnd: 0,
			volume: 1,
		};
		const videoElement = makeVideoElement({
			mediaId: "asset-1",
			startTime: 0,
			duration: 10,
		});
		const tracks: TimelineTrack[] = [
			{
				id: "track-audio",
				name: "Audio",
				type: "audio",
				elements: [libraryAudio],
				muted: false,
			},
			makeVideoTrack([videoElement]),
		];

		const result = collectCaptionCues({
			tracks,
			transcriptSegments: [makeSegment(1, 1, 2)],
			mediaAssets: [makeMediaAsset("asset-1")],
		});

		expect(result.cues).toHaveLength(1);
		expect(result.cues[0].startTime).toBeCloseTo(1, 6);
	});
});

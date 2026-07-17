import { describe, expect, test } from "bun:test";
import {
	computeDuckKeyframes,
	deriveTranscriptSpans,
	deriveVoiceoverSpans,
} from "@/hooks/use-auto-duck";
import type {
	AudioTrack,
	TimelineTrack,
	UploadAudioElement,
} from "@/types/timeline";
import type { TranscriptionSegment } from "@/types/transcription";

function makeVoiceoverElement(
	overrides: Partial<UploadAudioElement> = {},
): UploadAudioElement {
	return {
		id: "vo-1",
		name: "Voiceover slot",
		duration: 5,
		startTime: 0,
		trimStart: 0,
		trimEnd: 0,
		type: "audio",
		sourceType: "upload",
		mediaId: "media-1",
		volume: 1,
		generation: {
			kind: "voiceover",
			prompt: "hello",
			mode: "text-to-video",
			resolution: "720p",
			orientation: "landscape",
			duration: 0,
		},
		...overrides,
	};
}

function makeAudioTrack(
	elements: UploadAudioElement[],
	overrides: Partial<AudioTrack> = {},
): AudioTrack {
	return {
		id: "track-1",
		name: "Voice",
		type: "audio",
		elements,
		muted: false,
		...overrides,
	};
}

describe("deriveVoiceoverSpans", () => {
	test("picks up an element carrying generation.kind === 'voiceover'", () => {
		const track = makeAudioTrack([
			makeVoiceoverElement({ startTime: 2, duration: 3 }),
		]);
		const spans = deriveVoiceoverSpans([track]);
		expect(spans).toEqual([{ start: 2, end: 5 }]);
	});

	test("ignores a generative slot whose generation.kind is 'video', even by name", () => {
		const track = makeAudioTrack([
			makeVoiceoverElement({
				name: "Voiceover slot",
				generation: {
					kind: "video",
					prompt: "not vo",
					mode: "text-to-video",
					resolution: "720p",
					orientation: "landscape",
					duration: 0,
				},
			}),
		]);
		expect(deriveVoiceoverSpans([track])).toEqual([]);
	});

	test("falls back to a name heuristic when generation is absent (older elements)", () => {
		const track = makeAudioTrack([
			makeVoiceoverElement({
				id: "legacy-1",
				name: "Voiceover",
				generation: undefined,
				startTime: 1,
				duration: 4,
			}),
			makeVoiceoverElement({
				id: "legacy-2",
				name: "Voice [en]: hello there",
				generation: undefined,
				startTime: 10,
				duration: 2,
			}),
		]);
		const spans = deriveVoiceoverSpans([track]);
		expect(spans).toEqual([
			{ start: 1, end: 5 },
			{ start: 10, end: 12 },
		]);
	});

	test("name fallback does not false-match 'video' (word-boundary on 'vo')", () => {
		const track = makeAudioTrack([
			makeVoiceoverElement({
				id: "not-vo",
				name: "video narration dump",
				generation: undefined,
			}),
		]);
		expect(deriveVoiceoverSpans([track])).toEqual([]);
	});

	test("uploaded music (no generation, unrelated name) is not a voiceover span", () => {
		const track = makeAudioTrack([
			makeVoiceoverElement({
				id: "music-1",
				name: "background-loop.mp3",
				generation: undefined,
			}),
		]);
		expect(deriveVoiceoverSpans([track])).toEqual([]);
	});

	test("multiple voiceover elements across tracks are all collected and sorted", () => {
		const trackA = makeAudioTrack(
			[makeVoiceoverElement({ id: "vo-b", startTime: 20, duration: 1 })],
			{ id: "track-a" },
		);
		const trackB = makeAudioTrack(
			[makeVoiceoverElement({ id: "vo-a", startTime: 0, duration: 1 })],
			{ id: "track-b" },
		);
		const spans = deriveVoiceoverSpans([trackA, trackB]);
		expect(spans).toEqual([
			{ start: 0, end: 1 },
			{ start: 20, end: 21 },
		]);
	});

	test("non-audio tracks are never scanned (voiceover elements can't live there)", () => {
		const videoTrack: TimelineTrack = {
			id: "vtrack",
			name: "Video",
			type: "video",
			elements: [],
			isMain: true,
			muted: false,
			hidden: false,
		};
		expect(deriveVoiceoverSpans([videoTrack])).toEqual([]);
	});

	test("zero-duration elements are excluded", () => {
		const track = makeAudioTrack([makeVoiceoverElement({ duration: 0 })]);
		expect(deriveVoiceoverSpans([track])).toEqual([]);
	});
});

describe("deriveTranscriptSpans", () => {
	test("keeps only non-empty segments, mapped to start/end", () => {
		const segments: TranscriptionSegment[] = [
			{ text: "hello", start: 0, end: 1 },
			{ text: "   ", start: 1, end: 2 },
			{ text: "world", start: 2, end: 3 },
		];
		expect(deriveTranscriptSpans(segments)).toEqual([
			{ start: 0, end: 1 },
			{ start: 2, end: 3 },
		]);
	});
});

describe("computeDuckKeyframes", () => {
	const musicElements = [{ id: "music-1", startTime: 0, duration: 20 }];

	test("no overlap produces no keyframes", () => {
		const keyframes = computeDuckKeyframes({
			spans: [{ start: 25, end: 27 }],
			musicElements,
			targetTrackId: "track-1",
			duckAmountDb: -18,
			fadeDurationSec: 0.3,
		});
		expect(keyframes).toEqual([]);
	});

	test("a single overlapping span produces fade-in/duck/recover/fade-out keyframes, element-relative", () => {
		const keyframes = computeDuckKeyframes({
			spans: [{ start: 5, end: 8 }],
			musicElements,
			targetTrackId: "track-1",
			duckAmountDb: -20,
			fadeDurationSec: 0.5,
		});

		const duckedVolume = 10 ** (-20 / 20);
		expect(keyframes).toEqual([
			{
				trackId: "track-1",
				elementId: "music-1",
				propertyPath: "volume",
				time: 4.5,
				value: 1,
				interpolation: "linear",
			},
			{
				trackId: "track-1",
				elementId: "music-1",
				propertyPath: "volume",
				time: 5,
				value: duckedVolume,
				interpolation: "linear",
			},
			{
				trackId: "track-1",
				elementId: "music-1",
				propertyPath: "volume",
				time: 8,
				value: duckedVolume,
				interpolation: "linear",
			},
			{
				trackId: "track-1",
				elementId: "music-1",
				propertyPath: "volume",
				time: 8.5,
				value: 1,
				interpolation: "linear",
			},
		]);
	});

	test("multiple non-overlapping voiceover spans each produce their own duck/recover pair", () => {
		const keyframes = computeDuckKeyframes({
			spans: [
				{ start: 2, end: 3 },
				{ start: 10, end: 11 },
			],
			musicElements,
			targetTrackId: "track-1",
			duckAmountDb: -18,
			fadeDurationSec: 0.3,
		});

		const times = keyframes.map((k) => k.time);
		// 2 spans x up to 4 keyframes each = 8, all within the single music element.
		expect(keyframes).toHaveLength(8);
		expect(times).toEqual([1.7, 2, 3, 3.3, 9.7, 10, 11, 11.3]);
	});

	test("a span that starts before the music element clamps fade-in/duck to the element start", () => {
		const duckedVolume = 10 ** (-18 / 20);
		const keyframes = computeDuckKeyframes({
			spans: [{ start: -1, end: 2 }],
			musicElements: [{ id: "music-1", startTime: 0, duration: 20 }],
			targetTrackId: "track-1",
			duckAmountDb: -18,
			fadeDurationSec: 0.5,
		});
		// Both the fade-in and duck-in keyframes clamp to time 0 (the element's
		// start) since the span begins before the element does; recover/fade-out
		// are unaffected.
		expect(keyframes.map((k) => ({ time: k.time, value: k.value }))).toEqual([
			{ time: 0, value: 1 },
			{ time: 0, value: duckedVolume },
			{ time: 2, value: duckedVolume },
			{ time: 2.5, value: 1 },
		]);
	});
});

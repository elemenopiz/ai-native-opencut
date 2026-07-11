import { describe, expect, test } from "bun:test";
import type { UploadAudioElement, VideoElement } from "@/types/timeline";
import type { MediaAsset } from "@/types/assets";
import { DEFAULT_TRANSFORM } from "@/constants/timeline-constants";
import {
	buildSeparatedAudioElement,
	canExtractSourceAudio,
	canRecoverSourceAudio,
	canToggleSourceAudio,
	doesElementHaveEnabledAudio,
	getSourceAudioActionLabel,
	isSourceAudioEnabled,
	isSourceAudioSeparated,
} from "@/lib/timeline/audio-separation";

function buildVideoElement(
	overrides: Partial<VideoElement> = {},
): VideoElement {
	return {
		id: "video-1",
		name: "Clip",
		type: "video",
		mediaId: "media-1",
		duration: 4,
		startTime: 0,
		trimStart: 0,
		trimEnd: 0,
		transform: DEFAULT_TRANSFORM,
		opacity: 1,
		...overrides,
	};
}

function buildAudioElement(
	overrides: Partial<UploadAudioElement> = {},
): UploadAudioElement {
	return {
		id: "audio-1",
		name: "Clip audio",
		type: "audio",
		sourceType: "upload",
		mediaId: "media-1",
		duration: 4,
		startTime: 0,
		trimStart: 0,
		trimEnd: 0,
		volume: 1,
		...overrides,
	};
}

function buildVideoMediaAsset(overrides: Partial<MediaAsset> = {}): MediaAsset {
	return {
		id: "media-1",
		name: "clip.mp4",
		type: "video",
		file: new File([], "clip.mp4", { type: "video/mp4" }),
		...overrides,
	};
}

describe("isSourceAudioEnabled / isSourceAudioSeparated", () => {
	test("defaults to enabled (linked) when the field is unset", () => {
		const element = buildVideoElement();
		expect(isSourceAudioEnabled({ element })).toBe(true);
		expect(isSourceAudioSeparated({ element })).toBe(false);
	});

	test("explicit true is enabled", () => {
		const element = buildVideoElement({ isSourceAudioEnabled: true });
		expect(isSourceAudioEnabled({ element })).toBe(true);
		expect(isSourceAudioSeparated({ element })).toBe(false);
	});

	test("false means detached/separated", () => {
		const element = buildVideoElement({ isSourceAudioEnabled: false });
		expect(isSourceAudioEnabled({ element })).toBe(false);
		expect(isSourceAudioSeparated({ element })).toBe(true);
	});
});

describe("canExtractSourceAudio", () => {
	test("true for a linked video clip whose media supports audio", () => {
		const element = buildVideoElement();
		expect(canExtractSourceAudio(element, buildVideoMediaAsset())).toBe(true);
	});

	test("false once already separated (no double-extraction)", () => {
		const element = buildVideoElement({ isSourceAudioEnabled: false });
		expect(canExtractSourceAudio(element, buildVideoMediaAsset())).toBe(false);
	});

	test("false for a zero-duration clip", () => {
		const element = buildVideoElement({ duration: 0 });
		expect(canExtractSourceAudio(element, buildVideoMediaAsset())).toBe(false);
	});

	test("false when the media asset is missing or doesn't support audio", () => {
		const element = buildVideoElement();
		expect(canExtractSourceAudio(element, null)).toBe(false);
		expect(
			canExtractSourceAudio(element, buildVideoMediaAsset({ type: "image" })),
		).toBe(false);
	});

	test("false for non-video elements", () => {
		const element = buildAudioElement();
		expect(canExtractSourceAudio(element, buildVideoMediaAsset())).toBe(false);
	});
});

describe("canRecoverSourceAudio / canToggleSourceAudio", () => {
	test("recover is only possible once separated", () => {
		expect(canRecoverSourceAudio(buildVideoElement())).toBe(false);
		expect(
			canRecoverSourceAudio(buildVideoElement({ isSourceAudioEnabled: false })),
		).toBe(true);
	});

	test("toggle is possible in either direction", () => {
		const linked = buildVideoElement();
		const separated = buildVideoElement({ isSourceAudioEnabled: false });
		const mediaAsset = buildVideoMediaAsset();

		expect(canToggleSourceAudio(linked, mediaAsset)).toBe(true);
		expect(canToggleSourceAudio(separated, mediaAsset)).toBe(true);
		// Separated clips can still be recovered even without a media asset
		// (recovery doesn't need to re-read the source media).
		expect(canToggleSourceAudio(separated, null)).toBe(true);
		// A linked clip whose media can't supply audio can't be toggled at all.
		expect(canToggleSourceAudio(linked, null)).toBe(false);
	});
});

describe("getSourceAudioActionLabel", () => {
	test("offers to extract when linked, recover when separated", () => {
		expect(getSourceAudioActionLabel({ element: buildVideoElement() })).toBe(
			"Extract audio",
		);
		expect(
			getSourceAudioActionLabel({
				element: buildVideoElement({ isSourceAudioEnabled: false }),
			}),
		).toBe("Recover audio");
	});
});

describe("buildSeparatedAudioElement", () => {
	test("carries timing/trim/speed over from the source clip", () => {
		const sourceElement = buildVideoElement({
			name: "Interview",
			startTime: 3,
			duration: 5,
			trimStart: 1,
			trimEnd: 0.5,
			sourceDuration: 10,
			muted: true,
			playbackRate: 1.5,
		});

		const built = buildSeparatedAudioElement({ sourceElement });

		expect(built.type).toBe("audio");
		expect(built.sourceType).toBe("upload");
		expect(built.mediaId).toBe(sourceElement.mediaId);
		expect(built.name).toBe("Interview (audio)");
		expect(built.startTime).toBe(3);
		expect(built.duration).toBe(5);
		expect(built.trimStart).toBe(1);
		expect(built.trimEnd).toBe(0.5);
		expect(built.sourceDuration).toBe(10);
		expect(built.muted).toBe(true);
		expect(built.playbackRate).toBe(1.5);
		expect(built.volume).toBe(1);
	});

	test("unmuted, rate-1 source produces an unmuted rate-1 copy", () => {
		const built = buildSeparatedAudioElement({
			sourceElement: buildVideoElement(),
		});
		expect(built.muted).toBe(false);
		expect(built.playbackRate).toBeUndefined();
	});
});

describe("doesElementHaveEnabledAudio", () => {
	test("audio elements always contribute audio", () => {
		expect(
			doesElementHaveEnabledAudio({
				element: buildAudioElement(),
				mediaAsset: null,
			}),
		).toBe(true);
	});

	test("a linked video element with audio-capable media contributes audio", () => {
		expect(
			doesElementHaveEnabledAudio({
				element: buildVideoElement(),
				mediaAsset: buildVideoMediaAsset(),
			}),
		).toBe(true);
	});

	test("a separated video element does NOT contribute audio (avoids doubling with the detached copy)", () => {
		expect(
			doesElementHaveEnabledAudio({
				element: buildVideoElement({ isSourceAudioEnabled: false }),
				mediaAsset: buildVideoMediaAsset(),
			}),
		).toBe(false);
	});

	test("a video element whose media has no audio track contributes none", () => {
		expect(
			doesElementHaveEnabledAudio({
				element: buildVideoElement(),
				mediaAsset: buildVideoMediaAsset({ type: "image" }),
			}),
		).toBe(false);
	});
});

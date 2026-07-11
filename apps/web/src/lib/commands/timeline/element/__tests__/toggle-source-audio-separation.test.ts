import { afterEach, describe, expect, test } from "bun:test";
import { EditorCore } from "@/core";
import type {
	AudioElement,
	TimelineTrack,
	UploadAudioElement,
	VideoElement,
} from "@/types/timeline";
import type { MediaAsset } from "@/types/assets";
import { DEFAULT_TRANSFORM } from "@/constants/timeline-constants";
import { ToggleSourceAudioSeparationCommand } from "@/lib/commands/timeline/element/toggle-source-audio-separation";

type MockEditor = {
	timeline: {
		getTracks: () => TimelineTrack[];
		updateTracks: (tracks: TimelineTrack[]) => void;
	};
	media: {
		getAssets: () => MediaAsset[];
	};
};

const originalGetInstance = EditorCore.getInstance;

function mockEditorCore({ editor }: { editor: MockEditor }): void {
	(
		EditorCore as unknown as {
			getInstance: () => EditorCore;
		}
	).getInstance = () => editor as unknown as EditorCore;
}

function restoreEditorCore(): void {
	(
		EditorCore as unknown as {
			getInstance: typeof EditorCore.getInstance;
		}
	).getInstance = originalGetInstance;
}

function buildVideoElement(
	overrides: Partial<VideoElement> = {},
): VideoElement {
	return {
		id: "video-1",
		name: "Clip",
		type: "video",
		mediaId: "media-1",
		duration: 4,
		startTime: 2,
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
		id: "existing-audio",
		name: "Existing audio",
		type: "audio",
		sourceType: "upload",
		mediaId: "media-other",
		duration: 1,
		startTime: 0,
		trimStart: 0,
		trimEnd: 0,
		volume: 1,
		...overrides,
	};
}

function buildVideoTrack(elements: VideoElement[]): TimelineTrack {
	return {
		id: "video-track",
		name: "Video",
		type: "video",
		elements,
		isMain: false,
		muted: false,
		hidden: false,
	};
}

function buildAudioTrack({
	id,
	elements,
}: {
	id: string;
	elements: AudioElement[];
}): TimelineTrack {
	return {
		id,
		name: "Audio",
		type: "audio",
		elements,
		muted: false,
	};
}

function buildVideoMediaAsset(overrides: Partial<MediaAsset> = {}): MediaAsset {
	return {
		id: "media-1",
		name: "clip.mp4",
		type: "video",
		file: new File([], "clip.mp4", { type: "video/mp4" }),
		...overrides,
	} as MediaAsset;
}

function run({
	tracks,
	mediaAssets,
	trackId,
	elementId,
}: {
	tracks: TimelineTrack[];
	mediaAssets: MediaAsset[];
	trackId: string;
	elementId: string;
}): {
	updatedTracks: TimelineTrack[];
	command: ToggleSourceAudioSeparationCommand;
} {
	let updatedTracks: TimelineTrack[] = tracks;
	mockEditorCore({
		editor: {
			timeline: {
				getTracks: () => tracks,
				updateTracks: (nextTracks) => {
					updatedTracks = nextTracks;
				},
			},
			media: {
				getAssets: () => mediaAssets,
			},
		},
	});

	const command = new ToggleSourceAudioSeparationCommand({
		trackId,
		elementId,
	});
	command.execute();

	return { updatedTracks, command };
}

function findVideoElement(
	tracks: TimelineTrack[],
	elementId: string,
): VideoElement {
	for (const track of tracks) {
		const element = track.elements.find((el) => el.id === elementId);
		if (element && element.type === "video") return element;
	}
	throw new Error(`video element ${elementId} not found`);
}

afterEach(() => {
	restoreEditorCore();
});

describe("ToggleSourceAudioSeparationCommand — extract", () => {
	test("extracts audio onto a new audio track and marks the video as detached", () => {
		const videoTrack = buildVideoTrack([buildVideoElement()]);
		const tracks = [videoTrack];

		const { updatedTracks } = run({
			tracks,
			mediaAssets: [buildVideoMediaAsset()],
			trackId: videoTrack.id,
			elementId: "video-1",
		});

		const videoElement = findVideoElement(updatedTracks, "video-1");
		expect(videoElement.isSourceAudioEnabled).toBe(false);

		const audioTracks = updatedTracks.filter((track) => track.type === "audio");
		expect(audioTracks).toHaveLength(1);
		expect(audioTracks[0].elements).toHaveLength(1);

		const separated = audioTracks[0].elements[0] as UploadAudioElement;
		expect(separated.type).toBe("audio");
		expect(separated.mediaId).toBe("media-1");
		expect(separated.startTime).toBe(videoElement.startTime);
		expect(separated.duration).toBe(videoElement.duration);
		expect(separated.id).not.toBe(videoElement.id);
	});

	test("reuses an existing audio track when the new clip doesn't overlap", () => {
		const videoTrack = buildVideoTrack([buildVideoElement({ startTime: 10 })]);
		const audioTrack = buildAudioTrack({
			id: "audio-track",
			elements: [buildAudioElement({ startTime: 0, duration: 1 })],
		});
		const tracks = [videoTrack, audioTrack];

		const { updatedTracks } = run({
			tracks,
			mediaAssets: [buildVideoMediaAsset()],
			trackId: videoTrack.id,
			elementId: "video-1",
		});

		expect(updatedTracks).toHaveLength(2);
		const resultAudioTrack = updatedTracks.find((t) => t.id === "audio-track");
		expect(resultAudioTrack?.elements).toHaveLength(2);
	});

	test("creates a new audio track when the existing one would overlap", () => {
		const videoTrack = buildVideoTrack([buildVideoElement({ startTime: 0 })]);
		const audioTrack = buildAudioTrack({
			id: "audio-track",
			elements: [buildAudioElement({ startTime: 0, duration: 4 })],
		});
		const tracks = [videoTrack, audioTrack];

		const { updatedTracks } = run({
			tracks,
			mediaAssets: [buildVideoMediaAsset()],
			trackId: videoTrack.id,
			elementId: "video-1",
		});

		const audioTracks = updatedTracks.filter((track) => track.type === "audio");
		expect(audioTracks).toHaveLength(2);
	});

	test("is a no-op when the media asset can't supply audio", () => {
		const videoTrack = buildVideoTrack([buildVideoElement()]);
		const tracks = [videoTrack];

		const { updatedTracks } = run({
			tracks,
			mediaAssets: [buildVideoMediaAsset({ type: "image" })],
			trackId: videoTrack.id,
			elementId: "video-1",
		});

		// updateTracks was never called, so the mock's `updatedTracks` still
		// points at the original array reference.
		expect(updatedTracks).toBe(tracks);
	});

	test("is a no-op on a zero-duration clip (nothing to extract)", () => {
		const videoTrack = buildVideoTrack([buildVideoElement({ duration: 0 })]);
		const tracks = [videoTrack];

		const { updatedTracks } = run({
			tracks,
			mediaAssets: [buildVideoMediaAsset()],
			trackId: videoTrack.id,
			elementId: "video-1",
		});

		expect(updatedTracks).toBe(tracks);
	});
});

describe("ToggleSourceAudioSeparationCommand — recover", () => {
	test("flips the video back to linked without touching the detached copy", () => {
		const videoTrack = buildVideoTrack([
			buildVideoElement({ isSourceAudioEnabled: false }),
		]);
		const audioTrack = buildAudioTrack({
			id: "audio-track",
			elements: [
				buildAudioElement({ id: "detached-audio", mediaId: "media-1" }),
			],
		});
		const tracks = [videoTrack, audioTrack];

		const { updatedTracks } = run({
			tracks,
			mediaAssets: [buildVideoMediaAsset()],
			trackId: videoTrack.id,
			elementId: "video-1",
		});

		const videoElement = findVideoElement(updatedTracks, "video-1");
		expect(videoElement.isSourceAudioEnabled).toBe(true);

		// The previously-detached audio element is left in place — recovering
		// re-enables the video's own audio, it doesn't delete the independent
		// copy (which may have since been trimmed/moved by the user).
		const resultAudioTrack = updatedTracks.find((t) => t.id === "audio-track");
		expect(resultAudioTrack?.elements.map((e) => e.id)).toEqual([
			"detached-audio",
		]);
	});
});

describe("ToggleSourceAudioSeparationCommand — undo", () => {
	test("undo restores the pre-extraction track state exactly", () => {
		const videoTrack = buildVideoTrack([buildVideoElement()]);
		const tracks = [videoTrack];
		const originalTracksSnapshot = JSON.parse(JSON.stringify(tracks));

		let latestTracks: TimelineTrack[] = tracks;
		mockEditorCore({
			editor: {
				timeline: {
					getTracks: () => latestTracks,
					updateTracks: (nextTracks) => {
						latestTracks = nextTracks;
					},
				},
				media: {
					getAssets: () => [buildVideoMediaAsset()],
				},
			},
		});

		const command = new ToggleSourceAudioSeparationCommand({
			trackId: videoTrack.id,
			elementId: "video-1",
		});
		command.execute();

		// sanity: extraction actually happened
		expect(latestTracks.some((track) => track.type === "audio")).toBe(true);

		command.undo();

		expect(latestTracks).toEqual(originalTracksSnapshot);
	});
});

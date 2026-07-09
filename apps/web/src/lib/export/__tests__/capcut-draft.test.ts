import { describe, expect, test } from "bun:test";
import type {
	AudioTrack,
	StickerTrack,
	TextTrack,
	VideoTrack,
} from "@/types/timeline";
import {
	serializeCapcutDraft,
	type CapcutMediaAssetInfo,
} from "../capcut-draft";
import { createZip } from "../capcut-zip";

function makeTestIdFactory() {
	let counter = 0;
	return () => {
		counter += 1;
		return `test-id-${counter}`;
	};
}

const mediaAssets: CapcutMediaAssetInfo[] = [
	{
		id: "asset-video",
		name: "drone shot.mp4",
		type: "video",
		width: 1920,
		height: 1080,
		duration: 12,
	},
	{
		id: "asset-image",
		name: "logo.png",
		type: "image",
		width: 512,
		height: 512,
	},
	{
		id: "asset-audio",
		name: "voiceover.mp3",
		type: "audio",
		duration: 8,
	},
];

const mainVideoTrack: VideoTrack = {
	id: "track-main",
	name: "Main",
	type: "video",
	isMain: true,
	muted: false,
	hidden: false,
	elements: [
		{
			id: "el-video",
			type: "video",
			name: "drone shot",
			mediaId: "asset-video",
			startTime: 0,
			duration: 4,
			trimStart: 1,
			trimEnd: 0,
			playbackRate: 2,
			transform: { scale: 1, position: { x: 0, y: 0 }, rotate: 0 },
			opacity: 1,
		},
		{
			id: "el-image",
			type: "image",
			name: "logo",
			mediaId: "asset-image",
			startTime: 4,
			duration: 2,
			trimStart: 0,
			trimEnd: 0,
			transform: { scale: 0.5, position: { x: 960, y: 540 }, rotate: 90 },
			opacity: 0.8,
			animations: {
				channels: {
					"transform.position.x": {
						valueKind: "number",
						keyframes: [
							{ id: "kf-1", time: 0, value: 0, interpolation: "linear" },
							{ id: "kf-2", time: 1, value: 960, interpolation: "linear" },
						],
					},
				},
			},
		},
	],
};

const audioTrack: AudioTrack = {
	id: "track-audio",
	name: "Audio",
	type: "audio",
	muted: false,
	elements: [
		{
			id: "el-audio",
			type: "audio",
			sourceType: "upload",
			name: "voiceover",
			mediaId: "asset-audio",
			startTime: 0.5,
			duration: 6,
			trimStart: 0,
			trimEnd: 0,
			volume: 0.7,
		},
	],
};

const textTrack: TextTrack = {
	id: "track-text",
	name: "Text",
	type: "text",
	hidden: false,
	elements: [
		{
			id: "el-text",
			type: "text",
			name: "Title",
			content: "Hello CapCut",
			fontSize: 15,
			fontFamily: "Inter",
			color: "#FF0000",
			background: { enabled: false, color: "#000000" },
			textAlign: "center",
			fontWeight: "bold",
			fontStyle: "normal",
			textDecoration: "none",
			startTime: 1,
			duration: 3,
			trimStart: 0,
			trimEnd: 0,
			transform: { scale: 1, position: { x: 0, y: -400 }, rotate: 0 },
			opacity: 1,
		},
	],
};

const stickerTrack: StickerTrack = {
	id: "track-sticker",
	name: "Stickers",
	type: "sticker",
	hidden: false,
	elements: [
		{
			id: "el-sticker",
			type: "sticker",
			name: "arrow",
			stickerId: "mdi:arrow",
			startTime: 0,
			duration: 2,
			trimStart: 0,
			trimEnd: 0,
			transform: { scale: 1, position: { x: 0, y: 0 }, rotate: 0 },
			opacity: 1,
		},
	],
};

function serializeFixture() {
	return serializeCapcutDraft({
		projectName: "Test Reel",
		fps: 30,
		canvasSize: { width: 1920, height: 1080 },
		tracks: [textTrack, stickerTrack, audioTrack, mainVideoTrack],
		mediaAssets,
		createId: makeTestIdFactory(),
		now: () => 1_700_000_000_000,
	});
}

describe("serializeCapcutDraft", () => {
	test("produces a draft_content.json with the expected top-level shape", () => {
		const { draftContent } = serializeFixture();

		expect(draftContent.version).toBe(360000);
		expect(draftContent.new_version).toBe("110.0.0");
		expect(draftContent.fps).toBe(30);
		expect(draftContent.canvas_config).toEqual({
			width: 1920,
			height: 1080,
			ratio: "original",
		});
		// Longest element: audio ends at 6.5s -> 6,500,000us.
		expect(draftContent.duration).toBe(6_500_000);

		const materials = draftContent.materials as Record<string, unknown[]>;
		expect(materials.videos).toHaveLength(2);
		expect(materials.audios).toHaveLength(1);
		expect(materials.texts).toHaveLength(1);
		// One speed material per segment (2 video + 1 audio + 1 text).
		expect(materials.speeds).toHaveLength(4);
		expect(materials.transitions).toEqual([]);
	});

	test("maps tracks bottom-to-top with typed segments", () => {
		const { draftContent } = serializeFixture();
		const tracks = draftContent.tracks as Record<string, unknown>[];

		// Sticker track skipped -> video, audio, text remain.
		expect(tracks.map((track) => track.type)).toEqual([
			"video",
			"audio",
			"text",
		]);

		const videoSegments = tracks[0].segments as Record<string, unknown>[];
		expect(videoSegments).toHaveLength(2);

		const videoSegment = videoSegments[0];
		expect(videoSegment.target_timerange).toEqual({
			start: 0,
			duration: 4_000_000,
		});
		// source duration = timeline duration * playbackRate (2x).
		expect(videoSegment.source_timerange).toEqual({
			start: 1_000_000,
			duration: 8_000_000,
		});
		expect(videoSegment.speed).toBe(2);
		expect(videoSegment.render_index).toBe(0);

		const audioSegment = (tracks[1].segments as Record<string, unknown>[])[0];
		expect(audioSegment.target_timerange).toEqual({
			start: 500_000,
			duration: 6_000_000,
		});
		expect(audioSegment.volume).toBe(0.7);
		expect(audioSegment.render_index).toBe(1);
	});

	test("converts transforms to half-canvas units with y flipped", () => {
		const { draftContent } = serializeFixture();
		const tracks = draftContent.tracks as Record<string, unknown>[];
		const imageSegment = (tracks[0].segments as Record<string, unknown>[])[1];

		const clip = imageSegment.clip as {
			alpha: number;
			rotation: number;
			scale: { x: number; y: number };
			transform: { x: number; y: number };
		};
		expect(clip.alpha).toBe(0.8);
		expect(clip.rotation).toBe(90);
		expect(clip.scale).toEqual({ x: 0.5, y: 0.5 });
		// (960, 540) px on 1920x1080 -> (1, -1) in half-canvas units (y up).
		expect(clip.transform).toEqual({ x: 1, y: -1 });

		const textSegment = ((tracks[2] as Record<string, unknown>)
			.segments as Record<string, unknown>[])[0];
		const textClip = textSegment.clip as { transform: { y: number } };
		// -400px (up in Byorn) -> +0.740740... (up in CapCut).
		expect(textClip.transform.y).toBeCloseTo(400 / 540, 5);
	});

	test("exports linear number keyframes as common_keyframes", () => {
		const { draftContent } = serializeFixture();
		const tracks = draftContent.tracks as Record<string, unknown>[];
		const imageSegment = (tracks[0].segments as Record<string, unknown>[])[1];
		const keyframeLists = imageSegment.common_keyframes as Record<
			string,
			unknown
		>[];

		expect(keyframeLists).toHaveLength(1);
		expect(keyframeLists[0].property_type).toBe("KFTypePositionX");
		const keyframes = keyframeLists[0].keyframe_list as Record<
			string,
			unknown
		>[];
		expect(keyframes).toHaveLength(2);
		expect(keyframes[0].time_offset).toBe(0);
		expect(keyframes[1].time_offset).toBe(1_000_000);
		// 960px -> 1.0 half-canvas widths.
		expect(keyframes[1].values).toEqual([1]);
	});

	test("maps text elements to JSON-in-JSON text materials", () => {
		const { draftContent } = serializeFixture();
		const materials = draftContent.materials as Record<
			string,
			Record<string, unknown>[]
		>;
		const textMaterial = materials.texts[0];

		expect(textMaterial.type).toBe("text");
		expect(textMaterial.alignment).toBe(1);

		const content = JSON.parse(textMaterial.content as string);
		expect(content.text).toBe("Hello CapCut");
		expect(content.styles[0].bold).toBe(true);
		expect(content.styles[0].size).toBe(15);
		expect(content.styles[0].fill.content.solid.color).toEqual([1, 0, 0]);
		expect(content.styles[0].range).toEqual([0, "Hello CapCut".length]);
	});

	test("degrades unsupported features to warnings instead of crashing", () => {
		const { warnings, mediaFiles, draftMetaInfo } = serializeFixture();

		expect(
			warnings.some((warning) => warning.includes("Sticker track")),
		).toBe(true);

		expect(mediaFiles).toHaveLength(3);
		expect(mediaFiles.every((file) => file.zipPath.startsWith("Resources/")))
			.toBe(true);

		const draftMaterials = draftMetaInfo.draft_materials as {
			type: number;
			value: unknown[];
		}[];
		expect(draftMaterials[0].type).toBe(0);
		expect(draftMaterials[0].value).toHaveLength(3);
	});

	test("skips elements whose media asset is missing, with a warning", () => {
		const brokenTrack: VideoTrack = {
			...mainVideoTrack,
			elements: [
				{
					...mainVideoTrack.elements[0],
					id: "el-missing",
					name: "missing media",
					mediaId: "nope",
				},
			],
		};

		const { draftContent, warnings } = serializeCapcutDraft({
			projectName: "Broken",
			fps: 30,
			canvasSize: { width: 1080, height: 1920 },
			tracks: [brokenTrack],
			mediaAssets: [],
			createId: makeTestIdFactory(),
		});

		expect(draftContent.tracks).toEqual([]);
		expect(warnings.some((warning) => warning.includes("missing media")))
			.toBe(true);
	});
});

describe("createZip", () => {
	test("produces a valid store-only zip layout", () => {
		const data = new TextEncoder().encode("hello capcut");
		const zip = createZip({
			entries: [{ path: "Draft/draft_content.json", data }],
			date: new Date(2026, 0, 1, 12, 0, 0),
		});

		const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
		// Local file header signature.
		expect(view.getUint32(0, true)).toBe(0x04034b50);
		// Store method (no compression).
		expect(view.getUint16(8, true)).toBe(0);
		// Uncompressed size matches payload.
		expect(view.getUint32(22, true)).toBe(data.length);
		// End-of-central-directory signature present in the trailer.
		expect(view.getUint32(zip.length - 22, true)).toBe(0x06054b50);
		// Entry count.
		expect(view.getUint16(zip.length - 22 + 10, true)).toBe(1);
	});
});

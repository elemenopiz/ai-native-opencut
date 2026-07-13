import { describe, expect, it } from "bun:test";
import type { RootNode } from "@/services/renderer/nodes/root-node";
import type { MediaAsset } from "@/types/assets";
import type { TBackground, TCanvasSize } from "@/types/project";
import type { TimelineTrack, VideoElement } from "@/types/timeline";
import {
	buildSingleClipTrack,
	clipAssetName,
	clipSourceEnd,
	clipSourceStart,
	extractTrimmedVideoComposited,
	extractTrimmedVideoRaw,
	trimmedVideoRange,
	type ClipRenderer,
	type ClipSceneBuilder,
} from "@/lib/media/clip-reference";

// A clip placed at timeline 10s, showing source [2s, 7s] (trimStart 2, 5s visible).
const EL = { startTime: 10, duration: 5, trimStart: 2 };

describe("clip source-time math (respecting trim)", () => {
	it("start is the trimStart, end is trimStart + visibleDuration", () => {
		expect(clipSourceStart(EL)).toBe(2);
		expect(clipSourceEnd(EL)).toBe(7);
		expect(trimmedVideoRange(EL)).toEqual({ start: 2, end: 7 });
	});

	it("uses the FULL visible span with no last-frame epsilon", () => {
		// Contrast with still extraction, which nudges the end back by an epsilon.
		expect(clipSourceEnd(EL)).toBe(EL.trimStart + EL.duration);
	});

	it("handles a zero trimStart (untrimmed head)", () => {
		const el = { startTime: 0, duration: 3, trimStart: 0 };
		expect(trimmedVideoRange(el)).toEqual({ start: 0, end: 3 });
	});

	it("clamps a negative trimStart to 0 on the start bound", () => {
		const el = { startTime: 0, duration: 4, trimStart: -1 };
		expect(clipSourceStart(el)).toBe(0);
		// end stays trimStart + duration (spec) — the raw range, unclamped.
		expect(clipSourceEnd(el)).toBe(3);
	});

	it("is unaffected by where the clip sits on the timeline", () => {
		const early = { startTime: 0, duration: 5, trimStart: 2 };
		const late = { startTime: 99, duration: 5, trimStart: 2 };
		expect(trimmedVideoRange(early)).toEqual(trimmedVideoRange(late));
	});
});

describe("clip naming", () => {
	it("names an extracted clip and strips the source extension", () => {
		expect(clipAssetName("beach.mp4")).toBe("beach — clip");
		expect(clipAssetName("shot.MOV")).toBe("shot — clip");
	});

	it("falls back to a default base when the name is empty", () => {
		expect(clipAssetName("")).toBe("Clip — clip");
	});
});

describe("extractTrimmedVideoRaw", () => {
	it("converts the trimmed range and returns a video File with source dims", async () => {
		const cap: { seen?: { start: number; end: number; format: string } } = {};
		const result = await extractTrimmedVideoRaw({
			element: EL,
			source: { videoFile: new File(["x"], "src.mp4") },
			sourceName: "beach.mp4",
			convert: async ({ start, end, format }) => {
				cap.seen = { start, end, format };
				return { buffer: new ArrayBuffer(16), width: 1920, height: 1080 };
			},
		});

		// convert got the exact source range and the default mp4 format.
		expect(cap.seen).toEqual({ start: 2, end: 7, format: "mp4" });

		expect(result.width).toBe(1920);
		expect(result.height).toBe(1080);
		expect(result.durationSec).toBe(5); // end - start
		expect(result.file.type).toBe("video/mp4");
		expect(result.file.name).toBe("beach — clip.mp4");
		expect(result.file.size).toBeGreaterThan(0);
	});

	it("honors a webm format (mime + extension)", async () => {
		const result = await extractTrimmedVideoRaw({
			element: EL,
			source: { videoFile: new File(["x"], "src.webm") },
			sourceName: "clip.webm",
			format: "webm",
			convert: async () => ({
				buffer: new ArrayBuffer(8),
				width: 1280,
				height: 720,
			}),
		});
		expect(result.file.type).toBe("video/webm");
		expect(result.file.name).toBe("clip — clip.webm");
	});

	it("throws when there is no source to cut from", async () => {
		await expect(
			extractTrimmedVideoRaw({
				element: EL,
				source: {},
				sourceName: "beach.mp4",
				convert: async () => ({
					buffer: new ArrayBuffer(8),
					width: 1,
					height: 1,
				}),
			}),
		).rejects.toThrow(/no source/i);
	});

	it("throws when the visible range is empty (zero duration)", async () => {
		let called = false;
		await expect(
			extractTrimmedVideoRaw({
				element: { startTime: 0, duration: 0, trimStart: 2 },
				source: { videoFile: new File(["x"], "src.mp4") },
				sourceName: "beach.mp4",
				convert: async () => {
					called = true;
					return { buffer: new ArrayBuffer(8), width: 1, height: 1 };
				},
			}),
		).rejects.toThrow(/no visible duration/i);
		expect(called).toBe(false);
	});
});

describe("buildSingleClipTrack", () => {
	it("pins the clone to t=0 while preserving trim + edits", () => {
		const element = {
			id: "el_1",
			type: "video",
			name: "shot",
			mediaId: "media_1",
			startTime: 10,
			duration: 5,
			trimStart: 2,
			trimEnd: 1,
			opacity: 1,
			transform: {},
			effects: [{ id: "fx_1" }],
			playbackRate: 2,
		} as unknown as VideoElement;

		const track = buildSingleClipTrack(element);

		expect(track.type).toBe("video");
		expect(track.isMain).toBe(true);
		expect(track.muted).toBe(false);
		expect(track.elements).toHaveLength(1);

		const placed = track.elements[0];
		expect(placed.startTime).toBe(0); // moved to the mini-scene origin
		expect(placed.trimStart).toBe(2); // trim untouched
		expect(placed.duration).toBe(5);
		expect((placed as VideoElement).playbackRate).toBe(2); // edits survive
		// Shallow clone keeps the same effects array (edits carried through).
		expect(placed.effects).toBe(element.effects);

		// The clone is shallow — the real element is not mutated.
		expect(element.startTime).toBe(10);
	});
});

describe("extractTrimmedVideoComposited", () => {
	const CANVAS: TCanvasSize = { width: 720, height: 1280 };
	const BACKGROUND: TBackground = { type: "color", color: "#000000" };
	const ASSETS: MediaAsset[] = [];
	const FAKE_ROOT = { id: "root" } as unknown as RootNode;

	function makeElement(): VideoElement {
		return {
			id: "el_1",
			type: "video",
			name: "shot",
			mediaId: "media_1",
			startTime: 10,
			duration: 4,
			trimStart: 2,
			trimEnd: 0,
			opacity: 1,
			transform: {},
		} as unknown as VideoElement;
	}

	it("renders the one-clip scene and returns a File at canvas dimensions", async () => {
		const cap: {
			builtWith?: Parameters<ClipSceneBuilder>[0];
			renderedWith?: Parameters<ClipRenderer>[0];
		} = {};

		const result = await extractTrimmedVideoComposited({
			element: makeElement(),
			mediaAssets: ASSETS,
			canvasSize: CANVAS,
			background: BACKGROUND,
			fps: 30,
			buildSceneFn: (params) => {
				cap.builtWith = params;
				return FAKE_ROOT;
			},
			render: async (params) => {
				cap.renderedWith = params;
				return new ArrayBuffer(32);
			},
		});

		// buildScene received the single synthetic track + real project context.
		expect(cap.builtWith?.tracks).toHaveLength(1);
		expect(cap.builtWith?.tracks[0].elements[0].startTime).toBe(0);
		expect(cap.builtWith?.duration).toBe(4);
		expect(cap.builtWith?.canvasSize).toBe(CANVAS);
		expect(cap.builtWith?.background).toBe(BACKGROUND);

		// render received the built scene + defaults (mp4/high, audio off).
		expect(cap.renderedWith?.rootNode).toBe(FAKE_ROOT);
		expect(cap.renderedWith?.width).toBe(720);
		expect(cap.renderedWith?.height).toBe(1280);
		expect(cap.renderedWith?.fps).toBe(30);
		expect(cap.renderedWith?.format).toBe("mp4");
		expect(cap.renderedWith?.quality).toBe("high");
		expect(cap.renderedWith?.includeAudio).toBe(false);

		expect(result.width).toBe(720);
		expect(result.height).toBe(1280);
		expect(result.durationSec).toBe(4);
		expect(result.file.type).toBe("video/mp4");
		expect(result.file.name).toBe("shot — clip.mp4");
		expect(result.file.size).toBeGreaterThan(0);
	});

	it("does not build audio unless includeAudio is set", async () => {
		let audioCalls = 0;
		await extractTrimmedVideoComposited({
			element: makeElement(),
			mediaAssets: ASSETS,
			canvasSize: CANVAS,
			background: BACKGROUND,
			fps: 30,
			buildSceneFn: () => FAKE_ROOT,
			render: async () => new ArrayBuffer(8),
			createAudioBuffer: async () => {
				audioCalls++;
				return null;
			},
		});
		expect(audioCalls).toBe(0);
	});

	it("builds + forwards an audio buffer when includeAudio is set", async () => {
		const FAKE_AUDIO = {} as AudioBuffer;
		const cap: {
			audioTracks?: TimelineTrack[];
			renderIncludeAudio?: boolean;
			renderAudio?: AudioBuffer;
		} = {};

		await extractTrimmedVideoComposited({
			element: makeElement(),
			mediaAssets: ASSETS,
			canvasSize: CANVAS,
			background: BACKGROUND,
			fps: 30,
			includeAudio: true,
			buildSceneFn: () => FAKE_ROOT,
			render: async (params) => {
				cap.renderIncludeAudio = params.includeAudio;
				cap.renderAudio = params.audioBuffer;
				return new ArrayBuffer(8);
			},
			createAudioBuffer: async ({ tracks }) => {
				cap.audioTracks = tracks;
				return FAKE_AUDIO;
			},
		});

		expect(cap.audioTracks).toHaveLength(1);
		expect(cap.renderIncludeAudio).toBe(true);
		expect(cap.renderAudio).toBe(FAKE_AUDIO);
	});

	it("keeps includeAudio false to the renderer when no audio buffer results", async () => {
		const cap: { renderIncludeAudio?: boolean } = {};
		await extractTrimmedVideoComposited({
			element: makeElement(),
			mediaAssets: ASSETS,
			canvasSize: CANVAS,
			background: BACKGROUND,
			fps: 30,
			includeAudio: true,
			buildSceneFn: () => FAKE_ROOT,
			render: async (params) => {
				cap.renderIncludeAudio = params.includeAudio;
				return new ArrayBuffer(8);
			},
			createAudioBuffer: async () => null, // clip has no usable audio
		});
		// includeAudio requested, but no buffer → renderer told audio is off.
		expect(cap.renderIncludeAudio).toBe(false);
	});

	it("throws when the element has no visible duration", async () => {
		const element = { ...makeElement(), duration: 0 } as VideoElement;
		await expect(
			extractTrimmedVideoComposited({
				element,
				mediaAssets: ASSETS,
				canvasSize: CANVAS,
				background: BACKGROUND,
				fps: 30,
				buildSceneFn: () => FAKE_ROOT,
				render: async () => new ArrayBuffer(8),
			}),
		).rejects.toThrow(/no visible duration/i);
	});
});

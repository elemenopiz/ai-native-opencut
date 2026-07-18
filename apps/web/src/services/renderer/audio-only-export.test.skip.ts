import { beforeEach, describe, expect, mock, test } from "bun:test";
import { DEFAULT_TRANSFORM } from "@/constants/timeline-constants";
import { DEFAULT_TEXT_BACKGROUND } from "@/constants/text-constants";
import type { EditorCore } from "@/core";
import type {
	AudioElement,
	AudioTrack,
	EffectElement,
	EffectTrack,
	StickerElement,
	StickerTrack,
	TextElement,
	TextTrack,
	TimelineTrack,
	VideoElement,
	VideoTrack,
} from "@/types/timeline";

/**
 * BUG17 — exporting an audio-only project used to emit a blank 1920x1080
 * H.264 video stream (~90 static background frames) alongside the audio:
 * wasted encode time/bytes and confusing in players. The fix has two seams:
 *
 *  1. `hasVisualContent` (renderer-manager.ts) — a pure predicate over the
 *     project's tracks/elements, mirroring scene-builder's own visibility
 *     filtering, that decides whether the scene has anything to paint.
 *  2. `RendererManager.exportProject` wires that predicate into (a) a
 *     fail-fast "Nothing to export" error when there's neither visual
 *     content nor audio, and (b) an `includeVideoTrack` flag forwarded to
 *     `SceneExporter` so an audio-only export drops the video stream instead
 *     of rendering/encoding blank frames.
 *
 * These tests exercise both seams directly. Constructing a real
 * `CanvasRenderer`/`SceneExporter` requires `OffscreenCanvas`/mediabunny,
 * neither available under `bun test` — so the "SceneExporter skips
 * video-track setup" behavior is verified here by mocking `scene-builder`
 * and `scene-exporter` and asserting the exact `includeVideoTrack` value
 * `exportProject` hands to `SceneExporter`'s constructor, instead of driving
 * a real encode (which the campaign's browser-verified e2e already covers).
 */

// ---- mock @/lib/media/audio -----------------------------------------------
// createTimelineAudioBuffer talks to a real Web Audio AudioContext, which
// doesn't exist under bun test. It legitimately returns `null` whenever the
// timeline has no audio elements to mix (see its source) — tests drive that
// exact contract via this mock instead of exercising real audio decode.
//
// bun's `mock.module` is process-global (replaces the module for every test
// file in the whole `bun test` run, not just this one — see the sibling
// gotcha noted in `core/managers/__tests__/media-manager-decode-reprobe.test.ts`).
// `@/lib/media/audio` is also imported directly by
// `lib/media/__tests__/resolve-mix-element.test.ts` and
// `lib/media/__tests__/audio-mixdown.test.ts` — spread the real module's
// exports so only `createTimelineAudioBuffer` changes and those suites keep
// working regardless of file run order.
const actualAudioModule = await import("@/lib/media/audio");
let audioBufferToReturn: AudioBuffer | null = null;
const createTimelineAudioBufferCalls: unknown[] = [];
mock.module("@/lib/media/audio", () => ({
	...actualAudioModule,
	createTimelineAudioBuffer: async (args: unknown) => {
		createTimelineAudioBufferCalls.push(args);
		return audioBufferToReturn;
	},
}));

// ---- mock @/services/renderer/scene-builder -------------------------------
// No `AudioContext`/canvas involved in `buildScene` for these fixtures (audio
// elements are simply skipped by its node-building loop, and unresolvable
// mediaId lookups — `mediaAssets` is always `[]` here — are skipped too), so
// this wraps the REAL implementation purely for call-count instrumentation
// rather than faking it — `scene-builder.test.ts` and
// `video-cache/service.test.ts` also import this module directly and must
// keep getting the genuine behavior regardless of file run order.
const actualSceneBuilderModule = await import(
	"@/services/renderer/scene-builder"
);
const buildSceneCalls: unknown[] = [];
mock.module("@/services/renderer/scene-builder", () => ({
	...actualSceneBuilderModule,
	buildScene: (
		args: Parameters<typeof actualSceneBuilderModule.buildScene>[0],
	) => {
		buildSceneCalls.push(args);
		return actualSceneBuilderModule.buildScene(args);
	},
}));

// ---- mock @/services/renderer/scene-exporter -------------------------------
// Unlike the two modules above, nothing else in the test suite imports
// `scene-exporter.ts` directly, so a full replacement (no spread) is safe
// regardless of run order. Constructing the REAL `SceneExporter` would build
// a real `CanvasRenderer` (`OffscreenCanvas`/DOM canvas), unavailable under
// `bun test` — exactly the "don't fight mediabunny/canvas under bun test"
// case. This fake captures constructor args so tests can assert the
// `includeVideoTrack` decision `exportProject` wires through, without ever
// touching mediabunny or a real encode (the campaign's browser-verified e2e
// covers that).
type CapturedSceneExporterParams = {
	includeVideoTrack?: boolean;
	shouldIncludeAudio?: boolean;
	audioBuffer?: AudioBuffer;
};
const sceneExporterConstructorCalls: CapturedSceneExporterParams[] = [];
mock.module("@/services/renderer/scene-exporter", () => ({
	SceneExporter: class {
		constructor(params: CapturedSceneExporterParams) {
			sceneExporterConstructorCalls.push(params);
		}
		on() {
			return this;
		}
		cancel() {}
		async export() {
			return new ArrayBuffer(8);
		}
	},
}));

const { RendererManager, hasVisualContent } = await import(
	"@/core/managers/renderer-manager"
);

beforeEach(() => {
	audioBufferToReturn = null;
	createTimelineAudioBufferCalls.length = 0;
	buildSceneCalls.length = 0;
	sceneExporterConstructorCalls.length = 0;
});

// ---- fixtures ---------------------------------------------------------------

function makeAudioElement(
	overrides: Partial<import("@/types/timeline").UploadAudioElement> = {},
): AudioElement {
	return {
		id: "audio-el-1",
		name: "Voiceover",
		type: "audio",
		sourceType: "upload",
		mediaId: "asset-audio-1",
		volume: 1,
		duration: 5,
		startTime: 0,
		trimStart: 0,
		trimEnd: 0,
		...overrides,
	};
}

function makeAudioTrack(
	elements: AudioElement[],
	overrides: Partial<AudioTrack> = {},
): AudioTrack {
	return {
		id: "track-audio-1",
		name: "Audio",
		type: "audio",
		muted: false,
		elements,
		...overrides,
	};
}

function makeVideoElement(overrides: Partial<VideoElement> = {}): VideoElement {
	return {
		id: "video-el-1",
		name: "Clip",
		type: "video",
		mediaId: "asset-video-1",
		duration: 5,
		startTime: 0,
		trimStart: 0,
		trimEnd: 0,
		transform: DEFAULT_TRANSFORM,
		opacity: 1,
		...overrides,
	};
}

function makeVideoTrack(
	elements: VideoElement[],
	overrides: Partial<VideoTrack> = {},
): VideoTrack {
	return {
		id: "track-video-1",
		name: "Video",
		type: "video",
		isMain: true,
		muted: false,
		hidden: false,
		elements,
		...overrides,
	};
}

function makeTextElement(overrides: Partial<TextElement> = {}): TextElement {
	return {
		id: "text-el-1",
		name: "Caption",
		type: "text",
		content: "Hello",
		fontSize: 32,
		fontFamily: "Inter",
		color: "#ffffff",
		background: DEFAULT_TEXT_BACKGROUND,
		textAlign: "center",
		fontWeight: "normal",
		fontStyle: "normal",
		textDecoration: "none",
		transform: DEFAULT_TRANSFORM,
		opacity: 1,
		duration: 3,
		startTime: 0,
		trimStart: 0,
		trimEnd: 0,
		...overrides,
	};
}

function makeTextTrack(
	elements: TextElement[],
	overrides: Partial<TextTrack> = {},
): TextTrack {
	return {
		id: "track-text-1",
		name: "Text",
		type: "text",
		hidden: false,
		elements,
		...overrides,
	};
}

function makeStickerElement(
	overrides: Partial<StickerElement> = {},
): StickerElement {
	return {
		id: "sticker-el-1",
		name: "Sticker",
		type: "sticker",
		stickerId: "sticker-1",
		transform: DEFAULT_TRANSFORM,
		opacity: 1,
		duration: 3,
		startTime: 0,
		trimStart: 0,
		trimEnd: 0,
		...overrides,
	};
}

function makeStickerTrack(
	elements: StickerElement[],
	overrides: Partial<StickerTrack> = {},
): StickerTrack {
	return {
		id: "track-sticker-1",
		name: "Sticker",
		type: "sticker",
		hidden: false,
		elements,
		...overrides,
	};
}

function makeEffectElement(
	overrides: Partial<EffectElement> = {},
): EffectElement {
	return {
		id: "effect-el-1",
		name: "Vignette",
		type: "effect",
		effectType: "vignette",
		params: {},
		duration: 3,
		startTime: 0,
		trimStart: 0,
		trimEnd: 0,
		...overrides,
	};
}

function makeEffectTrack(
	elements: EffectElement[],
	overrides: Partial<EffectTrack> = {},
): EffectTrack {
	return {
		id: "track-effect-1",
		name: "Effect",
		type: "effect",
		hidden: false,
		elements,
		...overrides,
	};
}

function makeEditor({
	tracks,
	duration,
}: {
	tracks: TimelineTrack[];
	duration: number;
}): EditorCore {
	return {
		timeline: {
			getTracks: () => tracks,
			getTotalDuration: () => duration,
		},
		media: {
			getAssets: () => [],
		},
		project: {
			getActive: () => ({
				settings: {
					fps: 30,
					canvasSize: { width: 1920, height: 1080 },
					background: { type: "color", color: "#000000" },
				},
				metadata: { name: "Test Project" },
			}),
		},
	} as unknown as EditorCore;
}

// ---- (a) hasVisualContent -------------------------------------------------

describe("hasVisualContent", () => {
	test("false for an audio-only timeline", () => {
		const tracks = [makeAudioTrack([makeAudioElement()])];
		expect(hasVisualContent({ tracks })).toBe(false);
	});

	test("false for an empty timeline", () => {
		expect(hasVisualContent({ tracks: [] })).toBe(false);
	});

	test("false for a track with no elements", () => {
		const tracks = [makeVideoTrack([])];
		expect(hasVisualContent({ tracks })).toBe(false);
	});

	test("true when a video element is present", () => {
		const tracks = [makeVideoTrack([makeVideoElement()])];
		expect(hasVisualContent({ tracks })).toBe(true);
	});

	test("true when only a text element is present", () => {
		const tracks = [makeTextTrack([makeTextElement()])];
		expect(hasVisualContent({ tracks })).toBe(true);
	});

	test("true when only a sticker element is present", () => {
		const tracks = [makeStickerTrack([makeStickerElement()])];
		expect(hasVisualContent({ tracks })).toBe(true);
	});

	test("false for an effect-only track (effects recolor, don't paint)", () => {
		const tracks = [makeEffectTrack([makeEffectElement()])];
		expect(hasVisualContent({ tracks })).toBe(false);
	});

	test("false when the only visual element is hidden", () => {
		const tracks = [makeVideoTrack([makeVideoElement({ hidden: true })])];
		expect(hasVisualContent({ tracks })).toBe(false);
	});

	test("false when the only visual track is hidden", () => {
		const tracks = [makeVideoTrack([makeVideoElement()], { hidden: true })];
		expect(hasVisualContent({ tracks })).toBe(false);
	});

	test("true when a visible track has content alongside a hidden one", () => {
		const tracks = [
			makeVideoTrack([makeVideoElement()], { hidden: true }),
			makeTextTrack([makeTextElement()]),
		];
		expect(hasVisualContent({ tracks })).toBe(true);
	});

	test("true when mixed with an audio track (audio doesn't count, but doesn't hide the visual either)", () => {
		const tracks = [
			makeAudioTrack([makeAudioElement()]),
			makeVideoTrack([makeVideoElement()]),
		];
		expect(hasVisualContent({ tracks })).toBe(true);
	});
});

// ---- (b) exportProject fail-fast ------------------------------------------

describe("exportProject — nothing to export", () => {
	test("fails fast when audio-only project has includeAudio off", async () => {
		const tracks = [makeAudioTrack([makeAudioElement()])];
		const manager = new RendererManager(makeEditor({ tracks, duration: 5 }));

		const result = await manager.exportProject({
			options: { format: "mp4", quality: "medium", includeAudio: false },
		});

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/nothing to export/i);
		// Never got far enough to touch the scene/exporter.
		expect(buildSceneCalls.length).toBe(0);
		expect(sceneExporterConstructorCalls.length).toBe(0);
	});

	test("fails fast when includeAudio is on but there are no real audio elements", async () => {
		audioBufferToReturn = null; // createTimelineAudioBuffer's real "nothing to mix" contract
		const tracks = [makeAudioTrack([])];
		const manager = new RendererManager(makeEditor({ tracks, duration: 5 }));

		const result = await manager.exportProject({
			options: { format: "mp4", quality: "medium", includeAudio: true },
		});

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/nothing to export/i);
		expect(sceneExporterConstructorCalls.length).toBe(0);
	});

	test("fails fast for a GIF request on an audio-only project (GIF never carries audio)", async () => {
		const tracks = [makeAudioTrack([makeAudioElement()])];
		const manager = new RendererManager(makeEditor({ tracks, duration: 5 }));

		const result = await manager.exportProject({
			options: { format: "gif", quality: "medium", includeAudio: true },
		});

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/nothing to export/i);
	});
});

// ---- (c) the includeVideoTrack decision seam ------------------------------

describe("exportProject — includeVideoTrack wiring", () => {
	test("suppresses the video track for an audio-only export", async () => {
		audioBufferToReturn = { sampleRate: 48000 } as unknown as AudioBuffer;
		const tracks = [makeAudioTrack([makeAudioElement()])];
		const manager = new RendererManager(makeEditor({ tracks, duration: 5 }));

		const result = await manager.exportProject({
			options: { format: "mp4", quality: "medium", includeAudio: true },
		});

		expect(result.success).toBe(true);
		expect(sceneExporterConstructorCalls.length).toBe(1);
		expect(sceneExporterConstructorCalls[0].includeVideoTrack).toBe(false);
		expect(sceneExporterConstructorCalls[0].shouldIncludeAudio).toBe(true);
		expect(sceneExporterConstructorCalls[0].audioBuffer).toBeDefined();
	});

	test("keeps the video track when visual content is present, even with no audio", async () => {
		const tracks = [makeVideoTrack([makeVideoElement()])];
		const manager = new RendererManager(makeEditor({ tracks, duration: 5 }));

		const result = await manager.exportProject({
			options: { format: "mp4", quality: "medium", includeAudio: false },
		});

		expect(result.success).toBe(true);
		expect(sceneExporterConstructorCalls.length).toBe(1);
		expect(sceneExporterConstructorCalls[0].includeVideoTrack).toBe(true);
	});

	test("keeps the video track for a normal project with both visual and audio content", async () => {
		audioBufferToReturn = { sampleRate: 48000 } as unknown as AudioBuffer;
		const tracks = [
			makeVideoTrack([makeVideoElement()]),
			makeAudioTrack([makeAudioElement()]),
		];
		const manager = new RendererManager(makeEditor({ tracks, duration: 5 }));

		const result = await manager.exportProject({
			options: { format: "mp4", quality: "medium", includeAudio: true },
		});

		expect(result.success).toBe(true);
		expect(sceneExporterConstructorCalls[0].includeVideoTrack).toBe(true);
	});
});

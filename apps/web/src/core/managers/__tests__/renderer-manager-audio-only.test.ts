import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { EditorCore } from "@/core";
import type { AudioTrack, TimelineTrack, VideoTrack } from "@/types/timeline";

/**
 * Covers the "audioOnly" forced-video-drop path added for the "Podcast
 * (audio only)" export preset (see `constants/export-constants.ts` and
 * `types/export.ts#ExportOptions.audioOnly`).
 *
 * Before this, whether the video track was included in an export was decided
 * PURELY by `hasVisualContent` (BUG17) — there was no way for a caller to
 * force it off. `RendererManager.exportProject` now short-circuits that
 * inference to `false` whenever `options.audioOnly` is set, reusing the same
 * `includeVideoTrack` seam `SceneExporter` already had. This suite exercises
 * that new decision (and its interaction with the pre-existing "nothing to
 * export" fail-fast) directly.
 *
 * Sibling `audio-only-export.test.skip.ts` covers the original BUG17
 * (automatic, `hasVisualContent`-driven) behavior in the same style but is
 * quarantined under bun (BUG43: hangs at import — root cause undetermined,
 * tracked separately). This file avoids importing the REAL scene-builder /
 * media-audio modules (full mock replacement, no `await import` of the
 * actual implementations) specifically to sidestep whatever that import-time
 * hang is triggered by, so it's a fresh file rather than an addition to the
 * quarantined one.
 */

const createTimelineAudioBufferCalls: unknown[] = [];
let audioBufferToReturn: AudioBuffer | null = null;
mock.module("@/lib/media/audio", () => ({
	createTimelineAudioBuffer: async (args: unknown) => {
		createTimelineAudioBufferCalls.push(args);
		return audioBufferToReturn;
	},
}));

const buildSceneCalls: unknown[] = [];
mock.module("@/services/renderer/scene-builder", () => ({
	buildScene: (args: unknown) => {
		buildSceneCalls.push(args);
		return {} as unknown;
	},
}));

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

const { RendererManager } = await import("@/core/managers/renderer-manager");

beforeEach(() => {
	audioBufferToReturn = null;
	createTimelineAudioBufferCalls.length = 0;
	buildSceneCalls.length = 0;
	sceneExporterConstructorCalls.length = 0;
});

function makeVideoTrack(): VideoTrack {
	return {
		id: "track-video-1",
		name: "Video",
		type: "video",
		isMain: true,
		muted: false,
		hidden: false,
		elements: [
			{
				id: "video-el-1",
				name: "Clip",
				type: "video",
				mediaId: "asset-video-1",
				duration: 5,
				startTime: 0,
				trimStart: 0,
				trimEnd: 0,
				transform: { x: 0, y: 0, scale: 1, rotation: 0 },
				opacity: 1,
			},
		],
	} as unknown as VideoTrack;
}

function makeAudioTrack(): AudioTrack {
	return {
		id: "track-audio-1",
		name: "Audio",
		type: "audio",
		muted: false,
		elements: [
			{
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
			},
		],
	} as unknown as AudioTrack;
}

function makeEditor({ tracks }: { tracks: TimelineTrack[] }): EditorCore {
	return {
		timeline: {
			getTracks: () => tracks,
			getTotalDuration: () => 5,
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

describe("exportProject — audioOnly forces the video track off", () => {
	test("drops the video track even though the project has visual content", async () => {
		audioBufferToReturn = { sampleRate: 48000 } as unknown as AudioBuffer;
		const tracks = [makeVideoTrack(), makeAudioTrack()];
		const manager = new RendererManager(makeEditor({ tracks }));

		const result = await manager.exportProject({
			options: {
				format: "mp4",
				quality: "medium",
				includeAudio: true,
				audioOnly: true,
			},
		});

		expect(result.success).toBe(true);
		expect(sceneExporterConstructorCalls.length).toBe(1);
		// The whole point: visual content is present (a video element on a
		// visible track), so `hasVisualContent` alone would have said `true` —
		// `audioOnly` must override that.
		expect(sceneExporterConstructorCalls[0].includeVideoTrack).toBe(false);
		expect(sceneExporterConstructorCalls[0].shouldIncludeAudio).toBe(true);
	});

	test("fails fast when audioOnly is requested but there is no audio at all, even with visual content present", async () => {
		audioBufferToReturn = null; // no real audio elements to mix
		const tracks = [makeVideoTrack()];
		const manager = new RendererManager(makeEditor({ tracks }));

		const result = await manager.exportProject({
			options: {
				format: "mp4",
				quality: "medium",
				includeAudio: true,
				audioOnly: true,
			},
		});

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/nothing to export/i);
		expect(result.error).toMatch(/audio-only export needs an audio track/i);
		// Never got far enough to touch the scene/exporter.
		expect(buildSceneCalls.length).toBe(0);
		expect(sceneExporterConstructorCalls.length).toBe(0);
	});

	test("still exports audio-only for a project with no visual content at all (BUG17 path, unaffected)", async () => {
		audioBufferToReturn = { sampleRate: 48000 } as unknown as AudioBuffer;
		const tracks = [makeAudioTrack()];
		const manager = new RendererManager(makeEditor({ tracks }));

		const result = await manager.exportProject({
			options: {
				format: "mp4",
				quality: "medium",
				includeAudio: true,
				audioOnly: true,
			},
		});

		expect(result.success).toBe(true);
		expect(sceneExporterConstructorCalls[0].includeVideoTrack).toBe(false);
	});

	test("leaves the video track alone when audioOnly is not set (regression baseline)", async () => {
		const tracks = [makeVideoTrack()];
		const manager = new RendererManager(makeEditor({ tracks }));

		const result = await manager.exportProject({
			options: { format: "mp4", quality: "medium", includeAudio: false },
		});

		expect(result.success).toBe(true);
		expect(sceneExporterConstructorCalls[0].includeVideoTrack).toBe(true);
	});
});

import { describe, expect, mock, test } from "bun:test";
import { DEFAULT_TRANSFORM } from "@/constants/timeline-constants";
import type { EditorCore } from "@/core";
import type { TimelineTrack } from "@/types/timeline";

/**
 * Covers `ExportOptions.audioOnly` — added to fix the "Podcast (Audio Only)"
 * batch-export preset (`lib/export-presets.ts`), which used to produce a
 * perfectly ordinary silent video because nothing forced the video track
 * off. `RendererManager.exportProject`'s existing BUG17 machinery only drops
 * the video track when it AUTO-DETECTS an audio-only timeline
 * (`hasVisualContent` returns false); `audioOnly: true` forces that same
 * `includeVideoTrack: false` outcome even when the timeline has real visual
 * content, because the caller explicitly asked for audio-only output.
 *
 * Deliberately narrower than the quarantined
 * `services/renderer/audio-only-export.test.skip.ts` (BUG43: hangs at import
 * under bun when scene-builder AND scene-exporter AND the audio module are
 * all `mock.module`-wrapped together in one file). This file only mocks
 * `@/lib/media/audio` and `@/services/renderer/scene-exporter` — letting the
 * real `buildScene` run (it doesn't touch canvas/AudioContext for these
 * fixtures) — which does not reproduce that hang.
 */

mock.module("@/lib/media/audio", () => ({
	createTimelineAudioBuffer: async () =>
		({ sampleRate: 48000 }) as unknown as AudioBuffer,
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

function makeVideoTracks(): TimelineTrack[] {
	return [
		{
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
					transform: DEFAULT_TRANSFORM,
					opacity: 1,
				},
			],
		},
	] as unknown as TimelineTrack[];
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

describe("RendererManager.exportProject — audioOnly option", () => {
	test("forces includeVideoTrack:false even when the timeline has visual content", async () => {
		sceneExporterConstructorCalls.length = 0;
		const tracks = makeVideoTracks();
		const manager = new RendererManager(makeEditor({ tracks, duration: 5 }));

		const result = await manager.exportProject({
			options: {
				format: "mp4",
				quality: "high",
				includeAudio: true,
				audioOnly: true,
			},
		});

		expect(result.success).toBe(true);
		expect(sceneExporterConstructorCalls.length).toBe(1);
		expect(sceneExporterConstructorCalls[0].includeVideoTrack).toBe(false);
		expect(sceneExporterConstructorCalls[0].shouldIncludeAudio).toBe(true);
		expect(sceneExporterConstructorCalls[0].audioBuffer).toBeDefined();
	});

	test("keeps the video track when audioOnly is not set, even with the same timeline", async () => {
		sceneExporterConstructorCalls.length = 0;
		const tracks = makeVideoTracks();
		const manager = new RendererManager(makeEditor({ tracks, duration: 5 }));

		const result = await manager.exportProject({
			options: { format: "mp4", quality: "high", includeAudio: true },
		});

		expect(result.success).toBe(true);
		expect(sceneExporterConstructorCalls[0].includeVideoTrack).toBe(true);
	});

	test("audioOnly with no audio content still fails fast (nothing to export)", async () => {
		sceneExporterConstructorCalls.length = 0;
		const tracks = makeVideoTracks();
		const manager = new RendererManager(makeEditor({ tracks, duration: 5 }));

		const result = await manager.exportProject({
			options: {
				format: "mp4",
				quality: "high",
				includeAudio: false,
				audioOnly: true,
			},
		});

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/nothing to export/i);
		expect(sceneExporterConstructorCalls.length).toBe(0);
	});
});

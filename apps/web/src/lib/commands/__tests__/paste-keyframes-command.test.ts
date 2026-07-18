import { afterEach, describe, expect, mock, test } from "bun:test";
import { DEFAULT_TRANSFORM } from "@/constants/timeline-constants";
import type { EditorCore } from "@/core";
import type { KeyframeClipboardItem, KeyframeEasing } from "@/types/animation";
import type { TimelineTrack, VideoElement } from "@/types/timeline";

/**
 * Order-dependence guard: `EditorCore` (from "@/core") and
 * `PasteKeyframesCommand` (from
 * "@/lib/commands/timeline/element/keyframes/paste-keyframes") both
 * transitively import `@/core/managers/media-manager`, which statically
 * imports the real `@/services/proxy` barrel (chaining into
 * proxy-encoder-controller.ts -> proxy-generator.ts). Plain static imports
 * here would cache the real chain in bun test's shared module registry
 * before proxy-encoder-controller.test.ts's own `mock.module()` can take
 * effect, if that file runs later in the same `bun test` invocation. Mock
 * the barrel and import dynamically, AFTER the mock (mirrors
 * media-manager-decode-reprobe.test.ts's barrel mock + "Import AFTER the
 * mocks" convention). Proxy generation itself is never exercised here.
 */
mock.module("@/services/proxy", () => ({
	generateProxyOffThread: async () => ({
		file: new File([new Uint8Array([1])], "proxy.mp4", { type: "video/mp4" }),
		width: 1280,
		height: 720,
	}),
	isProxyCancelledError: (error: unknown) =>
		error instanceof Error &&
		(error.message === "Proxy generation cancelled" ||
			error.name === "AbortError"),
}));

const { EditorCore: EditorCoreClass } = await import("@/core");
const { PasteKeyframesCommand } = await import(
	"@/lib/commands/timeline/element/keyframes/paste-keyframes"
);

type MockEditor = {
	timeline: {
		getTracks: () => TimelineTrack[];
		updateTracks: (tracks: TimelineTrack[]) => void;
	};
};

const originalGetInstance = EditorCoreClass.getInstance;

function mockEditorCore({ editor }: { editor: MockEditor }): void {
	(
		EditorCoreClass as unknown as {
			getInstance: () => EditorCore;
		}
	).getInstance = () => editor as unknown as EditorCore;
}

function restoreEditorCore(): void {
	(
		EditorCoreClass as unknown as {
			getInstance: typeof EditorCoreClass.getInstance;
		}
	).getInstance = originalGetInstance;
}

const EASE_OUT: KeyframeEasing = {
	preset: "ease-out",
	bezier: [0, 0, 0.58, 1],
};

function buildVideoElement(): VideoElement {
	return {
		id: "element-1",
		name: "Clip",
		type: "video",
		mediaId: "media-1",
		duration: 10,
		startTime: 1,
		trimStart: 0,
		trimEnd: 0,
		transform: DEFAULT_TRANSFORM,
		opacity: 1,
	};
}

function buildTracks({ element }: { element: VideoElement }): TimelineTrack[] {
	return [
		{
			id: "track-1",
			name: "Main",
			type: "video",
			elements: [element],
			isMain: true,
			muted: false,
			hidden: false,
		},
	];
}

const clipboardItems: KeyframeClipboardItem[] = [
	{
		propertyPath: "transform.scale",
		timeOffset: 0,
		value: 1,
		interpolation: "linear",
		easing: EASE_OUT,
	},
	{
		propertyPath: "transform.scale",
		timeOffset: 2,
		value: 2,
		interpolation: "hold",
	},
];

describe("PasteKeyframesCommand", () => {
	afterEach(() => {
		restoreEditorCore();
	});

	test("pastes keyframes at the rebased time with easing preserved", () => {
		const tracks = buildTracks({ element: buildVideoElement() });
		let updatedTracks: TimelineTrack[] = tracks;
		mockEditorCore({
			editor: {
				timeline: {
					getTracks: () => tracks,
					updateTracks: (nextTracks) => {
						updatedTracks = nextTracks;
					},
				},
			},
		});

		new PasteKeyframesCommand({
			trackId: "track-1",
			elementId: "element-1",
			time: 3,
			clipboardItems,
		}).execute();

		const keyframes =
			(updatedTracks[0].elements[0] as VideoElement).animations?.channels[
				"transform.scale"
			]?.keyframes ?? [];
		expect(keyframes.map((keyframe) => keyframe.time)).toEqual([3, 5]);
		const eased = keyframes.find((keyframe) => keyframe.time === 3);
		expect(eased?.easing).toEqual(EASE_OUT);
		expect(
			keyframes.find((keyframe) => keyframe.time === 5)?.interpolation,
		).toBe("hold");
	});

	test("undo restores the pre-paste tracks", () => {
		const tracks = buildTracks({ element: buildVideoElement() });
		let updatedTracks: TimelineTrack[] = tracks;
		mockEditorCore({
			editor: {
				timeline: {
					getTracks: () => tracks,
					updateTracks: (nextTracks) => {
						updatedTracks = nextTracks;
					},
				},
			},
		});

		const command = new PasteKeyframesCommand({
			trackId: "track-1",
			elementId: "element-1",
			time: 3,
			clipboardItems,
		});
		command.execute();
		expect(
			(updatedTracks[0].elements[0] as VideoElement).animations,
		).toBeDefined();

		command.undo();
		expect(updatedTracks).toBe(tracks);
		expect(
			(updatedTracks[0].elements[0] as VideoElement).animations,
		).toBeUndefined();
	});

	test("empty clipboard is a no-op (no updateTracks call)", () => {
		const tracks = buildTracks({ element: buildVideoElement() });
		let updateCalls = 0;
		mockEditorCore({
			editor: {
				timeline: {
					getTracks: () => tracks,
					updateTracks: () => {
						updateCalls += 1;
					},
				},
			},
		});

		new PasteKeyframesCommand({
			trackId: "track-1",
			elementId: "element-1",
			time: 3,
			clipboardItems: [],
		}).execute();

		expect(updateCalls).toBe(0);
	});
});

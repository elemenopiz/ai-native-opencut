import { afterEach, describe, expect, mock, test } from "bun:test";
import type { EditorCore } from "@/core";
import type {
	CreateTimelineElement,
	TimelineTrack,
	VideoElement,
} from "@/types/timeline";
import {
	DEFAULT_BLEND_MODE,
	DEFAULT_OPACITY,
	DEFAULT_TRANSFORM,
} from "@/constants/timeline-constants";

// The public insert API (unlike the UI's buildElementFromMedia) can hand the
// command a visual element with no transform/opacity/blendMode. A malformed
// element persisted that way used to crash every render and project load.
// These tests pin the normalize-at-insert seam.

/**
 * Order-dependence guard: `EditorCore` (from "@/core") and
 * `InsertElementCommand` (from "@/lib/commands/timeline/element/insert-element")
 * both transitively import `@/core/managers/media-manager`, which statically
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
const { InsertElementCommand } = await import(
	"@/lib/commands/timeline/element/insert-element"
);

const originalGetInstance = EditorCoreClass.getInstance;

type MockEditor = {
	timeline: {
		getTracks: () => TimelineTrack[];
		updateTracks: (tracks: TimelineTrack[]) => void;
	};
	media: { getAssets: () => never[] };
	project: {
		getActive: () => undefined;
		updateSettings: () => void;
	};
};

function mockEditorCore({ editor }: { editor: MockEditor }): void {
	(
		EditorCoreClass as unknown as { getInstance: () => EditorCore }
	).getInstance = () => editor as unknown as EditorCore;
}

function restoreEditorCore(): void {
	(
		EditorCoreClass as unknown as {
			getInstance: typeof EditorCoreClass.getInstance;
		}
	).getInstance = originalGetInstance;
}

afterEach(() => {
	restoreEditorCore();
});

function buildVideoTrack({ id }: { id: string }): TimelineTrack {
	return {
		id,
		name: id,
		type: "video",
		elements: [],
		isMain: false,
		muted: false,
		hidden: false,
	};
}

function runInsert({
	element,
	placement = { mode: "explicit", trackId: "video-1" },
}: {
	element: CreateTimelineElement;
	placement?: ConstructorParameters<
		typeof InsertElementCommand
	>[0]["placement"];
}): TimelineTrack[] {
	let committedTracks: TimelineTrack[] = [];
	mockEditorCore({
		editor: {
			timeline: {
				getTracks: () => [buildVideoTrack({ id: "video-1" })],
				updateTracks: (tracks) => {
					committedTracks = tracks;
				},
			},
			media: { getAssets: () => [] },
			project: {
				getActive: () => undefined,
				updateSettings: () => {},
			},
		},
	});

	const command = new InsertElementCommand({
		element,
		placement,
	});
	command.execute();
	return committedTracks;
}

describe("InsertElementCommand visual defaults", () => {
	test("a transform-less video element persists with default transform/opacity/blendMode", () => {
		const tracks = runInsert({
			element: {
				type: "video",
				name: "Clip",
				mediaId: "media-1",
				startTime: 0,
				duration: 2,
				trimStart: 0,
				trimEnd: 0,
			} as unknown as CreateTimelineElement,
		});

		const inserted = tracks[0]?.elements[0] as VideoElement;
		expect(inserted).toBeDefined();
		expect(inserted.transform).toEqual(DEFAULT_TRANSFORM);
		expect(inserted.opacity).toBe(DEFAULT_OPACITY);
		expect(inserted.blendMode).toBe(DEFAULT_BLEND_MODE);
	});

	test("a partial transform is healed field-by-field, keeping provided values", () => {
		const tracks = runInsert({
			element: {
				type: "image",
				name: "Still",
				mediaId: "media-2",
				startTime: 0,
				duration: 2,
				trimStart: 0,
				trimEnd: 0,
				transform: { scale: 2 },
			} as unknown as CreateTimelineElement,
		});

		const inserted = tracks[0]?.elements[0] as VideoElement;
		expect(inserted.transform).toEqual({
			position: { x: 0, y: 0 },
			scale: 2,
			rotate: 0,
		});
		expect(inserted.opacity).toBe(DEFAULT_OPACITY);
	});

	test("a complete element's transform/opacity/blendMode pass through untouched", () => {
		const transform = {
			position: { x: 10, y: -5 },
			scale: 0.5,
			rotate: 90,
		};
		const tracks = runInsert({
			element: {
				type: "video",
				name: "Clip",
				mediaId: "media-3",
				startTime: 0,
				duration: 2,
				trimStart: 0,
				trimEnd: 0,
				transform,
				opacity: 0.25,
				blendMode: "multiply",
			} as unknown as CreateTimelineElement,
		});

		const inserted = tracks[0]?.elements[0] as VideoElement;
		expect(inserted.transform).toEqual(transform);
		expect(inserted.opacity).toBe(0.25);
		expect(inserted.blendMode).toBe("multiply");
	});

	test("non-visual elements are not given visual defaults", () => {
		const tracks = runInsert({
			element: {
				type: "effect",
				name: "FX",
				effectType: "blur",
				params: {},
				startTime: 0,
				duration: 2,
				trimStart: 0,
				trimEnd: 0,
			} as unknown as CreateTimelineElement,
			placement: { mode: "auto" },
		});

		const effectTrack = tracks.find((track) => track.type === "effect");
		const inserted = effectTrack?.elements[0];
		expect(inserted).toBeDefined();
		expect(inserted && "transform" in inserted).toBe(false);
		expect(inserted && "opacity" in inserted).toBe(false);
	});
});

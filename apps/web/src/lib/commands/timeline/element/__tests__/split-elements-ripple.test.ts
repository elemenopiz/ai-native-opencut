import { afterEach, describe, expect, mock, test } from "bun:test";
import type { EditorCore } from "@/core";
import type { TimelineTrack, VideoElement } from "@/types/timeline";
import { DEFAULT_TRANSFORM } from "@/constants/timeline-constants";

/**
 * Order-dependence guard: `EditorCore` (from "@/core") and
 * `SplitElementsCommand` (from "@/lib/commands/timeline/element/split-elements")
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
const { SplitElementsCommand } = await import(
	"@/lib/commands/timeline/element/split-elements"
);

type MockEditor = {
	timeline: {
		getTracks: () => TimelineTrack[];
		updateTracks: (tracks: TimelineTrack[]) => void;
	};
	selection: {
		getSelectedElements: () => { trackId: string; elementId: string }[];
		setSelectedElements: ({
			elements,
		}: {
			elements: { trackId: string; elementId: string }[];
		}) => void;
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

function buildVideoElement({
	id,
	startTime,
	duration,
}: {
	id: string;
	startTime: number;
	duration: number;
}): VideoElement {
	return {
		id,
		name: `Clip ${id}`,
		type: "video",
		mediaId: `media-${id}`,
		duration,
		startTime,
		trimStart: 0,
		trimEnd: 0,
		transform: DEFAULT_TRANSFORM,
		opacity: 1,
	};
}

function buildTracks(): TimelineTrack[] {
	return [
		{
			id: "track-1",
			name: "Main",
			type: "video",
			elements: [
				buildVideoElement({ id: "element-1", startTime: 0, duration: 4 }),
				buildVideoElement({ id: "element-2", startTime: 5, duration: 3 }),
			],
			isMain: true,
			muted: false,
			hidden: false,
		},
	];
}

function runSplit({
	rippleEnabled,
	retainSide,
}: {
	rippleEnabled: boolean;
	retainSide: "both" | "left" | "right";
}): TimelineTrack[] {
	const tracks = buildTracks();
	let updatedTracks: TimelineTrack[] = tracks;
	mockEditorCore({
		editor: {
			timeline: {
				getTracks: () => tracks,
				updateTracks: (nextTracks) => {
					updatedTracks = nextTracks;
				},
			},
			selection: {
				getSelectedElements: () => [],
				setSelectedElements: () => {},
			},
		},
	});

	new SplitElementsCommand({
		elements: [{ trackId: "track-1", elementId: "element-1" }],
		splitTime: 2,
		retainSide,
		rippleEnabled,
	}).execute();

	return updatedTracks;
}

afterEach(() => {
	restoreEditorCore();
});

describe("SplitElementsCommand ripple", () => {
	test("retainSide 'left' with ripple shifts following elements left by the discarded right duration", () => {
		const updatedTracks = runSplit({ rippleEnabled: true, retainSide: "left" });

		const [retained, follower] = updatedTracks[0].elements;
		expect(retained.startTime).toBe(0);
		expect(retained.duration).toBe(2);
		// Discarded right portion was [2, 4] => 2s; follower moves 5 -> 3.
		expect(follower.startTime).toBe(3);
	});

	test("retainSide 'left' without ripple leaves following elements unchanged", () => {
		const updatedTracks = runSplit({
			rippleEnabled: false,
			retainSide: "left",
		});

		const [retained, follower] = updatedTracks[0].elements;
		expect(retained.startTime).toBe(0);
		expect(retained.duration).toBe(2);
		expect(follower.startTime).toBe(5);
	});

	test("retainSide 'right' with ripple still shifts elements left by the discarded left duration", () => {
		const updatedTracks = runSplit({
			rippleEnabled: true,
			retainSide: "right",
		});

		const [retained, follower] = updatedTracks[0].elements;
		// Discarded left portion was [0, 2] => 2s; retained right moves 2 -> 0.
		expect(retained.startTime).toBe(0);
		expect(retained.duration).toBe(2);
		expect(follower.startTime).toBe(3);
	});
});

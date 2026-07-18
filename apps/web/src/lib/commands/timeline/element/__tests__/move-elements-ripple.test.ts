import { afterEach, describe, expect, mock, test } from "bun:test";
import type { EditorCore } from "@/core";
import type { TimelineTrack, VideoElement } from "@/types/timeline";
import { DEFAULT_TRANSFORM } from "@/constants/timeline-constants";

/**
 * Order-dependence guard: `EditorCore` (from "@/core") and
 * `MoveElementCommand` (from "@/lib/commands/timeline/element/move-elements")
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
const { MoveElementCommand } = await import(
	"@/lib/commands/timeline/element/move-elements"
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

// four clips laid end-to-end: a[0,2) b[2,4) c[4,6) d[6,8)
function buildTracks(): TimelineTrack[] {
	return [
		{
			id: "track-1",
			name: "Video",
			type: "video",
			elements: [
				buildVideoElement({ id: "a", startTime: 0, duration: 2 }),
				buildVideoElement({ id: "b", startTime: 2, duration: 2 }),
				buildVideoElement({ id: "c", startTime: 4, duration: 2 }),
				buildVideoElement({ id: "d", startTime: 6, duration: 2 }),
			],
			isMain: false,
			muted: false,
			hidden: false,
		},
	];
}

function runMove({
	tracks,
	elementId,
	newStartTime,
}: {
	tracks: TimelineTrack[];
	elementId: string;
	newStartTime: number;
}): TimelineTrack[] {
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

	new MoveElementCommand({
		sourceTrackId: "track-1",
		targetTrackId: "track-1",
		elementId,
		newStartTime,
		rippleEnabled: true,
	}).execute();

	return updatedTracks;
}

function sortedByStart(track: TimelineTrack): VideoElement[] {
	return [...track.elements].sort(
		(left, right) => left.startTime - right.startTime,
	) as VideoElement[];
}

function expectContiguous(elements: VideoElement[]): void {
	let expectedStart = 0;
	for (const element of elements) {
		expect(element.startTime).toBe(expectedStart);
		expectedStart += element.duration;
	}
}

afterEach(() => {
	restoreEditorCore();
});

describe("same-track move with ripple enabled (reorder: close + push)", () => {
	test("drag right: moving the first clip later reorders without gaps or overlaps", () => {
		const updatedTracks = runMove({
			tracks: buildTracks(),
			elementId: "a",
			newStartTime: 4,
		});

		const elements = sortedByStart(updatedTracks[0]);
		expect(elements.map((element) => element.id)).toEqual(["b", "c", "a", "d"]);
		expect(elements.map((element) => element.startTime)).toEqual([0, 2, 4, 6]);
		expectContiguous(elements);
	});

	test("drag left: moving the last clip earlier reorders without gaps or overlaps", () => {
		const updatedTracks = runMove({
			tracks: buildTracks(),
			elementId: "d",
			newStartTime: 2,
		});

		const elements = sortedByStart(updatedTracks[0]);
		expect(elements.map((element) => element.id)).toEqual(["a", "d", "b", "c"]);
		expect(elements.map((element) => element.startTime)).toEqual([0, 2, 4, 6]);
		expectContiguous(elements);
	});

	test("ripple disabled keeps neighbors untouched", () => {
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

		new MoveElementCommand({
			sourceTrackId: "track-1",
			targetTrackId: "track-1",
			elementId: "a",
			newStartTime: 9,
			rippleEnabled: false,
		}).execute();

		const byId = new Map(
			updatedTracks[0].elements.map((element) => [element.id, element]),
		);
		expect(byId.get("a")?.startTime).toBe(9);
		expect(byId.get("b")?.startTime).toBe(2);
		expect(byId.get("c")?.startTime).toBe(4);
		expect(byId.get("d")?.startTime).toBe(6);
	});
});

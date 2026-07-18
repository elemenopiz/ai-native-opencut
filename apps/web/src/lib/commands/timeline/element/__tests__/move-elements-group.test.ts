import { afterEach, describe, expect, mock, test } from "bun:test";
import type { EditorCore } from "@/core";
import type { TimelineTrack, VideoElement } from "@/types/timeline";
import { DEFAULT_TRANSFORM } from "@/constants/timeline-constants";
import {
	buildMoveGroup,
	resolveGroupMove,
	snapGroupEdges,
	applyGroupMoveResult,
} from "@/lib/timeline/group-move";

/**
 * Order-dependence guard: `EditorCore` (from "@/core") and
 * `MoveElementsCommand` (from "@/lib/commands/timeline/element/move-elements-group")
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
const { MoveElementsCommand } = await import(
	"@/lib/commands/timeline/element/move-elements-group"
);

type MockEditor = {
	timeline: {
		getTracks: () => TimelineTrack[];
		updateTracks: (tracks: TimelineTrack[]) => void;
	};
	selection: {
		getSelectedElements: () => { trackId: string; elementId: string }[];
		setSelectedElements: (params: {
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

afterEach(() => {
	restoreEditorCore();
});

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

function buildVideoTrack({
	id,
	elements,
	isMain = false,
}: {
	id: string;
	elements: VideoElement[];
	isMain?: boolean;
}): TimelineTrack {
	return {
		id,
		name: id,
		type: "video",
		elements,
		isMain,
		muted: false,
		hidden: false,
	};
}

// Three video tracks (all mutually compatible): A is empty, B holds the
// anchor "a", C holds "b" — synced to start at the same time as "a" (a
// same-time, different-track pairing, e.g. two overlay layers).
function buildCrossTrackFixture(): TimelineTrack[] {
	return [
		buildVideoTrack({ id: "video-A", elements: [] }),
		buildVideoTrack({
			id: "video-B",
			elements: [buildVideoElement({ id: "a", startTime: 3, duration: 2 })],
		}),
		buildVideoTrack({
			id: "video-C",
			elements: [buildVideoElement({ id: "b", startTime: 3, duration: 2 })],
		}),
	];
}

describe("buildMoveGroup", () => {
	test("includes the anchor plus every selected element, deduped, each with its time offset from the anchor", () => {
		const tracks = buildCrossTrackFixture();
		const group = buildMoveGroup({
			anchorRef: { trackId: "video-B", elementId: "a" },
			selectedElements: [
				{ trackId: "video-B", elementId: "a" },
				{ trackId: "video-C", elementId: "b" },
			],
			tracks,
		});

		expect(group).not.toBeNull();
		expect(group?.anchor.elementId).toBe("a");
		expect(group?.members).toHaveLength(2);
		const b = group?.members.find((member) => member.elementId === "b");
		expect(b?.timeOffset).toBe(0); // b starts at the same time as the anchor
	});

	test("returns null when the anchor itself can't be found", () => {
		const tracks = buildCrossTrackFixture();
		const group = buildMoveGroup({
			anchorRef: { trackId: "video-B", elementId: "missing" },
			selectedElements: [],
			tracks,
		});
		expect(group).toBeNull();
	});
});

describe("resolveGroupMove: cross-track group move", () => {
	test("dragging the anchor to a different track shifts every member by the same track-index delta", () => {
		const tracks = buildCrossTrackFixture();
		const group = buildMoveGroup({
			anchorRef: { trackId: "video-B", elementId: "a" },
			selectedElements: [
				{ trackId: "video-B", elementId: "a" },
				{ trackId: "video-C", elementId: "b" },
			],
			tracks,
		});
		expect(group).not.toBeNull();
		if (!group) return;

		// Anchor "a" drags from video-B (index 1) to video-A (index 0): delta -1.
		// "b" (video-C, index 2) should land on video-B (index 1).
		const result = resolveGroupMove({
			group,
			tracks,
			anchorStartTime: 6,
			target: { kind: "existingTrack", targetTrackId: "video-A" },
		});

		expect(result).not.toBeNull();
		if (!result) return;

		const moveA = result.moves.find((move) => move.elementId === "a");
		const moveB = result.moves.find((move) => move.elementId === "b");
		expect(moveA?.targetTrackId).toBe("video-A");
		expect(moveA?.newStartTime).toBe(6);
		expect(moveB?.targetTrackId).toBe("video-B");
		expect(moveB?.newStartTime).toBe(6); // preserved 0 time offset from anchor
		expect(result.createTracks).toHaveLength(0);
	});

	test("applying the resolved plan vacates the now-empty non-main source track and lands both members correctly", () => {
		const tracks = buildCrossTrackFixture();
		const group = buildMoveGroup({
			anchorRef: { trackId: "video-B", elementId: "a" },
			selectedElements: [
				{ trackId: "video-B", elementId: "a" },
				{ trackId: "video-C", elementId: "b" },
			],
			tracks,
		});
		if (!group) throw new Error("expected group");

		const result = resolveGroupMove({
			group,
			tracks,
			anchorStartTime: 6,
			target: { kind: "existingTrack", targetTrackId: "video-A" },
		});
		if (!result) throw new Error("expected result");

		const updatedTracks = applyGroupMoveResult({ tracks, result });

		const trackIds = updatedTracks.map((track) => track.id);
		expect(trackIds).toEqual(["video-A", "video-B"]); // video-C emptied out and dropped

		const trackA = updatedTracks.find((track) => track.id === "video-A");
		const trackB = updatedTracks.find((track) => track.id === "video-B");
		expect(trackA?.elements.map((el) => el.id)).toEqual(["a"]);
		expect(trackA?.elements[0].startTime).toBe(6);
		expect(trackB?.elements.map((el) => el.id)).toEqual(["b"]);
		expect(trackB?.elements[0].startTime).toBe(6);
	});

	test("rejects (returns null) a cross-track move whose target track index is out of bounds", () => {
		const tracks = buildCrossTrackFixture();
		const group = buildMoveGroup({
			anchorRef: { trackId: "video-B", elementId: "a" },
			selectedElements: [
				{ trackId: "video-B", elementId: "a" },
				{ trackId: "video-C", elementId: "b" },
			],
			tracks,
		});
		if (!group) throw new Error("expected group");

		// Dragging the anchor DOWN (video-B index1 -> video-C index2, delta +1)
		// would push "b" (index2 + 1 = 3) off the end of the tracks array.
		const result = resolveGroupMove({
			group,
			tracks,
			anchorStartTime: 6,
			target: { kind: "existingTrack", targetTrackId: "video-C" },
		});

		expect(result).toBeNull();
	});

	test("rejects (returns null) when a member would overlap a stationary element on its target track", () => {
		const tracks = [
			buildVideoTrack({ id: "video-A", elements: [] }),
			buildVideoTrack({
				id: "video-B",
				elements: [buildVideoElement({ id: "a", startTime: 3, duration: 2 })],
			}),
			buildVideoTrack({
				id: "video-C",
				elements: [buildVideoElement({ id: "b", startTime: 3, duration: 2 })],
			}),
		];
		// Blocker sits on video-B exactly where "b" would land (startTime 6..8).
		const trackB = tracks.find((t) => t.id === "video-B");
		if (trackB && trackB.type === "video") {
			trackB.elements.push(
				buildVideoElement({ id: "blocker", startTime: 6, duration: 2 }),
			);
		}

		const group = buildMoveGroup({
			anchorRef: { trackId: "video-B", elementId: "a" },
			selectedElements: [
				{ trackId: "video-B", elementId: "a" },
				{ trackId: "video-C", elementId: "b" },
			],
			tracks,
		});
		if (!group) throw new Error("expected group");

		const result = resolveGroupMove({
			group,
			tracks,
			anchorStartTime: 6,
			target: { kind: "existingTrack", targetTrackId: "video-A" },
		});

		// "b" would land on video-B at [6, 8), which overlaps "blocker" [6, 8).
		expect(result).toBeNull();
	});
});

describe("resolveGroupMove: new-track drop", () => {
	test("creates one new track per member, in original relative order, at the requested insertion block", () => {
		const tracks = buildCrossTrackFixture();
		const group = buildMoveGroup({
			anchorRef: { trackId: "video-B", elementId: "a" },
			selectedElements: [
				{ trackId: "video-B", elementId: "a" },
				{ trackId: "video-C", elementId: "b" },
			],
			tracks,
		});
		if (!group) throw new Error("expected group");

		const result = resolveGroupMove({
			group,
			tracks,
			anchorStartTime: 10,
			target: { kind: "newTracks", insertIndex: 0 },
		});

		expect(result).not.toBeNull();
		if (!result) return;
		expect(result.createTracks).toHaveLength(2);
		// anchor "a" is first in display order (its own trackIndex 1 < b's 2),
		// so its new track is the first of the contiguous block.
		const sortedCreations = [...result.createTracks].sort(
			(x, y) => x.index - y.index,
		);
		expect(sortedCreations[0].type).toBe("video");
		expect(sortedCreations[1].type).toBe("video");
		expect(sortedCreations[1].index).toBe(sortedCreations[0].index + 1);

		const moveA = result.moves.find((move) => move.elementId === "a");
		const moveB = result.moves.find((move) => move.elementId === "b");
		expect(moveA?.newStartTime).toBe(10);
		expect(moveB?.newStartTime).toBe(10); // 0 time offset preserved
		expect(moveA?.targetTrackId).not.toBe(moveB?.targetTrackId);
	});
});

describe("snapGroupEdges", () => {
	test("snaps the anchor start time so a member's edge aligns to another element's edge, excluding the group's own members", () => {
		const tracks: TimelineTrack[] = [
			buildVideoTrack({
				id: "video-A",
				elements: [
					buildVideoElement({ id: "a", startTime: 3, duration: 2 }),
					// stationary clip whose start (10) is very close to where
					// "b"'s end would land if the anchor moves to ~7.9
					buildVideoElement({ id: "stationary", startTime: 10, duration: 5 }),
				],
			}),
			buildVideoTrack({
				id: "video-B",
				elements: [buildVideoElement({ id: "b", startTime: 3, duration: 2 })],
			}),
		];

		const group = buildMoveGroup({
			anchorRef: { trackId: "video-A", elementId: "a" },
			selectedElements: [
				{ trackId: "video-A", elementId: "a" },
				{ trackId: "video-B", elementId: "b" },
			],
			tracks,
		});
		if (!group) throw new Error("expected group");

		// Anchor requested at 7.9: "b" (0 offset) would end at 7.9 + 2 = 9.9,
		// within the default snap threshold of the stationary clip's start (10).
		const { snappedAnchorStartTime, snapPoint } = snapGroupEdges({
			group,
			anchorStartTime: 7.9,
			tracks,
			playheadTime: 0,
			zoomLevel: 1,
		});

		expect(snapPoint).not.toBeNull();
		expect(snapPoint?.elementId).toBe("stationary");
		// b's end should land exactly on the stationary clip's start (10).
		expect(snappedAnchorStartTime + 2).toBeCloseTo(10, 5);
	});
});

describe("MoveElementsCommand", () => {
	function runMove({
		tracks,
		result,
	}: {
		tracks: TimelineTrack[];
		result: ReturnType<typeof resolveGroupMove>;
	}) {
		if (!result) throw new Error("expected a resolved group move result");
		let updatedTracks: TimelineTrack[] = tracks;
		let selection: { trackId: string; elementId: string }[] = [];

		mockEditorCore({
			editor: {
				timeline: {
					getTracks: () => tracks,
					updateTracks: (nextTracks) => {
						updatedTracks = nextTracks;
					},
				},
				selection: {
					getSelectedElements: () => selection,
					setSelectedElements: ({ elements }) => {
						selection = elements;
					},
				},
			},
		});

		const command = new MoveElementsCommand(result);
		command.execute();

		return {
			updatedTracks: () => updatedTracks,
			selection: () => selection,
			command,
		};
	}

	test("execute applies the plan and updates selection to the moved refs; undo restores both", () => {
		const tracks = buildCrossTrackFixture();
		const group = buildMoveGroup({
			anchorRef: { trackId: "video-B", elementId: "a" },
			selectedElements: [
				{ trackId: "video-B", elementId: "a" },
				{ trackId: "video-C", elementId: "b" },
			],
			tracks,
		});
		if (!group) throw new Error("expected group");
		const result = resolveGroupMove({
			group,
			tracks,
			anchorStartTime: 6,
			target: { kind: "existingTrack", targetTrackId: "video-A" },
		});

		const { updatedTracks, selection, command } = runMove({ tracks, result });

		const trackA = updatedTracks().find((t) => t.id === "video-A");
		expect(trackA?.elements.map((el) => el.id)).toEqual(["a"]);
		expect(selection()).toEqual(
			expect.arrayContaining([
				{ trackId: "video-A", elementId: "a" },
				{ trackId: "video-B", elementId: "b" },
			]),
		);

		command.undo();
		const restoredA = updatedTracks().find((t) => t.id === "video-A");
		expect(restoredA?.elements).toHaveLength(0);
	});
});

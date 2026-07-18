import { afterEach, describe, expect, mock, test } from "bun:test";
import type { EditorCore } from "@/core";
import type { TimelineTrack, VideoElement } from "@/types/timeline";
import { DEFAULT_TRANSFORM } from "@/constants/timeline-constants";
import {
	buildGroupResizeMembers,
	computeGroupResize,
} from "@/lib/timeline/group-resize";

/**
 * Order-dependence guard: `EditorCore` (from "@/core") and
 * `ResizeElementsCommand` (from "@/lib/commands/timeline/element/resize-elements-group")
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
const { ResizeElementsCommand } = await import(
	"@/lib/commands/timeline/element/resize-elements-group"
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

afterEach(() => {
	restoreEditorCore();
});

function buildVideoElement({
	id,
	startTime,
	duration,
	trimStart = 0,
	trimEnd = 0,
	sourceDuration,
}: {
	id: string;
	startTime: number;
	duration: number;
	trimStart?: number;
	trimEnd?: number;
	sourceDuration?: number;
}): VideoElement {
	return {
		id,
		name: `Clip ${id}`,
		type: "video",
		mediaId: `media-${id}`,
		duration,
		startTime,
		trimStart,
		trimEnd,
		sourceDuration,
		transform: DEFAULT_TRANSFORM,
		opacity: 1,
	};
}

function buildVideoTrack({
	id,
	elements,
}: {
	id: string;
	elements: VideoElement[];
}): TimelineTrack {
	return {
		id,
		name: id,
		type: "video",
		elements,
		isMain: false,
		muted: false,
		hidden: false,
	};
}

const FPS = 30;

describe("buildGroupResizeMembers", () => {
	test("skips over fellow group members entirely when searching for a neighbor bound", () => {
		// track: [a(2,4) -selected-] [b(6,2) -selected-], nothing else. "a"
		// ends exactly where "b" starts — if the neighbor search didn't
		// exclude group members, "a" would look blocked on its right by "b"
		// (and "b" blocked on its left by "a"). Since group members move
		// together, neither should bound the other: both bounds are null.
		const tracks: TimelineTrack[] = [
			buildVideoTrack({
				id: "video-1",
				elements: [
					buildVideoElement({ id: "a", startTime: 2, duration: 4 }),
					buildVideoElement({ id: "b", startTime: 6, duration: 2 }),
				],
			}),
		];

		const members = buildGroupResizeMembers({
			tracks,
			elements: [
				{ trackId: "video-1", elementId: "a" },
				{ trackId: "video-1", elementId: "b" },
			],
		});

		const a = members.find((m) => m.elementId === "a");
		const b = members.find((m) => m.elementId === "b");

		expect(a?.rightNeighborBound).toBeNull();
		expect(b?.leftNeighborBound).toBeNull();
	});

	test("still bounds against a genuinely stationary neighbor, skipping past group members to find it", () => {
		// track: [stationary-left(0,2)] [a(2,4) -selected-] [b(6,2) -selected-] [stationary-right(9,3)]
		// "a"'s right-side search must skip over "b" (its own group member)
		// and keep going to find "stationary-right" — same for "b"'s
		// left-side search skipping over "a" to find "stationary-left".
		const tracks: TimelineTrack[] = [
			buildVideoTrack({
				id: "video-1",
				elements: [
					buildVideoElement({
						id: "stationary-left",
						startTime: 0,
						duration: 2,
					}),
					buildVideoElement({ id: "a", startTime: 2, duration: 4 }),
					buildVideoElement({ id: "b", startTime: 6, duration: 2 }),
					buildVideoElement({
						id: "stationary-right",
						startTime: 9,
						duration: 3,
					}),
				],
			}),
		];

		const members = buildGroupResizeMembers({
			tracks,
			elements: [
				{ trackId: "video-1", elementId: "a" },
				{ trackId: "video-1", elementId: "b" },
			],
		});

		const a = members.find((m) => m.elementId === "a");
		const b = members.find((m) => m.elementId === "b");

		expect(a?.leftNeighborBound).toBe(2); // stationary-left's end
		expect(a?.rightNeighborBound).toBe(9); // stationary-right's start, past "b"
		expect(b?.leftNeighborBound).toBe(2); // stationary-left's end, past "a"
		expect(b?.rightNeighborBound).toBe(9); // stationary-right's start
	});
});

describe("computeGroupResize: cross-element group trim", () => {
	test("left-edge trim applies the same delta to every member, each preserving its own end time", () => {
		// Two clips on different tracks, synced to start together at t=3.
		const members = buildGroupResizeMembers({
			tracks: [
				buildVideoTrack({
					id: "video-A",
					elements: [buildVideoElement({ id: "a", startTime: 3, duration: 4 })],
				}),
				buildVideoTrack({
					id: "video-B",
					elements: [buildVideoElement({ id: "b", startTime: 3, duration: 4 })],
				}),
			],
			elements: [
				{ trackId: "video-A", elementId: "a" },
				{ trackId: "video-B", elementId: "b" },
			],
		});

		const result = computeGroupResize({
			members,
			side: "left",
			deltaTime: 1,
			fps: FPS,
		});

		expect(result.deltaTime).toBeCloseTo(1, 5);
		const a = result.updates.find((u) => u.elementId === "a");
		const b = result.updates.find((u) => u.elementId === "b");

		expect(a?.patch.startTime).toBeCloseTo(4, 5);
		expect(a?.patch.duration).toBeCloseTo(3, 5);
		expect(a?.patch.trimStart).toBeCloseTo(1, 5);
		// end time preserved: startTime + duration === 3 + 4 == 7
		expect((a?.patch.startTime ?? 0) + (a?.patch.duration ?? 0)).toBeCloseTo(
			7,
			5,
		);

		expect(b?.patch.startTime).toBeCloseTo(4, 5);
		expect(b?.patch.duration).toBeCloseTo(3, 5);
	});

	test("right-edge trim: the most-restrictive member's neighbor bound clamps the whole group", () => {
		const tracks: TimelineTrack[] = [
			buildVideoTrack({
				id: "video-A",
				// "a" has lots of room to its right.
				elements: [buildVideoElement({ id: "a", startTime: 0, duration: 3 })],
			}),
			buildVideoTrack({
				id: "video-B",
				// "b" is boxed in by a stationary neighbor starting at 4.
				elements: [
					buildVideoElement({ id: "b", startTime: 0, duration: 3 }),
					buildVideoElement({ id: "blocker", startTime: 4, duration: 2 }),
				],
			}),
		];

		const members = buildGroupResizeMembers({
			tracks,
			elements: [
				{ trackId: "video-A", elementId: "a" },
				{ trackId: "video-B", elementId: "b" },
			],
		});

		// Ask for a huge extension (+10s) — "a" alone could take it, but "b"
		// is bounded by "blocker" at 4, so the group's actual delta must clamp
		// to +1 (3 -> 4).
		const result = computeGroupResize({
			members,
			side: "right",
			deltaTime: 10,
			fps: FPS,
		});

		expect(result.deltaTime).toBeCloseTo(1, 5);
		const a = result.updates.find((u) => u.elementId === "a");
		const b = result.updates.find((u) => u.elementId === "b");
		expect(a?.patch.duration).toBeCloseTo(4, 5); // 3 + 1, same clamped delta
		expect(b?.patch.duration).toBeCloseTo(4, 5); // 0..4, touches "blocker" exactly
	});

	test("never shrinks a member below one frame's duration", () => {
		const members = buildGroupResizeMembers({
			tracks: [
				buildVideoTrack({
					id: "video-A",
					elements: [buildVideoElement({ id: "a", startTime: 0, duration: 1 })],
				}),
			],
			elements: [{ trackId: "video-A", elementId: "a" }],
		});

		const result = computeGroupResize({
			members,
			side: "right",
			deltaTime: -100,
			fps: FPS,
		});

		const a = result.updates.find((u) => u.elementId === "a");
		expect(a?.patch.duration).toBeCloseTo(1 / FPS, 5);
	});

	test("bounded (fixed sourceDuration) members can't extend past their remaining trim reserve", () => {
		// "a" has 1s of hidden trailing content (trimEnd=1) — can extend right
		// by at most 1s even with no neighbor in the way.
		const members = buildGroupResizeMembers({
			tracks: [
				buildVideoTrack({
					id: "video-A",
					elements: [
						buildVideoElement({
							id: "a",
							startTime: 0,
							duration: 3,
							trimEnd: 1,
							sourceDuration: 4,
						}),
					],
				}),
			],
			elements: [{ trackId: "video-A", elementId: "a" }],
		});

		const result = computeGroupResize({
			members,
			side: "right",
			deltaTime: 5,
			fps: FPS,
		});

		expect(result.deltaTime).toBeCloseTo(1, 5); // clamped to remaining trimEnd
		const a = result.updates.find((u) => u.elementId === "a");
		expect(a?.patch.duration).toBeCloseTo(4, 5);
		expect(a?.patch.trimEnd).toBeCloseTo(0, 5);
	});
});

describe("ResizeElementsCommand", () => {
	test("execute applies every member's patch atomically; undo restores the original tracks", () => {
		const tracks: TimelineTrack[] = [
			buildVideoTrack({
				id: "video-A",
				elements: [buildVideoElement({ id: "a", startTime: 3, duration: 4 })],
			}),
			buildVideoTrack({
				id: "video-B",
				elements: [buildVideoElement({ id: "b", startTime: 3, duration: 4 })],
			}),
		];

		const members = buildGroupResizeMembers({
			tracks,
			elements: [
				{ trackId: "video-A", elementId: "a" },
				{ trackId: "video-B", elementId: "b" },
			],
		});
		const result = computeGroupResize({
			members,
			side: "left",
			deltaTime: 1,
			fps: FPS,
		});

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

		const command = new ResizeElementsCommand(result.updates);
		command.execute();

		const a = updatedTracks.find((t) => t.id === "video-A")?.elements[0];
		const b = updatedTracks.find((t) => t.id === "video-B")?.elements[0];
		expect(a?.startTime).toBeCloseTo(4, 5);
		expect(b?.startTime).toBeCloseTo(4, 5);

		command.undo();
		const restoredA = updatedTracks.find((t) => t.id === "video-A")
			?.elements[0];
		expect(restoredA?.startTime).toBeCloseTo(3, 5);
	});
});

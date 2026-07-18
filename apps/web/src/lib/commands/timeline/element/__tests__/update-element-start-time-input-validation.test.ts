import { afterEach, describe, expect, mock, test } from "bun:test";
import type { EditorCore } from "@/core";
import type { TimelineTrack, VideoElement } from "@/types/timeline";
import { DEFAULT_TRANSFORM } from "@/constants/timeline-constants";

/**
 * Order-dependence guard: `EditorCore` (from "@/core") and
 * `UpdateElementStartTimeCommand` (from
 * "@/lib/commands/timeline/element/update-element-start-time") both
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
const { UpdateElementStartTimeCommand } = await import(
	"@/lib/commands/timeline/element/update-element-start-time"
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

// Malformed constructor input (e.g. programmatic MCP/Director callers passing
// {elementIds} instead of {elements}) must fail fast with a descriptive Error
// from the constructor, not a raw TypeError from deep inside execute().
function buildInvalidInput({ params }: { params: unknown }) {
	return params as ConstructorParameters<
		typeof UpdateElementStartTimeCommand
	>[0];
}

describe("UpdateElementStartTimeCommand input validation", () => {
	test('throws a descriptive error when "elements" is missing entirely', () => {
		expect(
			() =>
				new UpdateElementStartTimeCommand(
					buildInvalidInput({ params: { startTime: 1 } }),
				),
		).toThrow(
			'UpdateElementStartTimeCommand: "elements" must be an array of { trackId, elementId }',
		);
	});

	test("throws a descriptive error for the wrong-shape {elementIds} payload", () => {
		expect(
			() =>
				new UpdateElementStartTimeCommand(
					buildInvalidInput({
						params: { elementIds: ["el-1"], startTime: 1 },
					}),
				),
		).toThrow(
			'UpdateElementStartTimeCommand: "elements" must be an array of { trackId, elementId }',
		);
	});

	test('throws a descriptive error when "elements" is not an array', () => {
		expect(
			() =>
				new UpdateElementStartTimeCommand(
					buildInvalidInput({
						params: {
							elements: { trackId: "t-1", elementId: "el-1" },
							startTime: 1,
						},
					}),
				),
		).toThrow(
			'UpdateElementStartTimeCommand: "elements" must be an array of { trackId, elementId }',
		);
	});

	test("throws a descriptive error when an array entry is missing trackId/elementId strings", () => {
		expect(
			() =>
				new UpdateElementStartTimeCommand(
					buildInvalidInput({
						params: { elements: [{ trackId: "t-1" }], startTime: 1 },
					}),
				),
		).toThrow(
			'UpdateElementStartTimeCommand: "elements" must be an array of { trackId, elementId }',
		);
	});

	test("accepts an empty array and execute() is a safe no-op", () => {
		const tracks = [
			buildVideoTrack({
				id: "video-A",
				elements: [buildVideoElement({ id: "a", startTime: 0, duration: 2 })],
			}),
		];
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

		const command = new UpdateElementStartTimeCommand({
			elements: [],
			startTime: 5,
		});
		expect(() => command.execute()).not.toThrow();

		const trackA = updatedTracks.find((track) => track.id === "video-A");
		expect(trackA?.elements[0]?.startTime).toBe(0);
	});

	test("valid input still moves the targeted element (happy path unchanged)", () => {
		const tracks = [
			buildVideoTrack({
				id: "video-A",
				elements: [buildVideoElement({ id: "a", startTime: 0, duration: 2 })],
			}),
		];
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

		const command = new UpdateElementStartTimeCommand({
			elements: [{ trackId: "video-A", elementId: "a" }],
			startTime: 5,
		});
		command.execute();

		const trackA = updatedTracks.find((track) => track.id === "video-A");
		expect(trackA?.elements[0]?.startTime).toBe(5);

		command.undo();
		const restoredA = updatedTracks.find((track) => track.id === "video-A");
		expect(restoredA?.elements[0]?.startTime).toBe(0);
	});
});

import { afterEach, describe, expect, test } from "bun:test";
import { EditorCore } from "@/core";
import type { TimelineTrack, VideoElement } from "@/types/timeline";
import { DEFAULT_TRANSFORM } from "@/constants/timeline-constants";
import { SplitElementsCommand } from "@/lib/commands/timeline/element/split-elements";

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

const originalGetInstance = EditorCore.getInstance;

function mockEditorCore({ editor }: { editor: MockEditor }): void {
	(
		EditorCore as unknown as {
			getInstance: () => EditorCore;
		}
	).getInstance = () => editor as unknown as EditorCore;
}

function restoreEditorCore(): void {
	(
		EditorCore as unknown as {
			getInstance: typeof EditorCore.getInstance;
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
	return params as ConstructorParameters<typeof SplitElementsCommand>[0];
}

describe("SplitElementsCommand input validation", () => {
	test('throws a descriptive error when "elements" is missing entirely', () => {
		expect(
			() =>
				new SplitElementsCommand(
					buildInvalidInput({ params: { splitTime: 1 } }),
				),
		).toThrow(
			'SplitElementsCommand: "elements" must be an array of { trackId, elementId }',
		);
	});

	test("throws a descriptive error for the wrong-shape {elementIds} payload", () => {
		expect(
			() =>
				new SplitElementsCommand(
					buildInvalidInput({
						params: { elementIds: ["el-1"], splitTime: 1 },
					}),
				),
		).toThrow(
			'SplitElementsCommand: "elements" must be an array of { trackId, elementId }',
		);
	});

	test('throws a descriptive error when "elements" is not an array', () => {
		expect(
			() =>
				new SplitElementsCommand(
					buildInvalidInput({
						params: {
							elements: { trackId: "t-1", elementId: "el-1" },
							splitTime: 1,
						},
					}),
				),
		).toThrow(
			'SplitElementsCommand: "elements" must be an array of { trackId, elementId }',
		);
	});

	test("throws a descriptive error when an array entry is missing trackId/elementId strings", () => {
		expect(
			() =>
				new SplitElementsCommand(
					buildInvalidInput({
						params: { elements: [{ trackId: "t-1" }], splitTime: 1 },
					}),
				),
		).toThrow(
			'SplitElementsCommand: "elements" must be an array of { trackId, elementId }',
		);
	});

	test("accepts an empty array and execute() is a safe no-op", () => {
		const tracks = [
			buildVideoTrack({
				id: "video-A",
				elements: [buildVideoElement({ id: "a", startTime: 0, duration: 4 })],
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
				selection: {
					getSelectedElements: () => [],
					setSelectedElements: () => {},
				},
			},
		});

		const command = new SplitElementsCommand({ elements: [], splitTime: 2 });
		expect(() => command.execute()).not.toThrow();

		const trackA = updatedTracks.find((track) => track.id === "video-A");
		expect(trackA?.elements.map((element) => element.id)).toEqual(["a"]);
	});

	test("valid input still splits the targeted element (happy path unchanged)", () => {
		const tracks = [
			buildVideoTrack({
				id: "video-A",
				isMain: true,
				elements: [buildVideoElement({ id: "a", startTime: 0, duration: 4 })],
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
				selection: {
					getSelectedElements: () => [],
					setSelectedElements: () => {},
				},
			},
		});

		const command = new SplitElementsCommand({
			elements: [{ trackId: "video-A", elementId: "a" }],
			splitTime: 2,
		});
		command.execute();

		const trackA = updatedTracks.find((track) => track.id === "video-A");
		expect(trackA?.elements.length).toBe(2);

		command.undo();
		const restoredA = updatedTracks.find((track) => track.id === "video-A");
		expect(restoredA?.elements.map((element) => element.id)).toEqual(["a"]);
	});
});

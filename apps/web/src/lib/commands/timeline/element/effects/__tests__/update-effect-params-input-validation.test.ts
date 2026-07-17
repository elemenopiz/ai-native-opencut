import { afterEach, describe, expect, test } from "bun:test";
import { EditorCore } from "@/core";
import type { TimelineTrack, VideoElement } from "@/types/timeline";
import { DEFAULT_TRANSFORM } from "@/constants/timeline-constants";
import { UpdateClipEffectParamsCommand } from "@/lib/commands/timeline/element/effects/update-effect-params";

type MockEditor = {
	timeline: {
		getTracks: () => TimelineTrack[];
		updateTracks: (tracks: TimelineTrack[]) => void;
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

function buildVideoElementWithEffect({
	id,
	effectId,
}: {
	id: string;
	effectId: string;
}): VideoElement {
	return {
		id,
		name: `Clip ${id}`,
		type: "video",
		mediaId: `media-${id}`,
		duration: 4,
		startTime: 0,
		trimStart: 0,
		trimEnd: 0,
		transform: DEFAULT_TRANSFORM,
		opacity: 1,
		effects: [
			{
				id: effectId,
				type: "blur",
				params: { intensity: 0.2 },
				enabled: true,
			},
		],
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
		isMain: true,
		muted: false,
		hidden: false,
	};
}

// Malformed constructor input (e.g. programmatic MCP/Director callers passing
// a non-object `params`, such as `null` or an array) must fail fast with a
// descriptive Error from the constructor, not a raw TypeError from
// `Object.entries(params)` deep inside execute().
function buildInvalidInput({ params }: { params: unknown }) {
	return params as ConstructorParameters<
		typeof UpdateClipEffectParamsCommand
	>[0];
}

describe("UpdateClipEffectParamsCommand input validation", () => {
	test('throws a descriptive error when "params" is null', () => {
		expect(
			() =>
				new UpdateClipEffectParamsCommand(
					buildInvalidInput({
						params: {
							trackId: "video-A",
							elementId: "a",
							effectId: "fx-1",
							params: null,
						},
					}),
				),
		).toThrow('UpdateClipEffectParamsCommand: "params" must be a plain object');
	});

	test('throws a descriptive error when "params" is missing entirely', () => {
		expect(
			() =>
				new UpdateClipEffectParamsCommand(
					buildInvalidInput({
						params: { trackId: "video-A", elementId: "a", effectId: "fx-1" },
					}),
				),
		).toThrow('UpdateClipEffectParamsCommand: "params" must be a plain object');
	});

	test('throws a descriptive error when "params" is an array', () => {
		expect(
			() =>
				new UpdateClipEffectParamsCommand(
					buildInvalidInput({
						params: {
							trackId: "video-A",
							elementId: "a",
							effectId: "fx-1",
							params: ["intensity", 0.5],
						},
					}),
				),
		).toThrow('UpdateClipEffectParamsCommand: "params" must be a plain object');
	});

	test('throws a descriptive error when "params" is a primitive', () => {
		expect(
			() =>
				new UpdateClipEffectParamsCommand(
					buildInvalidInput({
						params: {
							trackId: "video-A",
							elementId: "a",
							effectId: "fx-1",
							params: "intensity=0.5",
						},
					}),
				),
		).toThrow('UpdateClipEffectParamsCommand: "params" must be a plain object');
	});

	test("accepts an empty object and execute() is a safe no-op change", () => {
		const tracks = [
			buildVideoTrack({
				id: "video-A",
				elements: [buildVideoElementWithEffect({ id: "a", effectId: "fx-1" })],
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

		const command = new UpdateClipEffectParamsCommand({
			trackId: "video-A",
			elementId: "a",
			effectId: "fx-1",
			params: {},
		});
		expect(() => command.execute()).not.toThrow();

		const trackA = updatedTracks.find((track) => track.id === "video-A");
		const element = trackA?.elements[0] as VideoElement;
		expect(element.effects?.[0]?.params).toEqual({ intensity: 0.2 });
	});

	test("valid input still updates the targeted effect's params (happy path unchanged)", () => {
		const tracks = [
			buildVideoTrack({
				id: "video-A",
				elements: [buildVideoElementWithEffect({ id: "a", effectId: "fx-1" })],
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

		const command = new UpdateClipEffectParamsCommand({
			trackId: "video-A",
			elementId: "a",
			effectId: "fx-1",
			params: { intensity: 0.9 },
		});
		command.execute();

		const trackA = updatedTracks.find((track) => track.id === "video-A");
		const element = trackA?.elements[0] as VideoElement;
		expect(element.effects?.[0]?.params).toEqual({ intensity: 0.9 });

		command.undo();
		const restoredA = updatedTracks.find((track) => track.id === "video-A");
		const restoredElement = restoredA?.elements[0] as VideoElement;
		expect(restoredElement.effects?.[0]?.params).toEqual({ intensity: 0.2 });
	});
});

import { afterEach, describe, expect, test } from "bun:test";
import { EditorCore } from "@/core";
import { DEFAULT_TRANSFORM } from "@/constants/timeline-constants";
import { SplitElementsCommand } from "@/lib/commands/timeline/element/split-elements";
import { executeAction } from "@/lib/ai-action-executor";
import type { EditorAction } from "@/types/ai";
import type { TimelineTrack, VideoElement } from "@/types/timeline";

const originalGetInstance = EditorCore.getInstance;

function restoreEditorCore(): void {
	(
		EditorCore as unknown as { getInstance: typeof EditorCore.getInstance }
	).getInstance = originalGetInstance;
}

afterEach(() => {
	restoreEditorCore();
});

function buildVideoElement(): VideoElement {
	return {
		id: "element-1",
		name: "Clip",
		type: "video",
		mediaId: "media-1",
		duration: 8,
		startTime: 1,
		trimStart: 0,
		trimEnd: 0,
		transform: DEFAULT_TRANSFORM,
		opacity: 1,
		animations: { channels: {} },
	};
}

function buildTracks(): TimelineTrack[] {
	return [
		{
			id: "track-1",
			name: "Track 1",
			type: "video",
			elements: [buildVideoElement()],
			muted: false,
		} as unknown as TimelineTrack,
	];
}

// Regression: the AI copilot SPLIT_CLIP action used to pass `time` inside the
// element object and omit the required top-level `splitTime`, so the command
// received splitTime === undefined and silently set duration/trim to NaN.
describe("executeAction SPLIT_CLIP", () => {
	test("splits the clip at the given time with finite durations", () => {
		let tracks = buildTracks();
		const editor = {
			timeline: {
				getTracks: () => tracks,
				updateTracks: (next: TimelineTrack[]) => {
					tracks = next;
				},
				// Mirror TimelineManager.splitElements so we exercise the real command.
				splitElements: (args: {
					elements: { trackId: string; elementId: string }[];
					splitTime: number;
				}) => {
					new SplitElementsCommand({
						elements: args.elements,
						splitTime: args.splitTime,
						retainSide: "both",
						rippleEnabled: false,
					}).execute();
					return [];
				},
			},
			selection: {
				getSelectedElements: () => [],
				setSelectedElements: () => {},
			},
		};
		(EditorCore as unknown as { getInstance: () => EditorCore }).getInstance =
			() => editor as unknown as EditorCore;

		const action: EditorAction = {
			type: "SPLIT_CLIP",
			params: { time: 5 },
			description: "Split clip at 5s",
		};

		executeAction(action);

		const elements = tracks[0].elements as VideoElement[];
		expect(elements).toHaveLength(2);
		for (const el of elements) {
			expect(Number.isFinite(el.duration)).toBe(true);
			expect(Number.isFinite(el.trimStart)).toBe(true);
			expect(Number.isFinite(el.trimEnd)).toBe(true);
		}
		// Split at t=5 on a clip [startTime 1 .. 9]: left visible 4s, right 4s.
		const left = elements.find((e) => e.id === "element-1") as VideoElement;
		const right = elements.find((e) => e.id !== "element-1") as VideoElement;
		expect(left.duration).toBeCloseTo(4, 5);
		expect(right.duration).toBeCloseTo(4, 5);
	});
});

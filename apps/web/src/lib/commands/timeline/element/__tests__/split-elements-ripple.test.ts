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

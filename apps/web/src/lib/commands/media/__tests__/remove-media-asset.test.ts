import { afterEach, describe, expect, test } from "bun:test";
import { EditorCore } from "@/core";
import { CommandManager } from "@/core/managers/commands";
import { MediaManager } from "@/core/managers/media-manager";
import { RemoveMediaAssetCommand } from "@/lib/commands/media";
import { DEFAULT_TRANSFORM } from "@/constants/timeline-constants";
import type { MediaAsset } from "@/types/assets";
import type {
	ImageElement,
	TimelineTrack,
	VideoElement,
} from "@/types/timeline";

/**
 * BUG34: deleting a media asset used to cascade through
 * `MediaManager.removeMediaAsset` as plain (non-undoable) code, with only the
 * trailing `timeline.deleteElements()` call pushed to the undo stack. Ctrl+Z
 * therefore restored clip shells pointing at an asset whose storage row,
 * embedding/understanding rows, and (in the old code) object URLs were
 * already gone — a ghost clip, and no audio.
 *
 * These tests exercise the fix at the REAL production seam: a fake
 * `EditorCore.getInstance()` wired up exactly like the real singleton (real
 * `CommandManager`, real `MediaManager`, fake timeline/selection) so
 * `editor.media.removeMediaAsset(...)` walks the exact path the Assets panel
 * uses (`handleRemove` in assets.tsx calls this same method), and the
 * asset-delete/undo/redo round trip is verified through the public API only.
 */

type FakeEditor = EditorCore & {
	timeline: {
		getTracks: () => TimelineTrack[];
		updateTracks: (tracks: TimelineTrack[]) => void;
	};
	selection: {
		getSelectedElements: () => { trackId: string; elementId: string }[];
		setSelectedElements: (args: {
			elements: { trackId: string; elementId: string }[];
		}) => void;
	};
};

const originalGetInstance = EditorCore.getInstance;

function restoreEditorCore(): void {
	(
		EditorCore as unknown as { getInstance: typeof EditorCore.getInstance }
	).getInstance = originalGetInstance;
}

afterEach(() => {
	restoreEditorCore();
});

/** Builds a fake editor wired the same way the real EditorCore wires itself:
 * `editor.media` is a real MediaManager constructed with THIS editor, so
 * `editor.media.setAssets(...)` calls from inside a command land back on the
 * exact manager instance the test drives. */
function makeEditor({ tracks }: { tracks: TimelineTrack[] }): FakeEditor {
	let currentTracks = tracks;
	let selection: { trackId: string; elementId: string }[] = [];

	const editor = {} as FakeEditor;
	(editor as unknown as { command: CommandManager }).command =
		new CommandManager();
	editor.timeline = {
		getTracks: () => currentTracks,
		updateTracks: (next) => {
			currentTracks = next;
		},
	};
	editor.selection = {
		getSelectedElements: () => selection,
		setSelectedElements: ({ elements }) => {
			selection = elements;
		},
	};
	(editor as unknown as { media: MediaManager }).media = new MediaManager(
		editor,
	);

	(EditorCore as unknown as { getInstance: () => EditorCore }).getInstance =
		() => editor;

	return editor;
}

function videoAsset(id: string): MediaAsset {
	return {
		id,
		name: `${id}.mp4`,
		type: "video",
		file: new File([new Uint8Array([1])], `${id}.mp4`),
	} as MediaAsset;
}

function imageAsset(id: string): MediaAsset {
	return {
		id,
		name: `${id}.png`,
		type: "image",
		file: new File([new Uint8Array([1])], `${id}.png`),
	} as MediaAsset;
}

function videoElement({
	id,
	mediaId,
	startTime,
	duration,
	trimStart,
	trimEnd,
}: {
	id: string;
	mediaId: string;
	startTime: number;
	duration: number;
	trimStart: number;
	trimEnd: number;
}): VideoElement {
	return {
		id,
		name: id,
		type: "video",
		mediaId,
		duration,
		startTime,
		trimStart,
		trimEnd,
		transform: DEFAULT_TRANSFORM,
		opacity: 0.77,
	};
}

function imageElement({
	id,
	mediaId,
	startTime,
	duration,
}: {
	id: string;
	mediaId: string;
	startTime: number;
	duration: number;
}): ImageElement {
	return {
		id,
		name: id,
		type: "image",
		mediaId,
		duration,
		startTime,
		trimStart: 0,
		trimEnd: 0,
		transform: DEFAULT_TRANSFORM,
		opacity: 1,
	};
}

function videoTrack({
	id,
	elements,
}: {
	id: string;
	elements: (VideoElement | ImageElement)[];
}): TimelineTrack {
	return {
		id,
		name: id,
		type: "video",
		elements,
		isMain: id === "main",
		muted: false,
		hidden: false,
	};
}

describe("RemoveMediaAssetCommand — asset-delete/undo cascade (BUG34)", () => {
	test("execute -> undo restores the asset list AND the timeline element exactly (position/trim/properties)", () => {
		const clip = videoElement({
			id: "el-1",
			mediaId: "m1",
			startTime: 3.5,
			duration: 8,
			trimStart: 1.25,
			trimEnd: 0.5,
		});
		const track = videoTrack({ id: "main", elements: [clip] });
		const editor = makeEditor({ tracks: [track] });

		editor.media.setAssets({ assets: [videoAsset("m1"), videoAsset("m2")] });

		editor.media.removeMediaAsset({ projectId: "p1", id: "m1" });

		expect(editor.media.getAssets().map((a) => a.id)).toEqual(["m2"]);
		expect(editor.timeline.getTracks()[0].elements).toHaveLength(0);
		expect(editor.command.getHistoryLength()).toBe(1);

		editor.command.undo();

		expect(editor.media.getAssets().map((a) => a.id)).toEqual(["m1", "m2"]);
		const restoredTrack = editor.timeline.getTracks()[0];
		expect(restoredTrack.elements).toHaveLength(1);
		const restored = restoredTrack.elements[0] as VideoElement;
		expect(restored).toEqual(clip);
	});

	test("history contains exactly ONE entry per delete — no nested DeleteElementsCommand entry", () => {
		const clip = videoElement({
			id: "el-1",
			mediaId: "m1",
			startTime: 0,
			duration: 4,
			trimStart: 0,
			trimEnd: 0,
		});
		const editor = makeEditor({
			tracks: [videoTrack({ id: "main", elements: [clip] })],
		});
		editor.media.setAssets({ assets: [videoAsset("m1")] });

		expect(editor.command.getHistoryLength()).toBe(0);
		editor.media.removeMediaAsset({ projectId: "p1", id: "m1" });
		expect(editor.command.getHistoryLength()).toBe(1);
	});

	test("redo removes the asset and elements again", () => {
		const clip = videoElement({
			id: "el-1",
			mediaId: "m1",
			startTime: 2,
			duration: 5,
			trimStart: 0,
			trimEnd: 0,
		});
		const editor = makeEditor({
			tracks: [videoTrack({ id: "main", elements: [clip] })],
		});
		editor.media.setAssets({ assets: [videoAsset("m1")] });

		editor.media.removeMediaAsset({ projectId: "p1", id: "m1" });
		editor.command.undo();
		editor.command.redo();

		expect(editor.media.getAssets()).toEqual([]);
		expect(editor.timeline.getTracks()[0].elements).toHaveLength(0);
	});

	test("undo after redo restores the asset and element again", () => {
		const clip = videoElement({
			id: "el-1",
			mediaId: "m1",
			startTime: 2,
			duration: 5,
			trimStart: 0.3,
			trimEnd: 0.1,
		});
		const editor = makeEditor({
			tracks: [videoTrack({ id: "main", elements: [clip] })],
		});
		editor.media.setAssets({ assets: [videoAsset("m1")] });

		editor.media.removeMediaAsset({ projectId: "p1", id: "m1" });
		editor.command.undo();
		editor.command.redo();
		editor.command.undo();

		expect(editor.media.getAssets().map((a) => a.id)).toEqual(["m1"]);
		const restored = editor.timeline.getTracks()[0].elements[0] as VideoElement;
		expect(restored).toEqual(clip);
	});

	test("multi-track/multi-element: every dependent element across every track is restored", () => {
		const clipA = videoElement({
			id: "el-a",
			mediaId: "m1",
			startTime: 0,
			duration: 3,
			trimStart: 0,
			trimEnd: 0,
		});
		const clipB = videoElement({
			id: "el-b",
			mediaId: "m1",
			startTime: 10,
			duration: 4,
			trimStart: 0.6,
			trimEnd: 0.2,
		});
		const otherClip = videoElement({
			id: "el-other",
			mediaId: "m2",
			startTime: 0,
			duration: 2,
			trimStart: 0,
			trimEnd: 0,
		});
		const trackMain = videoTrack({ id: "main", elements: [clipA, otherClip] });
		const trackB = videoTrack({ id: "track-b", elements: [clipB] });
		const editor = makeEditor({ tracks: [trackMain, trackB] });
		editor.media.setAssets({ assets: [videoAsset("m1"), videoAsset("m2")] });

		editor.media.removeMediaAsset({ projectId: "p1", id: "m1" });

		expect(
			editor.timeline.getTracks().flatMap((t) => t.elements.map((e) => e.id)),
		).toEqual(["el-other"]);

		editor.command.undo();

		const tracksAfterUndo = editor.timeline.getTracks();
		const main = tracksAfterUndo.find((t) => t.id === "main");
		const trackBAfter = tracksAfterUndo.find((t) => t.id === "track-b");
		expect(main?.elements.map((e) => e.id).sort()).toEqual([
			"el-a",
			"el-other",
		]);
		expect(trackBAfter?.elements.map((e) => e.id)).toEqual(["el-b"]);
		expect(main?.elements.find((e) => e.id === "el-a")).toEqual(clipA);
		expect(trackBAfter?.elements[0]).toEqual(clipB);
	});

	test("IMAGE asset delete follows the exact same cascade (class fix)", () => {
		const img = imageElement({
			id: "el-img",
			mediaId: "m-img",
			startTime: 1,
			duration: 2,
		});
		const editor = makeEditor({
			tracks: [videoTrack({ id: "main", elements: [img] })],
		});
		editor.media.setAssets({ assets: [imageAsset("m-img")] });

		editor.media.removeMediaAsset({ projectId: "p1", id: "m-img" });
		expect(editor.media.getAssets()).toEqual([]);
		expect(editor.timeline.getTracks()[0].elements).toHaveLength(0);

		editor.command.undo();
		expect(editor.media.getAssets().map((a) => a.id)).toEqual(["m-img"]);
		expect(editor.timeline.getTracks()[0].elements[0]).toEqual(img);
	});

	test("missing asset is a safe no-op and doesn't corrupt history/undo", () => {
		const editor = makeEditor({
			tracks: [videoTrack({ id: "main", elements: [] })],
		});
		editor.media.setAssets({ assets: [videoAsset("m1")] });

		editor.media.removeMediaAsset({ projectId: "p1", id: "does-not-exist" });

		// Still pushed to history (CommandManager always pushes on execute()),
		// but it's an inert entry — nothing was captured to undo.
		expect(editor.command.getHistoryLength()).toBe(1);
		expect(editor.media.getAssets().map((a) => a.id)).toEqual(["m1"]);

		editor.command.undo();
		expect(editor.media.getAssets().map((a) => a.id)).toEqual(["m1"]);
	});

	test("direct construction: fresh child DeleteElementsCommand is rebuilt on every execute (redo doesn't replay a stale snapshot)", () => {
		const clip = videoElement({
			id: "el-1",
			mediaId: "m1",
			startTime: 0,
			duration: 4,
			trimStart: 0,
			trimEnd: 0,
		});
		const editor = makeEditor({
			tracks: [videoTrack({ id: "main", elements: [clip] })],
		});
		editor.media.setAssets({ assets: [videoAsset("m1")] });

		const command = new RemoveMediaAssetCommand("p1", "m1");
		command.execute();
		expect(editor.timeline.getTracks()[0].elements).toHaveLength(0);

		command.undo();
		expect(editor.timeline.getTracks()[0].elements).toHaveLength(1);

		// A second manual delete/re-add cycle in between must not desync the
		// child command from the current track contents.
		command.execute();
		command.undo();
		expect(editor.timeline.getTracks()[0].elements[0]).toEqual(clip);
	});
});

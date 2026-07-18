import { afterEach, describe, expect, mock, test } from "bun:test";
import { CommandManager } from "@/core/managers/commands";
import { DEFAULT_TRANSFORM } from "@/constants/timeline-constants";
import type { EditorCore } from "@/core";
import type { MediaManager } from "@/core/managers/media-manager";
import type { MediaAsset } from "@/types/assets";
import type { TimelineTrack, VideoElement } from "@/types/timeline";

/**
 * KNOWN HOLE #3 / BUG108: `MediaManager.removeMediaAsset` only ever deletes
 * ONE asset per `editor.command.execute()` call, so a caller that needs to
 * delete N assets and loops that method produces N separate undo-stack
 * entries (N presses of Ctrl+Z to fully undo). `RemoveMediaAssetsCommand`
 * closes that hole as a self-contained composite: N `RemoveMediaAssetCommand`
 * children driven directly (`.execute()`/`.undo()`), never through
 * `editor.command.execute()`, so wrapping them in ONE
 * `editor.command.execute({ command })` call yields exactly ONE history
 * entry no matter how many assets are in the batch.
 *
 * Same fake-EditorCore harness as `remove-media-asset.test.ts` (real
 * `CommandManager` + real `MediaManager`, fake timeline/selection) — see that
 * file's header comment for the mock.module ordering rationale (both files
 * transitively import the real `@/services/proxy` barrel via
 * `media-manager.ts`).
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
const { MediaManager: MediaManagerClass } = await import(
	"@/core/managers/media-manager"
);
const { RemoveMediaAssetsCommand } = await import(
	"@/lib/commands/media/remove-media-assets"
);

interface FakeTimeline {
	getTracks: () => TimelineTrack[];
	updateTracks: (tracks: TimelineTrack[]) => void;
}
interface FakeSelection {
	getSelectedElements: () => { trackId: string; elementId: string }[];
	setSelectedElements: (args: {
		elements: { trackId: string; elementId: string }[];
	}) => void;
}
type FakeEditor = EditorCore;

const originalGetInstance = EditorCoreClass.getInstance;

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

function makeEditor({ tracks }: { tracks: TimelineTrack[] }): FakeEditor {
	let currentTracks = tracks;
	let selection: { trackId: string; elementId: string }[] = [];

	const editor = {} as FakeEditor;
	(editor as unknown as { command: CommandManager }).command =
		new CommandManager();
	(editor as unknown as { timeline: FakeTimeline }).timeline = {
		getTracks: () => currentTracks,
		updateTracks: (next) => {
			currentTracks = next;
		},
	};
	(editor as unknown as { selection: FakeSelection }).selection = {
		getSelectedElements: () => selection,
		setSelectedElements: ({ elements }) => {
			selection = elements;
		},
	};
	(editor as unknown as { media: MediaManager }).media = new MediaManagerClass(
		editor,
	);

	(
		EditorCoreClass as unknown as { getInstance: () => EditorCore }
	).getInstance = () => editor;

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

function videoElement({
	id,
	mediaId,
	startTime,
	duration,
}: {
	id: string;
	mediaId: string;
	startTime: number;
	duration: number;
}): VideoElement {
	return {
		id,
		name: id,
		type: "video",
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
	elements: VideoElement[];
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

describe("RemoveMediaAssetsCommand — batch asset delete as ONE undo entry (KNOWN HOLE #3 / BUG108)", () => {
	test("deleting 3 assets across 2 tracks in one call produces exactly ONE history entry", () => {
		const clipA = videoElement({
			id: "el-a",
			mediaId: "m1",
			startTime: 0,
			duration: 3,
		});
		const clipB = videoElement({
			id: "el-b",
			mediaId: "m2",
			startTime: 4,
			duration: 2,
		});
		const clipC = videoElement({
			id: "el-c",
			mediaId: "m3",
			startTime: 0,
			duration: 5,
		});
		const editor = makeEditor({
			tracks: [
				videoTrack({ id: "main", elements: [clipA, clipB] }),
				videoTrack({ id: "track-b", elements: [clipC] }),
			],
		});
		editor.media.setAssets({
			assets: [videoAsset("m1"), videoAsset("m2"), videoAsset("m3")],
		});

		expect(editor.command.getHistoryLength()).toBe(0);

		const command = new RemoveMediaAssetsCommand("p1", ["m1", "m2", "m3"]);
		editor.command.execute({ command });

		expect(editor.command.getHistoryLength()).toBe(1);
		expect(editor.media.getAssets()).toEqual([]);
		expect(
			editor.timeline.getTracks().flatMap((t) => t.elements.map((e) => e.id)),
		).toHaveLength(0);
	});

	test("execute -> undo restores every asset AND every dependent element exactly (single Ctrl+Z undoes the whole batch)", () => {
		const clipA = videoElement({
			id: "el-a",
			mediaId: "m1",
			startTime: 0,
			duration: 3,
		});
		const clipB = videoElement({
			id: "el-b",
			mediaId: "m2",
			startTime: 4,
			duration: 2,
		});
		const untouched = videoElement({
			id: "el-keep",
			mediaId: "m-keep",
			startTime: 8,
			duration: 1,
		});
		const editor = makeEditor({
			tracks: [videoTrack({ id: "main", elements: [clipA, clipB, untouched] })],
		});
		editor.media.setAssets({
			assets: [videoAsset("m1"), videoAsset("m2"), videoAsset("m-keep")],
		});

		const command = new RemoveMediaAssetsCommand("p1", ["m1", "m2"]);
		editor.command.execute({ command });

		expect(editor.media.getAssets().map((a) => a.id)).toEqual(["m-keep"]);
		expect(editor.timeline.getTracks()[0].elements.map((e) => e.id)).toEqual([
			"el-keep",
		]);

		editor.command.undo();

		expect(
			editor.media
				.getAssets()
				.map((a) => a.id)
				.sort(),
		).toEqual(["m-keep", "m1", "m2"]);
		const restoredElements = editor.timeline
			.getTracks()[0]
			.elements.map((e) => e.id)
			.sort();
		expect(restoredElements).toEqual(["el-a", "el-b", "el-keep"]);
	});

	test("redo removes the same batch again; undo after redo restores it again", () => {
		const clipA = videoElement({
			id: "el-a",
			mediaId: "m1",
			startTime: 0,
			duration: 3,
		});
		const clipB = videoElement({
			id: "el-b",
			mediaId: "m2",
			startTime: 4,
			duration: 2,
		});
		const editor = makeEditor({
			tracks: [videoTrack({ id: "main", elements: [clipA, clipB] })],
		});
		editor.media.setAssets({ assets: [videoAsset("m1"), videoAsset("m2")] });

		const command = new RemoveMediaAssetsCommand("p1", ["m1", "m2"]);
		editor.command.execute({ command });
		editor.command.undo();
		editor.command.redo();

		expect(editor.media.getAssets()).toEqual([]);
		expect(editor.timeline.getTracks()[0].elements).toHaveLength(0);

		editor.command.undo();

		expect(
			editor.media
				.getAssets()
				.map((a) => a.id)
				.sort(),
		).toEqual(["m1", "m2"]);
		expect(
			editor.timeline
				.getTracks()[0]
				.elements.map((e) => e.id)
				.sort(),
		).toEqual(["el-a", "el-b"]);
	});

	test("a missing asset mid-batch is a safe no-op for that entry only — the rest of the batch still deletes/restores", () => {
		const clipA = videoElement({
			id: "el-a",
			mediaId: "m1",
			startTime: 0,
			duration: 3,
		});
		const clipC = videoElement({
			id: "el-c",
			mediaId: "m3",
			startTime: 4,
			duration: 2,
		});
		const editor = makeEditor({
			tracks: [videoTrack({ id: "main", elements: [clipA, clipC] })],
		});
		editor.media.setAssets({ assets: [videoAsset("m1"), videoAsset("m3")] });

		// "m2" was never in the asset list — simulates a stale id in the batch.
		const command = new RemoveMediaAssetsCommand("p1", ["m1", "m2", "m3"]);
		editor.command.execute({ command });

		expect(editor.command.getHistoryLength()).toBe(1);
		expect(editor.media.getAssets()).toEqual([]);

		editor.command.undo();

		expect(
			editor.media
				.getAssets()
				.map((a) => a.id)
				.sort(),
		).toEqual(["m1", "m3"]);
		expect(
			editor.timeline
				.getTracks()[0]
				.elements.map((e) => e.id)
				.sort(),
		).toEqual(["el-a", "el-c"]);
	});

	test("empty batch is a harmless no-op single entry", () => {
		const editor = makeEditor({
			tracks: [videoTrack({ id: "main", elements: [] })],
		});
		editor.media.setAssets({ assets: [videoAsset("m1")] });

		const command = new RemoveMediaAssetsCommand("p1", []);
		editor.command.execute({ command });

		expect(editor.command.getHistoryLength()).toBe(1);
		expect(editor.media.getAssets().map((a) => a.id)).toEqual(["m1"]);

		editor.command.undo();
		expect(editor.media.getAssets().map((a) => a.id)).toEqual(["m1"]);
	});
});

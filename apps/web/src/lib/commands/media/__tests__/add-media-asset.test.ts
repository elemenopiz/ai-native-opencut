import { afterEach, describe, expect, mock, test } from "bun:test";
import { CommandManager } from "@/core/managers/commands";
import type { EditorCore } from "@/core";
import type { MediaManager } from "@/core/managers/media-manager";
import type { TimelineTrack } from "@/types/timeline";

/**
 * `AddMediaAssetCommand` (#35) property tests. Same fake-EditorCore harness
 * as `remove-media-asset.test.ts` — see that file's header for the
 * mock.module ordering rationale.
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
const { AddMediaAssetCommand } = await import(
	"@/lib/commands/media/add-media-asset"
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

function makeEditor(): FakeEditor {
	let currentTracks: TimelineTrack[] = [];
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

describe("AddMediaAssetCommand", () => {
	test("execute -> undo restores the pre-add asset list exactly", () => {
		const editor = makeEditor();
		editor.media.setAssets({
			assets: [
				{
					id: "existing",
					name: "existing.mp4",
					type: "video",
					file: new File([new Uint8Array([1])], "existing.mp4"),
				} as never,
			],
		});

		const command = new AddMediaAssetCommand("p1", {
			name: "new.mp4",
			type: "video",
			file: new File([new Uint8Array([1])], "new.mp4"),
		} as never);
		editor.command.execute({ command });

		expect(editor.media.getAssets().map((a) => a.id)).toEqual([
			"existing",
			command.getAssetId(),
		]);
		expect(editor.command.getHistoryLength()).toBe(1);

		editor.command.undo();

		expect(editor.media.getAssets().map((a) => a.id)).toEqual(["existing"]);
	});

	test("BUG-check: execute -> undo -> redo keeps the SAME asset id (id generated once in the constructor)", () => {
		const editor = makeEditor();
		editor.media.setAssets({ assets: [] });

		const command = new AddMediaAssetCommand("p1", {
			name: "new.mp4",
			type: "video",
			file: new File([new Uint8Array([1])], "new.mp4"),
		} as never);
		editor.command.execute({ command });

		const idAfterFirstExecute = command.getAssetId();

		editor.command.undo();
		editor.command.redo();

		expect(command.getAssetId()).toBe(idAfterFirstExecute);
		expect(editor.media.getAssets().map((a) => a.id)).toEqual([
			idAfterFirstExecute,
		]);
	});

	test("undo after redo restores the empty list again (round-trip identity)", () => {
		const editor = makeEditor();
		editor.media.setAssets({ assets: [] });

		const command = new AddMediaAssetCommand("p1", {
			name: "new.mp4",
			type: "video",
			file: new File([new Uint8Array([1])], "new.mp4"),
		} as never);
		editor.command.execute({ command });
		editor.command.undo();
		editor.command.redo();
		editor.command.undo();

		expect(editor.media.getAssets()).toEqual([]);
	});
});

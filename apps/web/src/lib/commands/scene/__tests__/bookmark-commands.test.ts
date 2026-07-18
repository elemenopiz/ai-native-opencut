import { afterEach, describe, expect, mock, test } from "bun:test";
import { CommandManager } from "@/core/managers/commands";
import type { EditorCore } from "@/core";
import type { ScenesManager } from "@/core/managers/scenes-manager";
import type { TProject } from "@/types/project";
import type { TScene } from "@/types/timeline";

/**
 * Property tests for the 4 bookmark commands (#39-42): ToggleBookmarkCommand,
 * MoveBookmarkCommand, UpdateBookmarkCommand, RemoveBookmarkCommand. All four
 * share the identical shape — snapshot the full scene list, mutate the
 * active scene's `bookmarks` array, restore the snapshot on undo — so they're
 * covered together. Same harness/mock idiom as `create-scene.test.ts`.
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
const { ScenesManager: ScenesManagerClass } = await import(
	"@/core/managers/scenes-manager"
);
const { ToggleBookmarkCommand } = await import(
	"@/lib/commands/scene/toggle-bookmark"
);
const { MoveBookmarkCommand } = await import(
	"@/lib/commands/scene/move-bookmark"
);
const { UpdateBookmarkCommand } = await import(
	"@/lib/commands/scene/update-bookmark"
);
const { RemoveBookmarkCommand } = await import(
	"@/lib/commands/scene/remove-bookmark"
);

interface FakeProject {
	getActive: () => TProject | null;
	setActiveProject: (args: { project: TProject }) => void;
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

function makeProject(): TProject {
	return {
		metadata: {
			id: "p1",
			name: "Test project",
			duration: 0,
			createdAt: new Date(),
			updatedAt: new Date(),
		},
		scenes: [],
		currentSceneId: "",
		settings: {
			fps: 30,
			canvasSize: { width: 1920, height: 1080 },
			background: { type: "color", color: "#000000" },
		},
		version: 1,
	};
}

function scene({
	id,
	bookmarks = [],
}: {
	id: string;
	bookmarks?: TScene["bookmarks"];
}): TScene {
	return {
		id,
		name: id,
		isMain: true,
		tracks: [],
		bookmarks,
		markers: [],
		createdAt: new Date(),
		updatedAt: new Date(),
	};
}

function makeEditor(): FakeEditor {
	let activeProject: TProject | null = makeProject();

	const editor = {} as FakeEditor;
	(editor as unknown as { command: CommandManager }).command =
		new CommandManager();
	(editor as unknown as { project: FakeProject }).project = {
		getActive: () => activeProject,
		setActiveProject: ({ project }) => {
			activeProject = project;
		},
	};
	(editor as unknown as { scenes: ScenesManager }).scenes =
		new ScenesManagerClass(editor);

	(
		EditorCoreClass as unknown as { getInstance: () => EditorCore }
	).getInstance = () => editor;

	return editor;
}

describe("ToggleBookmarkCommand", () => {
	test("execute adds a bookmark; undo removes it again", () => {
		const editor = makeEditor();
		editor.scenes.setScenes({
			scenes: [scene({ id: "main" })],
			activeSceneId: "main",
		});

		const command = new ToggleBookmarkCommand(2);
		editor.command.execute({ command });

		expect(editor.scenes.getScenes()[0].bookmarks).toHaveLength(1);
		expect(editor.command.getHistoryLength()).toBe(1);

		editor.command.undo();
		expect(editor.scenes.getScenes()[0].bookmarks).toHaveLength(0);
	});

	test("toggling twice (two separate commands) removes an existing bookmark; undo restores it", () => {
		const editor = makeEditor();
		editor.scenes.setScenes({
			scenes: [scene({ id: "main" })],
			activeSceneId: "main",
		});

		editor.command.execute({ command: new ToggleBookmarkCommand(2) });
		expect(editor.scenes.getScenes()[0].bookmarks).toHaveLength(1);

		editor.command.execute({ command: new ToggleBookmarkCommand(2) });
		expect(editor.scenes.getScenes()[0].bookmarks).toHaveLength(0);

		editor.command.undo();
		expect(editor.scenes.getScenes()[0].bookmarks).toHaveLength(1);

		editor.command.undo();
		expect(editor.scenes.getScenes()[0].bookmarks).toHaveLength(0);
	});

	test("redo re-applies the toggle; undo after redo restores prior state", () => {
		const editor = makeEditor();
		editor.scenes.setScenes({
			scenes: [scene({ id: "main" })],
			activeSceneId: "main",
		});

		const command = new ToggleBookmarkCommand(2);
		editor.command.execute({ command });
		editor.command.undo();
		editor.command.redo();

		expect(editor.scenes.getScenes()[0].bookmarks).toHaveLength(1);

		editor.command.undo();
		expect(editor.scenes.getScenes()[0].bookmarks).toHaveLength(0);
	});
});

describe("MoveBookmarkCommand", () => {
	test("execute -> undo restores the exact original bookmark time", () => {
		const editor = makeEditor();
		editor.scenes.setScenes({
			scenes: [scene({ id: "main", bookmarks: [{ time: 2 }] })],
			activeSceneId: "main",
		});

		const command = new MoveBookmarkCommand(2, 5);
		editor.command.execute({ command });

		expect(editor.scenes.getScenes()[0].bookmarks).toEqual([{ time: 5 }]);
		expect(editor.command.getHistoryLength()).toBe(1);

		editor.command.undo();
		expect(editor.scenes.getScenes()[0].bookmarks).toEqual([{ time: 2 }]);
	});

	test("moving a nonexistent bookmark is a safe no-op", () => {
		const editor = makeEditor();
		editor.scenes.setScenes({
			scenes: [scene({ id: "main", bookmarks: [{ time: 2 }] })],
			activeSceneId: "main",
		});

		const command = new MoveBookmarkCommand(9, 5);
		editor.command.execute({ command });

		expect(editor.scenes.getScenes()[0].bookmarks).toEqual([{ time: 2 }]);
	});
});

describe("UpdateBookmarkCommand", () => {
	test("execute -> undo restores the exact original bookmark fields", () => {
		const editor = makeEditor();
		editor.scenes.setScenes({
			scenes: [
				scene({
					id: "main",
					bookmarks: [{ time: 2, note: "original", color: "red" }],
				}),
			],
			activeSceneId: "main",
		});

		const command = new UpdateBookmarkCommand(2, { note: "updated" });
		editor.command.execute({ command });

		expect(editor.scenes.getScenes()[0].bookmarks).toEqual([
			{ time: 2, note: "updated", color: "red" },
		]);

		editor.command.undo();
		expect(editor.scenes.getScenes()[0].bookmarks).toEqual([
			{ time: 2, note: "original", color: "red" },
		]);
	});
});

describe("RemoveBookmarkCommand", () => {
	test("execute -> undo restores the removed bookmark", () => {
		const editor = makeEditor();
		editor.scenes.setScenes({
			scenes: [
				scene({
					id: "main",
					bookmarks: [{ time: 2, note: "keepme" }],
				}),
			],
			activeSceneId: "main",
		});

		const command = new RemoveBookmarkCommand(2);
		editor.command.execute({ command });

		expect(editor.scenes.getScenes()[0].bookmarks).toEqual([]);
		expect(editor.command.getHistoryLength()).toBe(1);

		editor.command.undo();
		expect(editor.scenes.getScenes()[0].bookmarks).toEqual([
			{ time: 2, note: "keepme" },
		]);
	});

	test("removing a nonexistent bookmark is a safe no-op that doesn't corrupt the undo stack", () => {
		const editor = makeEditor();
		editor.scenes.setScenes({
			scenes: [scene({ id: "main", bookmarks: [{ time: 2 }] })],
			activeSceneId: "main",
		});

		const command = new RemoveBookmarkCommand(9);
		editor.command.execute({ command });

		expect(editor.scenes.getScenes()[0].bookmarks).toEqual([{ time: 2 }]);

		editor.command.undo();
		expect(editor.scenes.getScenes()[0].bookmarks).toEqual([{ time: 2 }]);
	});
});

import { afterEach, describe, expect, mock, test } from "bun:test";
import { CommandManager } from "@/core/managers/commands";
import type { EditorCore } from "@/core";
import type { ScenesManager } from "@/core/managers/scenes-manager";
import type { TProject } from "@/types/project";
import type { TScene } from "@/types/timeline";

/** Same harness/mock idiom as `create-scene.test.ts` — see that file's header. */
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
const { RenameSceneCommand } = await import(
	"@/lib/commands/scene/rename-scene"
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

function scene({ id, name }: { id: string; name: string }): TScene {
	return {
		id,
		name,
		isMain: true,
		tracks: [],
		bookmarks: [],
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

describe("RenameSceneCommand", () => {
	test("execute -> undo restores the exact previous name", () => {
		const editor = makeEditor();
		editor.scenes.setScenes({
			scenes: [scene({ id: "main", name: "Original" })],
			activeSceneId: "main",
		});

		const command = new RenameSceneCommand("main", "Renamed");
		editor.command.execute({ command });

		expect(editor.scenes.getScenes()[0].name).toBe("Renamed");
		expect(editor.command.getHistoryLength()).toBe(1);

		editor.command.undo();

		expect(editor.scenes.getScenes()[0].name).toBe("Original");
	});

	test("redo re-applies the new name; undo after redo restores the original again", () => {
		const editor = makeEditor();
		editor.scenes.setScenes({
			scenes: [scene({ id: "main", name: "Original" })],
			activeSceneId: "main",
		});

		const command = new RenameSceneCommand("main", "Renamed");
		editor.command.execute({ command });
		editor.command.undo();
		editor.command.redo();

		expect(editor.scenes.getScenes()[0].name).toBe("Renamed");

		editor.command.undo();
		expect(editor.scenes.getScenes()[0].name).toBe("Original");
	});

	test("renaming a nonexistent scene is a safe no-op", () => {
		const editor = makeEditor();
		editor.scenes.setScenes({
			scenes: [scene({ id: "main", name: "Original" })],
			activeSceneId: "main",
		});

		const command = new RenameSceneCommand("does-not-exist", "Renamed");
		editor.command.execute({ command });

		expect(editor.scenes.getScenes()[0].name).toBe("Original");
	});
});

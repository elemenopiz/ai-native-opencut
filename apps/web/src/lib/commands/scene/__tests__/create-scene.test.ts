import { afterEach, describe, expect, mock, test } from "bun:test";
import { CommandManager } from "@/core/managers/commands";
import type { EditorCore } from "@/core";
import type { ScenesManager } from "@/core/managers/scenes-manager";
import type { TProject } from "@/types/project";

/**
 * `CreateSceneCommand` property tests, including BUG107: `execute()` used to
 * call `buildDefaultScene(...)`, which mints its OWN fresh UUID internally —
 * so every re-execute (including `redo()`, which just re-runs `execute()`)
 * produced a scene with a DIFFERENT id than the one the FIRST execute()
 * created. `getSceneId()` (the only way a caller learns the new scene's id)
 * is called once, right after the original execute() — so an
 * execute→undo→redo cycle would silently leave that captured id pointing at
 * nothing, while a DIFFERENT scene (new random id) is what's actually live.
 * Fixed by generating the id once in the constructor (same shape as
 * `AddMediaAssetCommand.assetId`) and reusing it across every execute().
 *
 * Same fake-EditorCore harness idiom as `media/__tests__/remove-media-asset.test.ts`:
 * mock the `@/services/proxy` barrel BEFORE dynamically importing `@/core`
 * (which statically imports `MediaManager`, which reaches the proxy barrel)
 * so this file stays mock-friendly for other files in the same `bun test`
 * run — this file doesn't touch media at all, but `@/core`'s import graph
 * still passes through it.
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
const { CreateSceneCommand } = await import(
	"@/lib/commands/scene/create-scene"
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

/** Wires a REAL `ScenesManager` (like `MediaManagerClass` in the media
 * reference test) against a fake `project` surface — `ScenesManager.setScenes`
 * only touches `editor.project.getActive()`/`setActiveProject()`, nothing
 * heavier. */
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

describe("CreateSceneCommand", () => {
	test("execute -> undo restores the pre-create scene list exactly", () => {
		const editor = makeEditor();
		editor.scenes.setScenes({ scenes: [] });

		const command = new CreateSceneCommand("Scene 1", false);
		editor.command.execute({ command });

		expect(editor.scenes.getScenes().map((s) => s.name)).toEqual(["Scene 1"]);
		expect(editor.command.getHistoryLength()).toBe(1);

		editor.command.undo();

		expect(editor.scenes.getScenes()).toEqual([]);
	});

	test("BUG107: execute -> undo -> redo produces the SAME scene id as the original execute (redo doesn't mint a new one)", () => {
		const editor = makeEditor();
		editor.scenes.setScenes({ scenes: [] });

		const command = new CreateSceneCommand("Scene 1", false);
		editor.command.execute({ command });

		const idAfterFirstExecute = command.getSceneId();
		expect(editor.scenes.getScenes()[0].id).toBe(idAfterFirstExecute);

		editor.command.undo();
		editor.command.redo();

		expect(command.getSceneId()).toBe(idAfterFirstExecute);
		expect(editor.scenes.getScenes()).toHaveLength(1);
		expect(editor.scenes.getScenes()[0].id).toBe(idAfterFirstExecute);
	});

	test("undo after redo restores the identical scene (round-trip identity)", () => {
		const editor = makeEditor();
		editor.scenes.setScenes({ scenes: [] });

		const command = new CreateSceneCommand("Scene 1", false);
		editor.command.execute({ command });
		editor.command.undo();
		editor.command.redo();
		editor.command.undo();

		expect(editor.scenes.getScenes()).toEqual([]);
	});

	test("getSceneId() is stable even before execute() runs (constructor-generated)", () => {
		const command = new CreateSceneCommand("Scene 1", false);
		const idBeforeExecute = command.getSceneId();
		expect(idBeforeExecute).toBeTruthy();

		const editor = makeEditor();
		editor.scenes.setScenes({ scenes: [] });
		editor.command.execute({ command });

		expect(command.getSceneId()).toBe(idBeforeExecute);
	});

	test("creating a second scene alongside an existing one preserves the existing scene untouched", () => {
		const editor = makeEditor();
		editor.scenes.setScenes({
			scenes: [
				{
					id: "existing",
					name: "Existing",
					isMain: true,
					tracks: [],
					bookmarks: [],
					markers: [],
					createdAt: new Date(),
					updatedAt: new Date(),
				},
			],
		});

		const command = new CreateSceneCommand("Scene 2", false);
		editor.command.execute({ command });

		expect(editor.scenes.getScenes().map((s) => s.id)).toEqual([
			"existing",
			command.getSceneId(),
		]);

		editor.command.undo();

		expect(editor.scenes.getScenes().map((s) => s.id)).toEqual(["existing"]);
	});
});

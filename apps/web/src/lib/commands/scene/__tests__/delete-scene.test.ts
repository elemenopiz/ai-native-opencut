import { afterEach, describe, expect, mock, test } from "bun:test";
import { CommandManager } from "@/core/managers/commands";
import type { EditorCore } from "@/core";
import type { ScenesManager } from "@/core/managers/scenes-manager";
import type { TProject } from "@/types/project";
import type { TScene } from "@/types/timeline";

/**
 * `DeleteSceneCommand` property tests. Unlike `CreateSceneCommand`, this
 * command already captures `savedActiveSceneId` before mutating and restores
 * it on undo — these tests lock in that cross-store (active-scene-pointer)
 * restoration behavior so it can't silently regress, and cover the
 * single-entry / redo-idempotency contract from the campaign plan.
 *
 * Same harness/mock idiom as `create-scene.test.ts` — see that file's header.
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
const { DeleteSceneCommand } = await import(
	"@/lib/commands/scene/delete-scene"
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

function scene({ id, isMain }: { id: string; isMain: boolean }): TScene {
	return {
		id,
		name: id,
		isMain,
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

describe("DeleteSceneCommand", () => {
	test("execute -> undo restores the deleted scene AND the exact pre-delete active-scene pointer", () => {
		const editor = makeEditor();
		const main = scene({ id: "main", isMain: true });
		const secondary = scene({ id: "secondary", isMain: false });
		editor.scenes.setScenes({
			scenes: [main, secondary],
			activeSceneId: "secondary",
		});
		expect(editor.scenes.getActiveScene().id).toBe("secondary");

		const command = new DeleteSceneCommand("secondary");
		editor.command.execute({ command });

		// Active scene falls back to main once the active scene is gone.
		expect(editor.scenes.getScenes().map((s) => s.id)).toEqual(["main"]);
		expect(editor.scenes.getActiveScene().id).toBe("main");
		expect(editor.command.getHistoryLength()).toBe(1);

		editor.command.undo();

		expect(editor.scenes.getScenes().map((s) => s.id)).toEqual([
			"main",
			"secondary",
		]);
		// The active-scene pointer is restored to what it was BEFORE delete,
		// not left on the post-delete fallback (main).
		expect(editor.scenes.getActiveScene().id).toBe("secondary");
	});

	test("deleting a non-active scene leaves the active-scene pointer untouched, and undo keeps it untouched", () => {
		const editor = makeEditor();
		const main = scene({ id: "main", isMain: true });
		const secondary = scene({ id: "secondary", isMain: false });
		editor.scenes.setScenes({
			scenes: [main, secondary],
			activeSceneId: "main",
		});

		const command = new DeleteSceneCommand("secondary");
		editor.command.execute({ command });

		expect(editor.scenes.getActiveScene().id).toBe("main");

		editor.command.undo();

		expect(editor.scenes.getActiveScene().id).toBe("main");
		expect(
			editor.scenes
				.getScenes()
				.map((s) => s.id)
				.sort(),
		).toEqual(["main", "secondary"]);
	});

	test("redo deletes the scene again; undo after redo restores it again with the correct active pointer", () => {
		const editor = makeEditor();
		const main = scene({ id: "main", isMain: true });
		const secondary = scene({ id: "secondary", isMain: false });
		editor.scenes.setScenes({
			scenes: [main, secondary],
			activeSceneId: "secondary",
		});

		const command = new DeleteSceneCommand("secondary");
		editor.command.execute({ command });
		editor.command.undo();
		editor.command.redo();

		expect(editor.scenes.getScenes().map((s) => s.id)).toEqual(["main"]);
		expect(editor.scenes.getActiveScene().id).toBe("main");

		editor.command.undo();

		expect(editor.scenes.getScenes().map((s) => s.id)).toEqual([
			"main",
			"secondary",
		]);
		expect(editor.scenes.getActiveScene().id).toBe("secondary");
	});

	test("cannot delete the main scene: execute() is a safe no-op, no history corruption", () => {
		const editor = makeEditor();
		const main = scene({ id: "main", isMain: true });
		editor.scenes.setScenes({ scenes: [main], activeSceneId: "main" });

		const command = new DeleteSceneCommand("main");
		editor.command.execute({ command });

		expect(editor.scenes.getScenes().map((s) => s.id)).toEqual(["main"]);

		editor.command.undo();
		expect(editor.scenes.getScenes().map((s) => s.id)).toEqual(["main"]);
	});
});

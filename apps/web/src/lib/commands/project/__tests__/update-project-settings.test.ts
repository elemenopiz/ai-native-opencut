import { afterEach, describe, expect, mock, test } from "bun:test";
import { CommandManager } from "@/core/managers/commands";
import type { EditorCore } from "@/core";
import type { TProject } from "@/types/project";

/** Same harness/mock idiom as `scene/__tests__/create-scene.test.ts` — see
 * that file's header for the mock.module ordering rationale. */
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
const { UpdateProjectSettingsCommand } = await import(
	"@/lib/commands/project/update-project-settings"
);

interface FakeProject {
	getActive: () => TProject | null;
	setActiveProject: (args: { project: TProject }) => void;
}
interface FakeSave {
	markDirty: () => void;
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

function makeEditor(): { editor: FakeEditor } {
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
	(editor as unknown as { save: FakeSave }).save = {
		markDirty: () => undefined,
	};

	(
		EditorCoreClass as unknown as { getInstance: () => EditorCore }
	).getInstance = () => editor;

	return { editor };
}

describe("UpdateProjectSettingsCommand", () => {
	test("execute -> undo restores the exact previous settings (fps + canvasSize)", () => {
		const { editor } = makeEditor();

		const command = new UpdateProjectSettingsCommand({
			fps: 60,
			canvasSize: { width: 1080, height: 1920 },
		});
		editor.command.execute({ command });

		expect(editor.project.getActive().settings.fps).toBe(60);
		expect(editor.project.getActive().settings.canvasSize).toEqual({
			width: 1080,
			height: 1920,
		});
		expect(editor.command.getHistoryLength()).toBe(1);

		editor.command.undo();

		expect(editor.project.getActive().settings.fps).toBe(30);
		expect(editor.project.getActive().settings.canvasSize).toEqual({
			width: 1920,
			height: 1080,
		});
	});

	test("undo restores metadata.updatedAt to the exact pre-execute timestamp", () => {
		const { editor } = makeEditor();
		// Pinned to the past so it's unambiguously distinct from whatever
		// `new Date()` produces during execute(), regardless of clock
		// resolution/timing in the test runner.
		const before = new Date("2020-01-01T00:00:00.000Z");
		editor.project.setActiveProject({
			project: {
				...editor.project.getActive(),
				metadata: { ...editor.project.getActive().metadata, updatedAt: before },
			},
		});

		editor.command.execute({
			command: new UpdateProjectSettingsCommand({ fps: 24 }),
		});
		expect(editor.project.getActive().metadata.updatedAt).not.toEqual(before);

		editor.command.undo();
		expect(editor.project.getActive().metadata.updatedAt).toEqual(before);
	});

	test("redo re-applies the new settings; undo after redo restores the original again", () => {
		const { editor } = makeEditor();

		const command = new UpdateProjectSettingsCommand({ fps: 24 });
		editor.command.execute({ command });
		editor.command.undo();
		editor.command.redo();

		expect(editor.project.getActive().settings.fps).toBe(24);

		editor.command.undo();
		expect(editor.project.getActive().settings.fps).toBe(30);
	});

	test("partial update only touches the given keys, leaving the rest of settings untouched", () => {
		const { editor } = makeEditor();

		editor.command.execute({
			command: new UpdateProjectSettingsCommand({ fps: 24 }),
		});

		expect(editor.project.getActive().settings.canvasSize).toEqual({
			width: 1920,
			height: 1080,
		});
		expect(editor.project.getActive().settings.background).toEqual({
			type: "color",
			color: "#000000",
		});
	});
});

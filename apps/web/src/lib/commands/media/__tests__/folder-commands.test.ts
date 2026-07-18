import { afterEach, describe, expect, mock, test } from "bun:test";
import { CommandManager } from "@/core/managers/commands";
import type { EditorCore } from "@/core";
import type { MediaAsset, MediaFolder } from "@/types/assets";
import type { TProject } from "@/types/project";

/**
 * Campaign C33: client-side folder MODEL + persistence + undo commands for
 * organizing media assets. Exercises the four new commands
 * (Create/Rename/Delete/MoveAssetToFolder) at the real production seam — a
 * fake `EditorCore.getInstance()` wired up with REAL `CommandManager`,
 * `MediaManager`, and `ProjectManager` instances (only `save.markDirty` and
 * the initial active project are faked), so `editor.command.execute(...)`
 * walks the exact path a real caller would.
 *
 * Order-dependence note: `EditorCore` / `MediaManager` / the folder commands
 * all transitively import `@/core/managers/media-manager`, which statically
 * imports the real `@/services/proxy` barrel (chaining into
 * proxy-encoder-controller.ts -> proxy-generator.ts). Mock the barrel FIRST,
 * then import everything that reaches it dynamically — mirrors the
 * convention already used in remove-media-asset.test.ts /
 * project-manager-bible-notify.test.ts.
 */
mock.module("@/services/proxy", () => ({
	generateProxyOffThread: async () => ({
		file: new File([new Uint8Array([1])], "proxy.mp4", { type: "video/mp4" }),
		width: 1280,
		height: 720,
	}),
	// media-manager statically imports this alongside generateProxyOffThread;
	// the mock must re-export it or the ESM binding fails at import time.
	isProxyCancelledError: (error: unknown) =>
		error instanceof Error &&
		(error.message === "Proxy generation cancelled" ||
			error.name === "AbortError"),
}));

const { EditorCore: EditorCoreClass } = await import("@/core");
const { MediaManager: MediaManagerClass } = await import(
	"@/core/managers/media-manager"
);
const { ProjectManager: ProjectManagerClass } = await import(
	"@/core/managers/project-manager"
);
const {
	CreateFolderCommand,
	RenameFolderCommand,
	DeleteFolderCommand,
	MoveAssetToFolderCommand,
} = await import("@/lib/commands/media");

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

function baseProject(): TProject {
	return {
		metadata: {
			id: "p1",
			name: "Test",
			duration: 0,
			createdAt: new Date(),
			updatedAt: new Date(),
		},
		scenes: [],
		currentSceneId: "s1",
		settings: {} as TProject["settings"],
		version: 1,
	} as TProject;
}

function videoAsset(id: string, folderId?: string): MediaAsset {
	return {
		id,
		name: `${id}.mp4`,
		type: "video",
		file: new File([new Uint8Array([1])], `${id}.mp4`),
		folderId,
	} as MediaAsset;
}

/** Builds a fake editor wired the same way the real EditorCore wires itself:
 * `editor.media`/`editor.project` are REAL manager instances constructed
 * with THIS editor, so command mutations land back on the exact instances
 * the test drives. `editor.save.markDirty` is a spy so folder-list writes'
 * persistence contract (mirrors `directorBrief`) is directly observable. */
function makeEditor(): {
	editor: EditorCore;
	markDirtyCalls: () => number;
} {
	let markDirtyCount = 0;

	const editor = {} as EditorCore;
	(editor as unknown as { command: CommandManager }).command =
		new CommandManager();
	(editor as unknown as { save: { markDirty: () => void } }).save = {
		markDirty: () => {
			markDirtyCount += 1;
		},
	};
	(editor as unknown as { media: MediaManager }).media = new MediaManagerClass(
		editor,
	);
	(editor as unknown as { project: ProjectManager }).project =
		new ProjectManagerClass(editor);
	(
		editor as unknown as { project: InstanceType<typeof ProjectManagerClass> }
	).project.setActiveProject({ project: baseProject() });

	(
		EditorCoreClass as unknown as { getInstance: () => EditorCore }
	).getInstance = () => editor;

	return { editor, markDirtyCalls: () => markDirtyCount };
}

type MediaManager = InstanceType<typeof MediaManagerClass>;
type ProjectManager = InstanceType<typeof ProjectManagerClass>;

describe("CreateFolderCommand", () => {
	test("execute adds a folder; undo removes it; single history entry", () => {
		const { editor, markDirtyCalls } = makeEditor();

		const command = new CreateFolderCommand("p1", {
			name: "B-Roll",
			parentId: null,
		});
		editor.command.execute({ command });

		expect(editor.command.getHistoryLength()).toBe(1);
		const folders = editor.project.getMediaFolders();
		expect(folders).toHaveLength(1);
		expect(folders[0]).toEqual({
			id: command.getFolderId(),
			name: "B-Roll",
			parentId: null,
		});
		expect(markDirtyCalls()).toBeGreaterThan(0);

		editor.command.undo();
		expect(editor.project.getMediaFolders()).toEqual([]);
	});

	test("redo re-creates the same folder id", () => {
		const { editor } = makeEditor();
		const command = new CreateFolderCommand("p1", {
			name: "Drone",
			parentId: null,
		});
		editor.command.execute({ command });
		const id = command.getFolderId();

		editor.command.undo();
		editor.command.redo();

		expect(editor.project.getMediaFolders().map((f) => f.id)).toEqual([id]);
	});
});

describe("RenameFolderCommand", () => {
	test("execute renames; undo restores the prior name", () => {
		const { editor } = makeEditor();
		const create = new CreateFolderCommand("p1", {
			name: "Old Name",
			parentId: null,
		});
		editor.command.execute({ command: create });
		const folderId = create.getFolderId();

		const rename = new RenameFolderCommand("p1", folderId, "New Name");
		editor.command.execute({ command: rename });

		expect(editor.project.getMediaFolders()[0].name).toBe("New Name");

		editor.command.undo();
		expect(editor.project.getMediaFolders()[0].name).toBe("Old Name");
	});

	test("missing folder is a safe no-op on undo", () => {
		const { editor } = makeEditor();
		const rename = new RenameFolderCommand("p1", "does-not-exist", "X");
		editor.command.execute({ command: rename });

		expect(editor.project.getMediaFolders()).toEqual([]);
		editor.command.undo();
		expect(editor.project.getMediaFolders()).toEqual([]);
	});
});

describe("MoveAssetToFolderCommand", () => {
	test("execute sets folderId; undo restores the prior (root) membership", () => {
		const { editor } = makeEditor();
		editor.media.setAssets({ assets: [videoAsset("m1")] });
		const create = new CreateFolderCommand("p1", {
			name: "Interviews",
			parentId: null,
		});
		editor.command.execute({ command: create });
		const folderId = create.getFolderId();

		const move = new MoveAssetToFolderCommand("p1", "m1", folderId);
		editor.command.execute({ command: move });

		expect(editor.media.getAssetById("m1")?.folderId).toBe(folderId);

		editor.command.undo();
		expect(editor.media.getAssetById("m1")?.folderId).toBeUndefined();
	});

	test("undo restores a PRIOR (non-root) folder, not just root", () => {
		const { editor } = makeEditor();
		editor.media.setAssets({ assets: [videoAsset("m1", "folder-a")] });

		const move = new MoveAssetToFolderCommand("p1", "m1", "folder-b");
		editor.command.execute({ command: move });
		expect(editor.media.getAssetById("m1")?.folderId).toBe("folder-b");

		editor.command.undo();
		expect(editor.media.getAssetById("m1")?.folderId).toBe("folder-a");
	});

	test("move to root (null) clears folderId; undo restores prior folder", () => {
		const { editor } = makeEditor();
		editor.media.setAssets({ assets: [videoAsset("m1", "folder-a")] });

		const move = new MoveAssetToFolderCommand("p1", "m1", null);
		editor.command.execute({ command: move });
		expect(editor.media.getAssetById("m1")?.folderId).toBeUndefined();

		editor.command.undo();
		expect(editor.media.getAssetById("m1")?.folderId).toBe("folder-a");
	});

	test("missing asset is a safe no-op on undo", () => {
		const { editor } = makeEditor();
		editor.media.setAssets({ assets: [] });

		const move = new MoveAssetToFolderCommand("p1", "does-not-exist", "f1");
		editor.command.execute({ command: move });
		editor.command.undo();

		expect(editor.media.getAssets()).toEqual([]);
	});
});

describe("DeleteFolderCommand", () => {
	function seedTree(editor: EditorCore): {
		parentId: string;
		childId: string;
	} {
		const parent = new CreateFolderCommand("p1", {
			name: "Parent",
			parentId: null,
		});
		editor.command.execute({ command: parent });
		const parentId = parent.getFolderId();

		const child = new CreateFolderCommand("p1", {
			name: "Child",
			parentId,
		});
		editor.command.execute({ command: child });
		const childId = child.getFolderId();

		editor.media.setAssets({
			assets: [videoAsset("m1", parentId), videoAsset("m2")],
		});

		return { parentId, childId };
	}

	test("execute moves contained assets to root and reparents child folders", () => {
		const { editor } = makeEditor();
		const { parentId, childId } = seedTree(editor);

		const del = new DeleteFolderCommand("p1", parentId);
		editor.command.execute({ command: del });

		const folders = editor.project.getMediaFolders();
		expect(folders.map((f) => f.id)).toEqual([childId]);
		expect(folders[0].parentId).toBeNull();

		expect(editor.media.getAssetById("m1")?.folderId).toBeUndefined();
		expect(editor.media.getAssetById("m2")?.folderId).toBeUndefined();
	});

	test("undo restores the folder list AND every moved asset's exact prior membership", () => {
		const { editor } = makeEditor();
		const { parentId, childId } = seedTree(editor);

		const del = new DeleteFolderCommand("p1", parentId);
		editor.command.execute({ command: del });
		editor.command.undo();

		const folders = editor.project.getMediaFolders();
		expect(folders.map((f) => f.id).sort()).toEqual([childId, parentId].sort());
		const restoredChild = folders.find((f) => f.id === childId) as MediaFolder;
		expect(restoredChild.parentId).toBe(parentId);

		expect(editor.media.getAssetById("m1")?.folderId).toBe(parentId);
		expect(editor.media.getAssetById("m2")?.folderId).toBeUndefined();
	});

	test("deleting a root folder reparents children to root (null), not left dangling", () => {
		const { editor } = makeEditor();
		const { parentId, childId } = seedTree(editor);

		editor.command.execute({
			command: new DeleteFolderCommand("p1", parentId),
		});

		const child = editor.project
			.getMediaFolders()
			.find((f) => f.id === childId) as MediaFolder;
		expect(child.parentId).toBeNull();
	});

	test("single history entry per delete", () => {
		const { editor } = makeEditor();
		const { parentId } = seedTree(editor);
		expect(editor.command.getHistoryLength()).toBe(2); // two CreateFolderCommand entries

		editor.command.execute({
			command: new DeleteFolderCommand("p1", parentId),
		});
		expect(editor.command.getHistoryLength()).toBe(3);
	});

	test("missing folder is a safe no-op", () => {
		const { editor } = makeEditor();
		editor.command.execute({
			command: new DeleteFolderCommand("p1", "does-not-exist"),
		});
		expect(editor.project.getMediaFolders()).toEqual([]);
		editor.command.undo();
		expect(editor.project.getMediaFolders()).toEqual([]);
	});
});

describe("ProjectManager folder-list persistence", () => {
	test("getMediaFolders/setMediaFolders round-trip and call markDirty", () => {
		const { editor, markDirtyCalls } = makeEditor();
		expect(editor.project.getMediaFolders()).toEqual([]);

		const before = markDirtyCalls();
		const folder: MediaFolder = { id: "f1", name: "Clips", parentId: null };
		editor.project.setMediaFolders({ folders: [folder] });

		expect(editor.project.getMediaFolders()).toEqual([folder]);
		expect(markDirtyCalls()).toBe(before + 1);
	});

	test("setMediaFolders no-ops without an active project", () => {
		const editor = {} as EditorCore;
		let markDirtyCount = 0;
		(editor as unknown as { save: { markDirty: () => void } }).save = {
			markDirty: () => {
				markDirtyCount += 1;
			},
		};
		const pm = new ProjectManagerClass(editor);
		pm.setMediaFolders({ folders: [{ id: "f1", name: "X", parentId: null }] });
		expect(pm.getMediaFolders()).toEqual([]);
		expect(markDirtyCount).toBe(0);
	});
});

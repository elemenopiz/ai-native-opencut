import { afterEach, describe, expect, it, mock } from "bun:test";
import { EditorCore } from "@/core";
import { CommandManager } from "@/core/managers/commands";
import type { MediaAsset } from "@/types/assets";

/**
 * Media deletion must clean up EVERY per-asset index layer: CLIP embeddings,
 * speech transcripts, and Understanding Pass records (the last was leaking —
 * rows lived in byorn-asset-understanding forever). The cross-project
 * user-media memory is deliberately NOT touched: it's keyed by content hash so
 * the next project can reuse the paid understanding after this asset is gone.
 *
 * Store mocks mirror each store's FULL export surface — bun's mock.module
 * leaks across test files in one process, so any export another file touches
 * must exist here too. storageService is NOT mocked (service.test.ts tests the
 * real one); media-manager's own try/catch absorbs its headless failures.
 *
 * BUG34: `removeMediaAsset` now runs the whole delete cascade through
 * `RemoveMediaAssetCommand`, which reaches for `EditorCore.getInstance()`
 * internally (the idiom every command in the codebase uses — see
 * `remove-media-asset.test.ts` for the full undo/redo round-trip coverage).
 * `makeEditor()` below mirrors the real EditorCore wiring: `editor.media` IS
 * the exact MediaManager instance under test, and `EditorCore.getInstance` is
 * monkey-patched to return this fake editor for the duration of each test.
 */

const deletedEmbeddings: string[] = [];
mock.module("@/services/search/embedding-store", () => ({
	getEmbedding: async () => undefined,
	getAllEmbeddings: async () => [],
	saveEmbedding: async () => {},
	deleteEmbedding: async (mediaId: string) => {
		deletedEmbeddings.push(mediaId);
	},
	clearAllEmbeddings: async () => {},
	listIndexedMediaIds: async () => [],
	setStatus: async () => {},
	getStatus: async () => undefined,
	getAllStatuses: async () => [],
	getIndexedCount: async () => 0,
}));

const deletedTranscripts: string[] = [];
mock.module("@/services/search/asset-transcript-store", () => ({
	saveTranscript: async () => {},
	getTranscript: async () => undefined,
	getAllTranscripts: async () => [],
	deleteTranscript: async (mediaId: string) => {
		deletedTranscripts.push(mediaId);
	},
	clearAllTranscripts: async () => {},
}));

const deletedUnderstandings: string[] = [];
mock.module("@/services/search/asset-understanding-store", () => ({
	saveUnderstanding: async () => {},
	getUnderstanding: async () => undefined,
	getAllUnderstandings: async () => [],
	deleteUnderstanding: async (mediaId: string) => {
		deletedUnderstandings.push(mediaId);
	},
	clearAllUnderstandings: async () => {},
	listUnderstoodMediaIds: async () => [],
	confirmRole: async () => undefined,
	clearRoleConfirmation: async () => undefined,
	reinforceRole: async () => undefined,
}));

// The cross-project memory must stay untouched by deletion.
const userMemoryCalls: string[] = [];
mock.module("@/services/storage/user-memory-store", () => ({
	getUserMediaMemory: async () => undefined,
	saveUserMediaMemory: async () => {},
	deleteUserMediaMemory: async (hash: string) => {
		userMemoryCalls.push(hash);
	},
	clearAllUserMediaMemory: async () => {},
	listUserMediaMemory: async () => [],
}));

// Import AFTER the mocks so the manager binds the stubs (repo convention).
const { MediaManager } = await import("@/core/managers/media-manager");

const originalGetInstance = EditorCore.getInstance;

afterEach(() => {
	(
		EditorCore as unknown as { getInstance: typeof EditorCore.getInstance }
	).getInstance = originalGetInstance;
});

/**
 * Wires a fake editor exactly the way the real EditorCore singleton wires
 * itself: `editor.media` IS the MediaManager instance the test drives, so
 * `RemoveMediaAssetCommand` (which fetches `EditorCore.getInstance()`
 * internally) mutates the same manager `removeMediaAsset` was called on.
 */
function makeEditor(): {
	editor: EditorCore;
	manager: InstanceType<typeof MediaManager>;
} {
	const editor = {
		timeline: {
			getTracks: () => [],
			updateTracks: () => {},
		},
		selection: {
			getSelectedElements: () => [],
			setSelectedElements: () => {},
		},
		command: new CommandManager(),
	} as unknown as EditorCore;

	const manager = new MediaManager(editor);
	(editor as unknown as { media: typeof manager }).media = manager;

	(EditorCore as unknown as { getInstance: () => EditorCore }).getInstance =
		() => editor;

	return { editor, manager };
}

function asset(id: string): MediaAsset {
	return {
		id,
		name: `${id}.mp4`,
		type: "video",
		file: new File([new Uint8Array([1])], `${id}.mp4`),
	} as MediaAsset;
}

/** Fire-and-forget deletes settle on the microtask queue; flush it. */
const flush = () => new Promise((r) => setTimeout(r, 0));

function resetSpies() {
	deletedEmbeddings.length = 0;
	deletedTranscripts.length = 0;
	deletedUnderstandings.length = 0;
	userMemoryCalls.length = 0;
}

describe("media deletion cleans up every per-asset index layer", () => {
	it("removeMediaAsset drops the embedding, transcript, AND understanding rows", async () => {
		resetSpies();
		const { manager } = makeEditor();
		manager.setAssets({ assets: [asset("m1"), asset("m2")] });

		await manager.removeMediaAsset({ projectId: "p1", id: "m1" });
		await flush();

		expect(deletedEmbeddings).toEqual(["m1"]);
		expect(deletedTranscripts).toEqual(["m1"]);
		expect(deletedUnderstandings).toEqual(["m1"]);
		expect(manager.getAssets().map((a) => a.id)).toEqual(["m2"]);
		// Cross-project memory (content-hash keyed) survives asset deletion.
		expect(userMemoryCalls).toEqual([]);
	});

	it("clearProjectMedia drops all three layers for every asset", async () => {
		resetSpies();
		const { manager } = makeEditor();
		manager.setAssets({ assets: [asset("m1"), asset("m2")] });

		await manager.clearProjectMedia({ projectId: "p1" });
		await flush();

		expect(deletedEmbeddings.sort()).toEqual(["m1", "m2"]);
		expect(deletedTranscripts.sort()).toEqual(["m1", "m2"]);
		expect(deletedUnderstandings.sort()).toEqual(["m1", "m2"]);
		expect(manager.getAssets()).toEqual([]);
		expect(userMemoryCalls).toEqual([]);
	});

	it("clearAllAssets (project switch / unload) deletes NOTHING from the stores", async () => {
		resetSpies();
		const { manager } = makeEditor();
		manager.setAssets({ assets: [asset("m1")] });

		manager.clearAllAssets();
		await flush();

		expect(deletedEmbeddings).toEqual([]);
		expect(deletedTranscripts).toEqual([]);
		expect(deletedUnderstandings).toEqual([]);
	});
});

import { afterEach, describe, expect, mock, test } from "bun:test";
import { CommandManager } from "@/core/managers/commands";
import { DEFAULT_TRANSFORM } from "@/constants/timeline-constants";
import type { EditorCore } from "@/core";
import type { MediaManager } from "@/core/managers/media-manager";
import type { ScenesManager } from "@/core/managers/scenes-manager";
import type { MediaAsset } from "@/types/assets";
import type { TProject } from "@/types/project";
import type { TimelineTrack, VideoElement } from "@/types/timeline";

/**
 * Umbrella integration coverage for C27 Worker C's inventory (#34-44): media
 * + scene commands wired to a single fake `EditorCore` that has BOTH a real
 * `MediaManager` and a real `ScenesManager` (like each family's individual
 * test file, just combined so cross-family interactions — e.g. a transaction
 * spanning both — can be exercised). See `media/__tests__/remove-media-asset.test.ts`
 * for the mock.module ordering rationale this file reuses.
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
const { ScenesManager: ScenesManagerClass } = await import(
	"@/core/managers/scenes-manager"
);
const { RemoveMediaAssetCommand } = await import(
	"@/lib/commands/media/remove-media-asset"
);
const { CreateSceneCommand } = await import(
	"@/lib/commands/scene/create-scene"
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

function makeEditor({ tracks }: { tracks: TimelineTrack[] }): FakeEditor {
	let currentTracks = tracks;
	let selection: { trackId: string; elementId: string }[] = [];
	let activeProject: TProject | null = makeProject();

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
	(editor as unknown as { project: FakeProject }).project = {
		getActive: () => activeProject,
		setActiveProject: ({ project }) => {
			activeProject = project;
		},
	};
	(editor as unknown as { media: MediaManager }).media = new MediaManagerClass(
		editor,
	);
	(editor as unknown as { scenes: ScenesManager }).scenes =
		new ScenesManagerClass(editor);

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
}: {
	id: string;
	mediaId: string;
}): VideoElement {
	return {
		id,
		name: id,
		type: "video",
		mediaId,
		duration: 4,
		startTime: 0,
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

describe("undo-roundtrip: media + scene commands (C27 Worker C inventory #34-44)", () => {
	test("a transaction spanning a media command AND a scene command collapses into ONE history entry, and undo reverses both", () => {
		const clip = videoElement({ id: "el-1", mediaId: "m1" });
		const editor = makeEditor({
			tracks: [videoTrack({ id: "main", elements: [clip] })],
		});
		editor.media.setAssets({ assets: [videoAsset("m1")] });
		editor.scenes.setScenes({ scenes: [] });

		editor.command.beginTransaction({ name: "mixed batch" });
		const removeAsset = new RemoveMediaAssetCommand("p1", "m1");
		editor.command.execute({ command: removeAsset });
		const createScene = new CreateSceneCommand("New scene", false);
		editor.command.execute({ command: createScene });
		editor.command.commitTransaction();

		expect(editor.command.getHistoryLength()).toBe(1);
		expect(editor.media.getAssets()).toEqual([]);
		expect(editor.scenes.getScenes().map((s) => s.name)).toEqual(["New scene"]);

		editor.command.undo();

		expect(editor.media.getAssets().map((a) => a.id)).toEqual(["m1"]);
		expect(editor.scenes.getScenes()).toEqual([]);
		expect(editor.timeline.getTracks()[0].elements).toHaveLength(1);
	});

	test("sequential (non-transactional) media delete + scene create produce TWO independent history entries, each independently undoable", () => {
		const clip = videoElement({ id: "el-1", mediaId: "m1" });
		const editor = makeEditor({
			tracks: [videoTrack({ id: "main", elements: [clip] })],
		});
		editor.media.setAssets({ assets: [videoAsset("m1")] });
		editor.scenes.setScenes({ scenes: [] });

		editor.command.execute({
			command: new RemoveMediaAssetCommand("p1", "m1"),
		});
		editor.command.execute({
			command: new CreateSceneCommand("New scene", false),
		});

		expect(editor.command.getHistoryLength()).toBe(2);

		editor.command.undo();
		// Only the scene create is undone; the asset delete still stands.
		expect(editor.scenes.getScenes()).toEqual([]);
		expect(editor.media.getAssets()).toEqual([]);

		editor.command.undo();
		expect(editor.media.getAssets().map((a) => a.id)).toEqual(["m1"]);
	});

	test("every command in the inventory pushes exactly one history entry per dispatch (contract point 3)", () => {
		const clip = videoElement({ id: "el-1", mediaId: "m1" });
		const editor = makeEditor({
			tracks: [videoTrack({ id: "main", elements: [clip] })],
		});
		editor.media.setAssets({ assets: [videoAsset("m1")] });
		editor.scenes.setScenes({ scenes: [] });

		editor.command.execute({ command: new CreateSceneCommand("Scene A") });
		expect(editor.command.getHistoryLength()).toBe(1);

		editor.command.execute({
			command: new RemoveMediaAssetCommand("p1", "m1"),
		});
		expect(editor.command.getHistoryLength()).toBe(2);
	});
});

import { afterEach, describe, expect, mock, test } from "bun:test";
import { CommandManager } from "@/core/managers/commands";
import { DEFAULT_TRANSFORM } from "@/constants/timeline-constants";
import type { EditorCore } from "@/core";
import type { MediaAsset } from "@/types/assets";
import type { TProject, TProjectSettings } from "@/types/project";
import type {
	AudioElement,
	ImageElement,
	TimelineTrack,
	UploadAudioElement,
	VideoElement,
} from "@/types/timeline";

/**
 * C27 (undo/redo integrity, worker A — timeline element core): property tests
 * for all 14 `timeline/element/*` commands per the campaign contract
 * (`apps/web/docs/campaigns/undo-integrity.md`):
 *
 *   1. execute -> undo restores the pre-state exactly (deep-equal).
 *   2. execute -> undo -> redo -> undo returns to the SAME pre-state (redo
 *      re-snapshots correctly instead of replaying a stale capture).
 *   3. one dispatch through `editor.command.execute()` == exactly one
 *      history entry (no nested manager dispatch double-pushing — the BUG34
 *      class).
 *   4. cross-store side effects (selection, project settings) a command
 *      itself changes are restored on undo.
 *
 * Wired at the same real seam as `media/__tests__/remove-media-asset.test.ts`
 * — a fake `EditorCore.getInstance()` with a REAL `CommandManager` so
 * `getHistoryLength()` is meaningful, plus fake timeline/selection/media/
 * project/save surfaces implementing only what these commands touch.
 *
 * Order-dependence note (same as every other file in this directory):
 * `EditorCore` and the command modules both transitively import
 * `@/core/managers/media-manager`, which statically imports the real
 * `@/services/proxy` barrel. Mock it and import everything else dynamically
 * AFTER the mock so this file stays order-independent under `bun test`.
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
const {
	DeleteElementsCommand,
	DuplicateElementsCommand,
	InsertElementCommand,
	MoveElementCommand,
	MoveElementsCommand,
	ResizeElementsCommand,
	SplitElementsCommand,
	ToggleElementsMutedCommand,
	ToggleElementsVisibilityCommand,
	ToggleSourceAudioSeparationCommand,
	UpdateElementCommand,
	UpdateElementDurationCommand,
	UpdateElementStartTimeCommand,
	UpdateElementTrimCommand,
} = await import("@/lib/commands/timeline/element");

type ElementRef = { trackId: string; elementId: string };

interface FakeTimeline {
	getTracks: () => TimelineTrack[];
	updateTracks: (tracks: TimelineTrack[]) => void;
}
interface FakeSelection {
	getSelectedElements: () => ElementRef[];
	setSelectedElements: (args: { elements: ElementRef[] }) => void;
}
interface FakeMedia {
	getAssets: () => MediaAsset[];
}
interface FakeProject {
	getActive: () => TProject | undefined;
	setActiveProject: (args: { project: TProject }) => void;
	updateSettings: (args: {
		settings: Partial<TProjectSettings>;
		pushHistory?: boolean;
	}) => void;
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

function defaultProjectSettings(): TProjectSettings {
	return {
		fps: 30,
		canvasSize: { width: 1920, height: 1080 },
		background: { type: "color", color: "#000000" },
	};
}

function defaultProject(
	overrides: Partial<TProject> = {},
	settingsOverrides: Partial<TProjectSettings> = {},
): TProject {
	return {
		metadata: {
			id: "p1",
			name: "Project",
			duration: 0,
			createdAt: new Date("2026-01-01T00:00:00Z"),
			updatedAt: new Date("2026-01-01T00:00:00Z"),
		},
		scenes: [],
		currentSceneId: "scene-1",
		settings: { ...defaultProjectSettings(), ...settingsOverrides },
		version: 1,
		...overrides,
	};
}

/** Builds a fake editor wired the same way `remove-media-asset.test.ts` does:
 * a REAL `CommandManager` so history-length assertions are meaningful, plus
 * minimal fakes for every other surface these 14 commands touch. */
function makeEditor({
	tracks,
	assets = [],
	project,
}: {
	tracks: TimelineTrack[];
	assets?: MediaAsset[];
	project?: TProject;
}): FakeEditor {
	let currentTracks = tracks;
	let selection: ElementRef[] = [];
	let activeProject = project;

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
	(editor as unknown as { media: FakeMedia }).media = {
		getAssets: () => assets,
	};
	(editor as unknown as { project: FakeProject }).project = {
		getActive: () => activeProject,
		setActiveProject: ({ project: next }) => {
			activeProject = next;
		},
		updateSettings: () => undefined,
	};
	(editor as unknown as { save: FakeSave }).save = {
		markDirty: () => undefined,
	};

	(
		EditorCoreClass as unknown as { getInstance: () => EditorCore }
	).getInstance = () => editor;

	return editor;
}

function videoElement(overrides: Partial<VideoElement> = {}): VideoElement {
	return {
		id: "el-1",
		name: "Clip",
		type: "video",
		mediaId: "m1",
		duration: 4,
		startTime: 0,
		trimStart: 0,
		trimEnd: 0,
		transform: DEFAULT_TRANSFORM,
		opacity: 1,
		...overrides,
	};
}

function imageElement(overrides: Partial<ImageElement> = {}): ImageElement {
	return {
		id: "el-img",
		name: "Still",
		type: "image",
		mediaId: "m-img",
		duration: 2,
		startTime: 0,
		trimStart: 0,
		trimEnd: 0,
		transform: DEFAULT_TRANSFORM,
		opacity: 1,
		...overrides,
	};
}

function uploadAudioElement(
	overrides: Partial<UploadAudioElement> = {},
): UploadAudioElement {
	return {
		id: "el-audio",
		name: "Audio",
		type: "audio",
		sourceType: "upload",
		mediaId: "m-audio",
		duration: 3,
		startTime: 0,
		trimStart: 0,
		trimEnd: 0,
		volume: 1,
		...overrides,
	};
}

function videoTrack(
	id: string,
	elements: VideoElement[] | ImageElement[],
	overrides: Partial<TimelineTrack> = {},
): TimelineTrack {
	return {
		id,
		name: id,
		type: "video",
		elements,
		isMain: id === "main",
		muted: false,
		hidden: false,
		...overrides,
	} as TimelineTrack;
}

function audioTrack(
	id: string,
	elements: AudioElement[],
	overrides: Partial<TimelineTrack> = {},
): TimelineTrack {
	return {
		id,
		name: id,
		type: "audio",
		elements,
		muted: false,
		...overrides,
	} as TimelineTrack;
}

function videoMediaAsset(overrides: Partial<MediaAsset> = {}): MediaAsset {
	return {
		id: "m1",
		name: "clip.mp4",
		type: "video",
		file: new File([new Uint8Array([1])], "clip.mp4", { type: "video/mp4" }),
		...overrides,
	} as MediaAsset;
}

function cloneTracks(tracks: TimelineTrack[]): TimelineTrack[] {
	return JSON.parse(JSON.stringify(tracks));
}

// ────────────────────────────────────────────────────────────────────────
// #1 DeleteElementsCommand
// ────────────────────────────────────────────────────────────────────────
describe("DeleteElementsCommand — undo/redo round trip", () => {
	test("execute -> undo restores tracks exactly; redo -> undo again matches", () => {
		const clip = videoElement({ id: "el-1", startTime: 2, duration: 3 });
		const editor = makeEditor({ tracks: [videoTrack("main", [clip])] });
		const preState = cloneTracks(editor.timeline.getTracks());

		const command = new DeleteElementsCommand({
			elements: [{ trackId: "main", elementId: "el-1" }],
		});
		editor.command.execute({ command });

		expect(editor.command.getHistoryLength()).toBe(1);
		expect(editor.timeline.getTracks()[0].elements).toHaveLength(0);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);

		editor.command.redo();
		expect(editor.timeline.getTracks()[0].elements).toHaveLength(0);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);
	});
});

// ────────────────────────────────────────────────────────────────────────
// #2 DuplicateElementsCommand
// ────────────────────────────────────────────────────────────────────────
describe("DuplicateElementsCommand — undo/redo round trip + selection", () => {
	test("execute -> undo restores tracks AND selection; redo -> undo again matches", () => {
		const clip = videoElement({ id: "el-1", startTime: 0, duration: 3 });
		const editor = makeEditor({ tracks: [videoTrack("main", [clip])] });
		editor.selection.setSelectedElements({
			elements: [{ trackId: "main", elementId: "el-1" }],
		});
		const preState = cloneTracks(editor.timeline.getTracks());
		const preSelection = editor.selection.getSelectedElements();

		const command = new DuplicateElementsCommand({
			elements: [{ trackId: "main", elementId: "el-1" }],
		});
		editor.command.execute({ command });

		expect(editor.command.getHistoryLength()).toBe(1);
		// duplicate lands on a freshly created track, selection follows it
		expect(editor.selection.getSelectedElements()).not.toEqual(preSelection);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);
		expect(editor.selection.getSelectedElements()).toEqual(preSelection);

		editor.command.redo();
		expect(editor.selection.getSelectedElements()).not.toEqual(preSelection);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);
		expect(editor.selection.getSelectedElements()).toEqual(preSelection);
	});
});

// ────────────────────────────────────────────────────────────────────────
// #3 InsertElementCommand (+ BUG100 project-settings cross-store fix)
// ────────────────────────────────────────────────────────────────────────
describe("InsertElementCommand — undo/redo round trip", () => {
	test("execute -> undo restores tracks; redo -> undo again matches (non-first insert)", () => {
		const existing = videoElement({
			id: "existing",
			startTime: 0,
			duration: 2,
		});
		const editor = makeEditor({
			tracks: [videoTrack("main", [existing])],
			assets: [videoMediaAsset()],
		});
		const preState = cloneTracks(editor.timeline.getTracks());

		const command = new InsertElementCommand({
			element: {
				type: "video",
				name: "New clip",
				mediaId: "m1",
				startTime: 5,
				duration: 2,
				trimStart: 0,
				trimEnd: 0,
				transform: DEFAULT_TRANSFORM,
				opacity: 1,
			} as never,
			placement: { mode: "explicit", trackId: "main" },
		});
		editor.command.execute({ command });

		expect(editor.command.getHistoryLength()).toBe(1);
		expect(editor.timeline.getTracks()[0].elements).toHaveLength(2);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);

		editor.command.redo();
		expect(editor.timeline.getTracks()[0].elements).toHaveLength(2);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);
	});

	test("BUG100: first-element insert seeds project canvasSize/fps from the asset — undo must revert them too", () => {
		const editor = makeEditor({
			tracks: [videoTrack("main", [])],
			assets: [videoMediaAsset({ width: 1280, height: 720, fps: 24 } as never)],
			project: defaultProject(),
		});
		const preSettings = { ...editor.project.getActive()?.settings };

		const command = new InsertElementCommand({
			element: {
				type: "video",
				name: "First clip",
				mediaId: "m1",
				startTime: 0,
				duration: 2,
				trimStart: 0,
				trimEnd: 0,
				transform: DEFAULT_TRANSFORM,
				opacity: 1,
			} as never,
			placement: { mode: "explicit", trackId: "main" },
		});
		editor.command.execute({ command });

		expect(editor.command.getHistoryLength()).toBe(1);
		const settingsAfterInsert = editor.project.getActive()?.settings;
		expect(settingsAfterInsert?.canvasSize).toEqual({
			width: 1280,
			height: 720,
		});
		expect(settingsAfterInsert?.fps).toBe(24);
		expect(settingsAfterInsert?.canvasSize).not.toEqual(preSettings.canvasSize);

		editor.command.undo();
		expect(editor.timeline.getTracks()[0].elements).toHaveLength(0);
		expect(editor.project.getActive()?.settings).toEqual(preSettings);

		editor.command.redo();
		expect(editor.project.getActive()?.settings.canvasSize).toEqual({
			width: 1280,
			height: 720,
		});

		editor.command.undo();
		expect(editor.project.getActive()?.settings).toEqual(preSettings);
	});
});

// ────────────────────────────────────────────────────────────────────────
// #4 MoveElementCommand
// ────────────────────────────────────────────────────────────────────────
describe("MoveElementCommand — undo/redo round trip", () => {
	test("execute -> undo restores tracks exactly; redo -> undo again matches", () => {
		// Deliberately a NON-main track: `enforceMainTrackStart` clamps the
		// earliest main-track element to startTime 0 (product behavior), which
		// would mask the move this test is asserting on.
		const clip = videoElement({ id: "el-1", startTime: 0, duration: 2 });
		const editor = makeEditor({ tracks: [videoTrack("overlay", [clip])] });
		const preState = cloneTracks(editor.timeline.getTracks());

		const command = new MoveElementCommand({
			sourceTrackId: "overlay",
			targetTrackId: "overlay",
			elementId: "el-1",
			newStartTime: 6,
		});
		editor.command.execute({ command });

		expect(editor.command.getHistoryLength()).toBe(1);
		expect(editor.timeline.getTracks()[0].elements[0].startTime).toBe(6);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);

		editor.command.redo();
		expect(editor.timeline.getTracks()[0].elements[0].startTime).toBe(6);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);
	});
});

// ────────────────────────────────────────────────────────────────────────
// #5 MoveElementsCommand (group)
// ────────────────────────────────────────────────────────────────────────
describe("MoveElementsCommand (group) — undo/redo round trip + selection", () => {
	test("execute -> undo restores tracks AND selection; redo -> undo again matches", () => {
		const a = videoElement({ id: "a", startTime: 0, duration: 2 });
		const b = videoElement({ id: "b", startTime: 2, duration: 2 });
		const editor = makeEditor({ tracks: [videoTrack("main", [a, b])] });
		editor.selection.setSelectedElements({
			elements: [{ trackId: "main", elementId: "a" }],
		});
		const preState = cloneTracks(editor.timeline.getTracks());
		const preSelection = editor.selection.getSelectedElements();

		const command = new MoveElementsCommand({
			moves: [
				{
					sourceTrackId: "main",
					targetTrackId: "main",
					elementId: "a",
					newStartTime: 10,
				},
			],
			createTracks: [],
			targetSelection: [{ trackId: "main", elementId: "a" }],
		});
		editor.command.execute({ command });

		expect(editor.command.getHistoryLength()).toBe(1);
		expect(
			editor.timeline
				.getTracks()[0]
				.elements.find((element) => element.id === "a")?.startTime,
		).toBe(10);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);
		expect(editor.selection.getSelectedElements()).toEqual(preSelection);

		editor.command.redo();
		expect(
			editor.timeline
				.getTracks()[0]
				.elements.find((element) => element.id === "a")?.startTime,
		).toBe(10);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);
		expect(editor.selection.getSelectedElements()).toEqual(preSelection);
	});
});

// ────────────────────────────────────────────────────────────────────────
// #6 ResizeElementsCommand (group)
// ────────────────────────────────────────────────────────────────────────
describe("ResizeElementsCommand (group) — undo/redo round trip", () => {
	test("execute -> undo restores tracks exactly; redo -> undo again matches", () => {
		const a = videoElement({
			id: "a",
			startTime: 0,
			duration: 4,
			trimStart: 0,
			trimEnd: 0,
		});
		const editor = makeEditor({ tracks: [videoTrack("main", [a])] });
		const preState = cloneTracks(editor.timeline.getTracks());

		const command = new ResizeElementsCommand([
			{
				trackId: "main",
				elementId: "a",
				patch: { trimStart: 1, trimEnd: 0, startTime: 1, duration: 3 },
			},
		]);
		editor.command.execute({ command });

		expect(editor.command.getHistoryLength()).toBe(1);
		expect(editor.timeline.getTracks()[0].elements[0].duration).toBe(3);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);

		editor.command.redo();
		expect(editor.timeline.getTracks()[0].elements[0].duration).toBe(3);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);
	});
});

// ────────────────────────────────────────────────────────────────────────
// #7 SplitElementsCommand
// ────────────────────────────────────────────────────────────────────────
describe("SplitElementsCommand — undo/redo round trip + selection", () => {
	test("execute -> undo restores tracks AND selection; redo -> undo again matches", () => {
		const clip = videoElement({ id: "el-1", startTime: 0, duration: 4 });
		const editor = makeEditor({ tracks: [videoTrack("main", [clip])] });
		editor.selection.setSelectedElements({
			elements: [{ trackId: "main", elementId: "el-1" }],
		});
		const preState = cloneTracks(editor.timeline.getTracks());
		const preSelection = editor.selection.getSelectedElements();

		const command = new SplitElementsCommand({
			elements: [{ trackId: "main", elementId: "el-1" }],
			splitTime: 2,
			retainSide: "both",
		});
		editor.command.execute({ command });

		expect(editor.command.getHistoryLength()).toBe(1);
		expect(editor.timeline.getTracks()[0].elements).toHaveLength(2);
		expect(editor.selection.getSelectedElements()).not.toEqual(preSelection);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);
		expect(editor.selection.getSelectedElements()).toEqual(preSelection);

		editor.command.redo();
		expect(editor.timeline.getTracks()[0].elements).toHaveLength(2);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);
		expect(editor.selection.getSelectedElements()).toEqual(preSelection);
	});
});

// ────────────────────────────────────────────────────────────────────────
// #8 ToggleElementsMutedCommand
// ────────────────────────────────────────────────────────────────────────
describe("ToggleElementsMutedCommand — undo/redo round trip", () => {
	test("execute -> undo restores tracks exactly; redo -> undo again matches", () => {
		const clip = videoElement({ id: "el-1", muted: false });
		const editor = makeEditor({ tracks: [videoTrack("main", [clip])] });
		const preState = cloneTracks(editor.timeline.getTracks());

		const command = new ToggleElementsMutedCommand([
			{ trackId: "main", elementId: "el-1" },
		]);
		editor.command.execute({ command });

		expect(editor.command.getHistoryLength()).toBe(1);
		expect(
			(editor.timeline.getTracks()[0].elements[0] as VideoElement).muted,
		).toBe(true);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);

		editor.command.redo();
		expect(
			(editor.timeline.getTracks()[0].elements[0] as VideoElement).muted,
		).toBe(true);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);
	});
});

// ────────────────────────────────────────────────────────────────────────
// #9 ToggleElementsVisibilityCommand
// ────────────────────────────────────────────────────────────────────────
describe("ToggleElementsVisibilityCommand — undo/redo round trip", () => {
	test("execute -> undo restores tracks exactly; redo -> undo again matches", () => {
		const clip = videoElement({ id: "el-1", hidden: false });
		const editor = makeEditor({ tracks: [videoTrack("main", [clip])] });
		const preState = cloneTracks(editor.timeline.getTracks());

		const command = new ToggleElementsVisibilityCommand([
			{ trackId: "main", elementId: "el-1" },
		]);
		editor.command.execute({ command });

		expect(editor.command.getHistoryLength()).toBe(1);
		expect(
			(editor.timeline.getTracks()[0].elements[0] as VideoElement).hidden,
		).toBe(true);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);

		editor.command.redo();
		expect(
			(editor.timeline.getTracks()[0].elements[0] as VideoElement).hidden,
		).toBe(true);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);
	});
});

// ────────────────────────────────────────────────────────────────────────
// #10 ToggleSourceAudioSeparationCommand
// ────────────────────────────────────────────────────────────────────────
describe("ToggleSourceAudioSeparationCommand — undo/redo round trip", () => {
	test("recover (re-link): execute -> undo restores tracks; redo -> undo again matches", () => {
		// Already-separated video clip: toggling flips isSourceAudioEnabled back
		// to true without touching the detached copy (no media-asset lookup on
		// this branch, so no `assets` fixture needed).
		const clip = videoElement({
			id: "el-1",
			isSourceAudioEnabled: false,
		} as never);
		const editor = makeEditor({ tracks: [videoTrack("main", [clip])] });
		const preState = cloneTracks(editor.timeline.getTracks());

		const command = new ToggleSourceAudioSeparationCommand({
			trackId: "main",
			elementId: "el-1",
		});
		editor.command.execute({ command });

		expect(editor.command.getHistoryLength()).toBe(1);
		expect(
			(editor.timeline.getTracks()[0].elements[0] as VideoElement)
				.isSourceAudioEnabled,
		).toBe(true);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);

		editor.command.redo();
		expect(
			(editor.timeline.getTracks()[0].elements[0] as VideoElement)
				.isSourceAudioEnabled,
		).toBe(true);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);
	});
});

// ────────────────────────────────────────────────────────────────────────
// #11 UpdateElementCommand
// ────────────────────────────────────────────────────────────────────────
describe("UpdateElementCommand — undo/redo round trip", () => {
	test("execute -> undo restores tracks exactly; redo -> undo again matches", () => {
		const clip = videoElement({ id: "el-1", opacity: 1 });
		const editor = makeEditor({ tracks: [videoTrack("main", [clip])] });
		const preState = cloneTracks(editor.timeline.getTracks());

		const command = new UpdateElementCommand({
			trackId: "main",
			elementId: "el-1",
			updates: { opacity: 0.4 },
		});
		editor.command.execute({ command });

		expect(editor.command.getHistoryLength()).toBe(1);
		expect(
			(editor.timeline.getTracks()[0].elements[0] as VideoElement).opacity,
		).toBe(0.4);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);

		editor.command.redo();
		expect(
			(editor.timeline.getTracks()[0].elements[0] as VideoElement).opacity,
		).toBe(0.4);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);
	});
});

// ────────────────────────────────────────────────────────────────────────
// #12 UpdateElementDurationCommand
// ────────────────────────────────────────────────────────────────────────
describe("UpdateElementDurationCommand — undo/redo round trip", () => {
	test("execute -> undo restores tracks exactly; redo -> undo again matches", () => {
		const clip = videoElement({ id: "el-1", duration: 4 });
		const editor = makeEditor({ tracks: [videoTrack("main", [clip])] });
		const preState = cloneTracks(editor.timeline.getTracks());

		const command = new UpdateElementDurationCommand({
			trackId: "main",
			elementId: "el-1",
			duration: 9,
		});
		editor.command.execute({ command });

		expect(editor.command.getHistoryLength()).toBe(1);
		expect(editor.timeline.getTracks()[0].elements[0].duration).toBe(9);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);

		editor.command.redo();
		expect(editor.timeline.getTracks()[0].elements[0].duration).toBe(9);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);
	});
});

// ────────────────────────────────────────────────────────────────────────
// #13 UpdateElementStartTimeCommand
// ────────────────────────────────────────────────────────────────────────
describe("UpdateElementStartTimeCommand — undo/redo round trip", () => {
	test("execute -> undo restores tracks exactly; redo -> undo again matches", () => {
		const clip = videoElement({ id: "el-1", startTime: 0, duration: 2 });
		const editor = makeEditor({
			tracks: [videoTrack("secondary", [clip], { isMain: false })],
		});
		const preState = cloneTracks(editor.timeline.getTracks());

		const command = new UpdateElementStartTimeCommand({
			elements: [{ trackId: "secondary", elementId: "el-1" }],
			startTime: 7,
		});
		editor.command.execute({ command });

		expect(editor.command.getHistoryLength()).toBe(1);
		expect(editor.timeline.getTracks()[0].elements[0].startTime).toBe(7);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);

		editor.command.redo();
		expect(editor.timeline.getTracks()[0].elements[0].startTime).toBe(7);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);
	});
});

// ────────────────────────────────────────────────────────────────────────
// #14 UpdateElementTrimCommand
// ────────────────────────────────────────────────────────────────────────
describe("UpdateElementTrimCommand — undo/redo round trip", () => {
	test("execute -> undo restores tracks exactly; redo -> undo again matches", () => {
		const clip = videoElement({
			id: "el-1",
			startTime: 0,
			duration: 4,
			trimStart: 0,
			trimEnd: 0,
		});
		const editor = makeEditor({ tracks: [videoTrack("main", [clip])] });
		const preState = cloneTracks(editor.timeline.getTracks());

		const command = new UpdateElementTrimCommand({
			elementId: "el-1",
			trimStart: 1,
			trimEnd: 0.5,
			duration: 2.5,
		});
		editor.command.execute({ command });

		expect(editor.command.getHistoryLength()).toBe(1);
		expect(editor.timeline.getTracks()[0].elements[0].trimStart).toBe(1);
		expect(editor.timeline.getTracks()[0].elements[0].duration).toBe(2.5);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);

		editor.command.redo();
		expect(editor.timeline.getTracks()[0].elements[0].trimStart).toBe(1);

		editor.command.undo();
		expect(editor.timeline.getTracks()).toEqual(preState);
	});
});

// Silence unused-import lint for fixture builders only exercised indirectly
// through type positions in some describe blocks above.
void imageElement;
void uploadAudioElement;
void audioTrack;

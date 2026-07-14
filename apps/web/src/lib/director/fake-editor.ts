/**
 * A lightweight, in-memory `EditorCore` stub for headless Director unit tests.
 *
 * It implements just the timeline/command/project/media surface the Director API
 * touches — enough to exercise real slot/take bookkeeping (add/update/select
 * takes, generative + voiceover slots, plain element inserts) without a browser,
 * a renderer, or the Zustand stores. Not a `.test.ts` file so bun's runner
 * doesn't treat it as a suite; imported by the Director test files.
 *
 * `command` is the REAL `CommandManager` (not a no-op stub) and every mutating
 * timeline method below routes through `editor.command.execute()` with a real
 * undo/redo pair — mirroring how the production `TimelineManager` wires each
 * mutation. This is what lets Director's agent-scoped-undo tests (A2: origin
 * tagging, atomic multi-step verbs, undo/redo refusal) exercise real history
 * behavior instead of the previous always-`canUndo() === false` stub.
 */

import type { EditorCore } from "@/core";
import { CommandManager } from "@/core/managers/commands";
import type { Command } from "@/lib/commands";
import type { GenerationSpec, Take, TimelineTrack } from "@/types/timeline";
import type { DirectorBrief, ProjectBible } from "@/types/project";

let idCounter = 0;
const nextId = (prefix: string) => `${prefix}_${++idCounter}`;

/** A loose timeline element — enough fields for the Director paths under test. */
export interface FakeElement {
	id: string;
	type: "video" | "image" | "audio" | "text";
	name: string;
	startTime: number;
	duration: number;
	trimStart: number;
	trimEnd: number;
	mediaId?: string;
	volume?: number;
	sourceType?: "upload" | "library";
	generation?: GenerationSpec;
	takes?: Take[];
	activeTakeId?: string;
}

interface FakeTrack {
	id: string;
	type: string;
	elements: FakeElement[];
}

export interface FakeEditor {
	editor: EditorCore;
	tracks: FakeTrack[];
	/** Find an element (and its track) by id, or null. */
	find: (
		elementId: string,
	) => { track: FakeTrack; element: FakeElement } | null;
	/** All tracks of a given element type. */
	tracksOfType: (type: string) => FakeTrack[];
}

/** Build a duck-typed `Command` (matches `@/lib/commands`' shape) from a plain
 * do/undo pair — `redo` defaults to re-running `execute`, same as the real
 * base `Command` class. */
function makeCommand(
	description: string,
	doFn: () => void,
	undoFn: () => void,
): Command {
	return {
		execute: doFn,
		undo: undoFn,
		redo: doFn,
		getDescription: () => description,
	} as Command;
}

export function makeFakeEditor(opts?: { fps?: number }): FakeEditor {
	const tracks: FakeTrack[] = [];
	const command = new CommandManager();

	const trackFor = (type: string): FakeTrack => {
		let t = tracks.find((tr) => tr.type === type);
		if (!t) {
			t = { id: nextId("track"), type, elements: [] };
			tracks.push(t);
		}
		return t;
	};

	const find = (elementId: string) => {
		for (const track of tracks) {
			const element = track.elements.find((e) => e.id === elementId);
			if (element) return { track, element };
		}
		return null;
	};

	const timeline = {
		getTracks: () => tracks as unknown as TimelineTrack[],
		getTotalDuration: () =>
			tracks.reduce(
				(max, tr) =>
					tr.elements.reduce(
						(m, e) => Math.max(m, e.startTime + e.duration),
						max,
					),
				0,
			),
		addGenerativeSlot: ({
			spec,
			duration,
			startTime,
			trackId,
		}: {
			spec?: GenerationSpec;
			duration?: number;
			startTime?: number;
			trackId?: string;
		}) => {
			const id = nextId("slot");
			const element: FakeElement = {
				id,
				type: "video",
				name: spec?.prompt?.slice(0, 40) || "Generative slot",
				mediaId: "",
				generation: spec,
				takes: [],
				startTime: startTime ?? 0,
				duration: duration ?? spec?.duration ?? 5,
				trimStart: 0,
				trimEnd: 0,
			};
			const track = trackId
				? (tracks.find((t) => t.id === trackId) ?? trackFor("video"))
				: trackFor("video");
			command.execute({
				command: makeCommand(
					"Add generative slot",
					() => track.elements.push(element),
					() => {
						track.elements = track.elements.filter((e) => e !== element);
					},
				),
			});
			return id;
		},
		addVoiceoverSlot: ({
			spec,
			duration,
			startTime,
			trackId,
		}: {
			spec?: GenerationSpec;
			duration?: number;
			startTime?: number;
			trackId?: string;
		}) => {
			const id = nextId("vo");
			const element: FakeElement = {
				id,
				type: "audio",
				sourceType: "upload",
				name: spec?.prompt?.slice(0, 40) || "Voiceover slot",
				mediaId: "",
				volume: 1,
				generation: spec,
				takes: [],
				startTime: startTime ?? 0,
				duration: duration ?? 5,
				trimStart: 0,
				trimEnd: 0,
			};
			const track = trackId
				? (tracks.find((t) => t.id === trackId) ?? trackFor("audio"))
				: trackFor("audio");
			command.execute({
				command: makeCommand(
					"Add voiceover slot",
					() => track.elements.push(element),
					() => {
						track.elements = track.elements.filter((e) => e !== element);
					},
				),
			});
			return id;
		},
		insertElement: ({
			element,
			placement,
		}: {
			element: Partial<FakeElement> & { type: FakeElement["type"] };
			placement:
				| { mode: "explicit"; trackId: string }
				| { mode: "auto"; trackType?: string };
		}) => {
			const id = element.id ?? nextId("el");
			const full: FakeElement = {
				trimStart: 0,
				trimEnd: 0,
				startTime: 0,
				duration: 5,
				name: "element",
				...element,
				id,
			} as FakeElement;
			const type =
				placement.mode === "explicit"
					? (tracks.find((t) => t.id === placement.trackId)?.type ?? full.type)
					: (placement.trackType ?? full.type);
			const track =
				placement.mode === "explicit"
					? (tracks.find((t) => t.id === placement.trackId) ?? trackFor(type))
					: trackFor(type);
			command.execute({
				command: makeCommand(
					"Insert element",
					() => track.elements.push(full),
					() => {
						track.elements = track.elements.filter((e) => e !== full);
					},
				),
			});
			return id;
		},
		addTakeToElement: ({
			elementId,
			take,
		}: {
			elementId: string;
			take: Take;
		}) => {
			const f = find(elementId);
			if (!f) return;
			const prevTakes = f.element.takes;
			command.execute({
				command: makeCommand(
					"Add take",
					() => {
						f.element.takes = [...(prevTakes ?? []), take];
					},
					() => {
						f.element.takes = prevTakes;
					},
				),
			});
		},
		updateTake: ({
			elementId,
			takeId,
			patch,
		}: {
			elementId: string;
			takeId: string;
			patch: Partial<Take>;
		}) => {
			const f = find(elementId);
			if (!f) return;
			const prevTakes = f.element.takes;
			command.execute({
				command: makeCommand(
					"Update take",
					() => {
						f.element.takes = (prevTakes ?? []).map((t) =>
							t.id === takeId ? { ...t, ...patch } : t,
						);
					},
					() => {
						f.element.takes = prevTakes;
					},
				),
			});
		},
		selectTake: ({
			elementId,
			takeId,
		}: {
			elementId: string;
			takeId: string;
		}) => {
			const f = find(elementId);
			if (!f) return;
			const prevActiveTakeId = f.element.activeTakeId;
			command.execute({
				command: makeCommand(
					"Select take",
					() => {
						f.element.activeTakeId = takeId;
					},
					() => {
						f.element.activeTakeId = prevActiveTakeId;
					},
				),
			});
		},
		setSlotSpec: ({
			elementId,
			spec,
		}: {
			elementId: string;
			spec: GenerationSpec;
		}) => {
			const f = find(elementId);
			if (!f) return;
			const prevSpec = f.element.generation;
			command.execute({
				command: makeCommand(
					"Set slot spec",
					() => {
						f.element.generation = spec;
					},
					() => {
						f.element.generation = prevSpec;
					},
				),
			});
		},
	};

	const activeProject = {
		metadata: { id: "proj_1", name: "Test Reel" },
		settings: {
			fps: opts?.fps ?? 30,
			canvasSize: { width: 1080, height: 1920 },
		},
	};
	// In-memory durable brief, so brief-writing paths (chooseTake, recordFinalSpend)
	// have real storage to persist to and read back.
	let brief: DirectorBrief = {};
	// In-memory durable Project Bible, so bible write-through + hydration + revert
	// paths have real storage to persist to and read back (models `TProject.projectBible`).
	let projectBible: ProjectBible | undefined;
	const project = {
		getActive: () => activeProject,
		getActiveOrNull: () => activeProject,
		getDirectorBrief: () => brief,
		setDirectorBrief: ({ brief: next }: { brief: DirectorBrief }) => {
			brief = next;
		},
		getProjectBible: () => projectBible,
		setProjectBible: ({ bible }: { bible: ProjectBible }) => {
			projectBible = bible;
		},
	};

	const media = {
		getAssets: () => [] as unknown[],
		getAssetById: (_id: string) => undefined,
		addMediaAsset: async () => "media_x",
	};

	const editor = {
		timeline,
		command,
		project,
		media,
	} as unknown as EditorCore;

	return {
		editor,
		tracks,
		find,
		tracksOfType: (type: string) => tracks.filter((t) => t.type === type),
	};
}

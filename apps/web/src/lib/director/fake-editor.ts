/**
 * A lightweight, in-memory `EditorCore` stub for headless Director unit tests.
 *
 * It implements just the timeline/command/project/media surface the Director API
 * touches — enough to exercise real slot/take bookkeeping (add/update/select
 * takes, generative + voiceover slots, plain element inserts) without a browser,
 * a renderer, or the Zustand stores. Not a `.test.ts` file so bun's runner
 * doesn't treat it as a suite; imported by the Director test files.
 */

import type { EditorCore } from "@/core";
import type { GenerationSpec, Take, TimelineTrack } from "@/types/timeline";

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

export function makeFakeEditor(opts?: { fps?: number }): FakeEditor {
	const tracks: FakeTrack[] = [];

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
			track.elements.push(element);
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
			track.elements.push(element);
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
			track.elements.push(full);
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
			f.element.takes = [...(f.element.takes ?? []), take];
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
			f.element.takes = (f.element.takes ?? []).map((t) =>
				t.id === takeId ? { ...t, ...patch } : t,
			);
		},
		selectTake: ({
			elementId,
			takeId,
		}: {
			elementId: string;
			takeId: string;
		}) => {
			const f = find(elementId);
			if (f) f.element.activeTakeId = takeId;
		},
		setSlotSpec: ({
			elementId,
			spec,
		}: {
			elementId: string;
			spec: GenerationSpec;
		}) => {
			const f = find(elementId);
			if (f) f.element.generation = spec;
		},
	};

	const command = {
		beginTransaction() {},
		commitTransaction() {},
		rollbackTransaction() {},
		execute() {},
		undo() {},
		redo() {},
		canUndo: () => false,
		canRedo: () => false,
	};

	const activeProject = {
		metadata: { id: "proj_1", name: "Test Reel" },
		settings: {
			fps: opts?.fps ?? 30,
			canvasSize: { width: 1080, height: 1920 },
		},
	};
	const project = {
		getActive: () => activeProject,
		getActiveOrNull: () => activeProject,
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

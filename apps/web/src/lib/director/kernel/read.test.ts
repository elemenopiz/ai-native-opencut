/**
 * `read.ts` tests. Deliberately independent of `./schemas`'s real
 * `KIND_SCHEMAS` (Agent A's in-progress work, landing in parallel — see
 * `read.ts`'s file header): every test injects its own `schemaFor` fixture
 * via `ReadDeps`, and every editor is a plain object shaped like the slice of
 * `EditorCore` `read.ts` actually calls, cast through `unknown` — no live
 * `EditorCore.getInstance()` anywhere here.
 */

import { describe, expect, it } from "bun:test";
import type { EditorCore } from "@/core";
import type {
	Marker,
	TimelineElement,
	TimelineTrack,
	TScene,
} from "@/types/timeline";
import type { MediaAsset } from "@/types/assets";
import { KernelIdError } from "./ids";
import { KernelReadError, read } from "./read";
import type { FieldSpec, KindSchema } from "./schema";

// ── fixtures ─────────────────────────────────────────────────────────────

function makeElement(overrides: Record<string, unknown> = {}): TimelineElement {
	return {
		id: "e1",
		type: "video",
		name: "Clip A",
		startTime: 2,
		duration: 5,
		trimStart: 0,
		trimEnd: 0,
		mediaId: "m1",
		transform: { position: { x: 0, y: 0 }, scale: 1, rotate: 0 },
		opacity: 1,
		effects: [
			{ id: "fx1", type: "brightness", enabled: true, params: { amount: 0.2 } },
		],
		takes: [
			{
				id: "take1",
				status: "ready",
				createdAt: 1,
				mediaId: "m1",
				spec: {
					prompt: "a misty coffee farm",
					mode: "text-to-video",
					resolution: "1080p",
					orientation: "landscape",
					duration: 5,
				},
			},
		],
		activeTakeId: "take1",
		animations: {
			channels: {
				opacity: {
					valueKind: "number",
					keyframes: [
						{ id: "kf1", time: 0, value: 1, interpolation: "linear" },
						{ id: "kf2", time: 5, value: 0, interpolation: "linear" },
					],
				},
			},
		},
		...overrides,
	} as unknown as TimelineElement;
}

function makeTrack(
	elements: TimelineElement[] = [],
	overrides: Record<string, unknown> = {},
): TimelineTrack {
	return {
		id: "t1",
		name: "Video 1",
		type: "video",
		elements,
		isMain: true,
		muted: false,
		hidden: false,
		...overrides,
	} as unknown as TimelineTrack;
}

function makeAsset(overrides: Record<string, unknown> = {}): MediaAsset {
	return {
		id: "a1",
		name: "farm.mp4",
		type: "video",
		url: "blob:farm",
		width: 1920,
		height: 1080,
		duration: 12,
		fps: 30,
		file: new File([], "farm.mp4"),
		...overrides,
	} as unknown as MediaAsset;
}

interface FakeEditorOptions {
	tracks?: TimelineTrack[];
	assets?: MediaAsset[];
	project?: unknown;
	brief?: Record<string, unknown>;
	bible?: Record<string, unknown>;
	selectedElements?: Array<{ trackId: string; elementId: string }>;
	selectedKeyframes?: unknown[];
	currentTime?: number;
	isPlaying?: boolean;
	isScrubbing?: boolean;
	canUndo?: boolean;
	canRedo?: boolean;
	historyLength?: number;
	redoLength?: number;
	undoName?: string;
	markers?: Marker[];
	scenes?: TScene[];
}

function makeEditor(opts: FakeEditorOptions = {}): EditorCore {
	const tracks = opts.tracks ?? [];
	const assets = opts.assets ?? [];
	return {
		timeline: {
			getTracks: () => tracks,
		},
		media: {
			getAssets: () => assets,
			getAssetById: (id: string) => assets.find((a) => a.id === id),
		},
		project: {
			getActiveOrNull: () => opts.project ?? null,
			getDirectorBrief: () => opts.brief ?? {},
			getProjectBible: () => opts.bible,
		},
		selection: {
			getSelectedElements: () => opts.selectedElements ?? [],
			getSelectedKeyframes: () => opts.selectedKeyframes ?? [],
			getKeyframeSelectionAnchor: () => null,
		},
		playback: {
			getCurrentTime: () => opts.currentTime ?? 0,
			getIsPlaying: () => opts.isPlaying ?? false,
			getIsScrubbing: () => opts.isScrubbing ?? false,
			getVolume: () => 1,
			isMuted: () => false,
			getShuttleSpeed: () => 0,
			getShuttleDirection: () => null,
		},
		command: {
			canUndo: () => opts.canUndo ?? false,
			canRedo: () => opts.canRedo ?? false,
			getHistoryLength: () => opts.historyLength ?? 0,
			getRedoLength: () => opts.redoLength ?? 0,
			peekUndoName: () => opts.undoName,
		},
		scenes: {
			getMarkers: () => opts.markers ?? [],
			getScenes: () => opts.scenes ?? [],
		},
	} as unknown as EditorCore;
}

function field(
	spec: Partial<FieldSpec> & { type: FieldSpec["type"] },
): FieldSpec {
	return { description: "fixture field", ...spec };
}

/** A minimal `element` schema: writable `name`/`startSec` (with a natural-guess alias), read-only `id`. */
const ELEMENT_SCHEMA: KindSchema = {
	kind: "element",
	summary: "A timeline element.",
	fields: {
		id: field({
			type: "id",
			of: "element",
			readOnly: true,
			readOnlyReason: "stable identity",
		}),
		name: field({ type: "string" }),
		startSec: field({
			type: "number",
			unit: "seconds",
			aliases: ["start", "startTime"],
		}),
		trackId: field({
			type: "id",
			of: "track",
			readOnly: true,
			readOnlyReason: "move via update",
		}),
	},
};

const TRACK_SCHEMA: KindSchema = {
	kind: "track",
	summary: "A timeline track.",
	fields: {
		id: field({
			type: "id",
			of: "track",
			readOnly: true,
			readOnlyReason: "stable identity",
		}),
		name: field({ type: "string" }),
	},
};

const PROJECT_SCHEMA: KindSchema = {
	kind: "project",
	summary: "The active project.",
	fields: { name: field({ type: "string" }) },
};

const BUDGET_SCHEMA: KindSchema = {
	kind: "budget",
	summary: "The reel's spend cap and running tally.",
	fields: { budgetUsd: field({ type: "number", unit: "USD" }) },
};

function fixtureSchemaFor(
	schemas: Partial<Record<KindSchema["kind"], KindSchema>>,
) {
	return (kind: KindSchema["kind"]): KindSchema => {
		const schema = schemas[kind];
		if (!schema) throw new Error(`no fixture schema registered for "${kind}"`);
		return schema;
	};
}

// ── tests ────────────────────────────────────────────────────────────────

describe("read — element", () => {
	it("returns _writable with the schema's writable fields and excludes read-only ones", async () => {
		const editor = makeEditor({ tracks: [makeTrack([makeElement()])] });
		const result = await read(
			editor,
			{ at: "element:e1" },
			{ schemaFor: fixtureSchemaFor({ element: ELEMENT_SCHEMA }) },
		);

		expect(result.kind).toBe("element");
		expect(result.id).toBe("element:e1");
		expect(Object.keys(result._writable.fields).sort()).toEqual([
			"name",
			"startSec",
		]);
		expect(Object.keys(result._writable.readOnly).sort()).toEqual([
			"id",
			"trackId",
		]);
		expect(result._writable.readOnly.id.reason).toBe("stable identity");
		// data still carries the read-only fields — _writable is about what
		// `update` will accept, not about what `read` returns.
		expect(result.data.id).toBe("e1");
		expect(result.data.name).toBe("Clip A");
		expect(result.data.trackId).toBe("t1");
	});

	it("projects the common shape (times, transform, effect/take/keyframe ids) without a per-type switch", async () => {
		const editor = makeEditor({ tracks: [makeTrack([makeElement()])] });
		const result = await read(
			editor,
			{ at: "element:e1" },
			{ schemaFor: fixtureSchemaFor({ element: ELEMENT_SCHEMA }) },
		);

		expect(result.data.startSec).toBe(2);
		expect(result.data.durationSec).toBe(5);
		expect(result.data.endSec).toBe(7);
		expect(result.data.kind).toBe("video");
		expect(result.data.trackKind).toBe("video");
		expect(result.data.trimStart).toBe(0);
		expect(result.data.trimEnd).toBe(0);
		expect(result.data.activeTakeId).toBe("take1");
		// depth defaults to "ids" — effects/takes come back as bare ids, not
		// expanded nested objects, under the SAME field name either way.
		expect(result.data.effects).toEqual(["fx1"]);
		expect(result.data.takes).toEqual(["take1"]);
		// isSlot = Boolean(generation) — the fixture carries takes without a
		// generation recipe, so this is honestly false, not a placeholder.
		expect(result.data.isSlot).toBe(false);
	});
});

describe("read — bare/singleton ids", () => {
	it("coerces a bare singleton kind name (no colon) to its synthetic id", async () => {
		const editor = makeEditor({
			project: {
				metadata: { id: "p1", name: "My Reel", duration: 42 },
				settings: { fps: 30, canvasSize: { width: 1080, height: 1920 } },
				currentSceneId: "s1",
				scenes: [{ id: "s1" }],
			},
		});
		const result = await read(
			editor,
			{ at: "project" },
			{ schemaFor: fixtureSchemaFor({ project: PROJECT_SCHEMA }) },
		);
		expect(result.id).toBe("project:current");
		expect(result.data.name).toBe("My Reel");
	});

	it("rejects a bare id-requiring kind name with the teaching message (not silently guessing)", async () => {
		const editor = makeEditor();
		await expect(
			read(
				editor,
				{ at: "track" },
				{ schemaFor: fixtureSchemaFor({ track: TRACK_SCHEMA }) },
			),
		).rejects.toThrow(KernelIdError);
		await expect(
			read(
				editor,
				{ at: "track" },
				{ schemaFor: fixtureSchemaFor({ track: TRACK_SCHEMA }) },
			),
		).rejects.toThrow(/needs an id/);
	});

	it("rejects a plain bare uuid with no kind at all via parseId's grammar message", async () => {
		const editor = makeEditor();
		await expect(read(editor, { at: "9f1c" }, {})).rejects.toThrow(
			/missing its kind prefix/,
		);
	});
});

describe("read — bad kind", () => {
	it("suggests the nearest legal kind", async () => {
		const editor = makeEditor();
		await expect(read(editor, { at: "tracc:t1" }, {})).rejects.toThrow(
			/did you mean "track"/,
		);
	});
});

describe("read — nonexistent id", () => {
	it("lists the live track ids that DO exist", async () => {
		const editor = makeEditor({
			tracks: [makeTrack([], { id: "t1" }), makeTrack([], { id: "t2" })],
		});
		await expect(
			read(
				editor,
				{ at: "track:ghost" },
				{ schemaFor: fixtureSchemaFor({ track: TRACK_SCHEMA }) },
			),
		).rejects.toThrow(/Live track ids: t1, t2/);
	});

	it("lists '(none)' when nothing exists yet", async () => {
		const editor = makeEditor();
		await expect(
			read(
				editor,
				{ at: "track:ghost" },
				{ schemaFor: fixtureSchemaFor({ track: TRACK_SCHEMA }) },
			),
		).rejects.toThrow(/Live track ids: \(none\)/);
	});

	it("throws KernelReadError (not KernelIdError) — the id was well-formed, just unresolved", async () => {
		const editor = makeEditor();
		await expect(
			read(
				editor,
				{ at: "track:ghost" },
				{ schemaFor: fixtureSchemaFor({ track: TRACK_SCHEMA }) },
			),
		).rejects.toThrow(KernelReadError);
	});
});

describe("read — a recognized-but-unwired kind teaches, not guesses", () => {
	it("names it distinctly from an unknown kind", async () => {
		const editor = makeEditor();
		await expect(read(editor, { at: "commit:abc" }, {})).rejects.toThrow(
			/does not address "commit" yet/,
		);
	});
});

describe("read — fields narrows data", () => {
	it("returns only the requested fields, resolved through aliases", async () => {
		const editor = makeEditor({ tracks: [makeTrack([makeElement()])] });
		const result = await read(
			editor,
			{ at: "element:e1", fields: ["name", "start"] },
			{ schemaFor: fixtureSchemaFor({ element: ELEMENT_SCHEMA }) },
		);
		expect(Object.keys(result.data).sort()).toEqual(["name", "startSec"]);
		expect(result.data.startSec).toBe(2);
	});

	it("teaches on an unknown field instead of returning undefined silently", async () => {
		const editor = makeEditor({ tracks: [makeTrack([makeElement()])] });
		await expect(
			read(
				editor,
				{ at: "element:e1", fields: ["nam"] },
				{ schemaFor: fixtureSchemaFor({ element: ELEMENT_SCHEMA }) },
			),
		).rejects.toThrow(/did you mean "name"/);
	});
});

describe("read — depth expands children", () => {
	it("returns element ids only by default", async () => {
		const editor = makeEditor({ tracks: [makeTrack([makeElement()])] });
		const result = await read(
			editor,
			{ at: "track:t1" },
			{ schemaFor: fixtureSchemaFor({ track: TRACK_SCHEMA }) },
		);
		// default depth ("ids"): the SAME `elements` field, just id-narrowed.
		expect(result.data.elements).toEqual(["e1"]);
	});

	it("expands full element objects when depth is 'expanded'", async () => {
		const editor = makeEditor({ tracks: [makeTrack([makeElement()])] });
		const result = await read(
			editor,
			{ at: "track:t1", depth: "expanded" },
			{ schemaFor: fixtureSchemaFor({ track: TRACK_SCHEMA }) },
		);
		const elements = result.data.elements as Array<Record<string, unknown>>;
		expect(elements).toHaveLength(1);
		expect(elements[0].id).toBe("e1");
		expect(elements[0].name).toBe("Clip A");
	});
});

describe("read — singleton kinds", () => {
	it("reads budget with no cap set", async () => {
		const editor = makeEditor();
		const result = await read(
			editor,
			{ at: "budget" },
			{ schemaFor: fixtureSchemaFor({ budget: BUDGET_SCHEMA }) },
		);
		expect(result.id).toBe("budget:current");
		expect(result.data.spentUsd).toBe(0);
		expect(result.data.budgetUsd).toBeUndefined();
		expect(result.summary).toMatch(/No budget set/);
	});

	it("reads an empty selection", async () => {
		const editor = makeEditor();
		const result = await read(
			editor,
			{ at: "selection" },
			{
				schemaFor: fixtureSchemaFor({
					selection: { kind: "selection", summary: "s", fields: {} },
				}),
			},
		);
		expect(result.data.elements).toEqual([]);
		expect(result.summary).toBe("Nothing selected.");
	});

	it("reads the playhead", async () => {
		const editor = makeEditor({ currentTime: 12.5, isPlaying: true });
		const result = await read(
			editor,
			{ at: "playhead" },
			{
				schemaFor: fixtureSchemaFor({
					playhead: { kind: "playhead", summary: "s", fields: {} },
				}),
			},
		);
		expect(result.data.time).toBe(12.5);
		expect(result.data.playing).toBe(true);
	});
});

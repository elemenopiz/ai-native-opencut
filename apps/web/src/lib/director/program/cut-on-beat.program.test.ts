/**
 * THE TEST THAT JUSTIFIES THE DESIGN.
 *
 * `docs/plans/2026-09-18-director-autonomy-architecture.md` §2 claims the
 * program layer is "not a smaller action space than `cutOnBeat` — it is
 * strictly larger, and it contains `cutOnBeat` as one possible program". That
 * claim is falsifiable, and this file is where it gets tested: the program in
 * `programs/cut-on-beat.ts` runs over the same fixture as the frozen macro in
 * `craft/cut-on-beat.ts`, and the two op lists must be deep-equal.
 *
 * Two levels, because each one can fail for a different reason:
 *  1. PLAN PARITY (dry run). `runProgram(mode: "dry-run")`'s op list vs.
 *     `planCutOnBeat(...).ops`. This is the real comparison — the macro is a
 *     planner that only ever emits `CraftOp[]`, so matching its ops IS
 *     matching it. Several fixtures, each exercising a different branch the
 *     macro has an opinion about (tie-breaking, the min-duration floor, the
 *     two-joins-one-clip merge, gaps, already-on-beat no-ops).
 *  2. APPLIED PARITY (real `DirectorApi`, real `CommandManager`). The verb
 *     and the program are each run against an identical live timeline and the
 *     resulting element geometry is compared, plus the claim that a whole
 *     program run collapses to ONE undo entry.
 *
 * The applied half uses GENERATIVE slots deliberately: `director-api.ts`'s
 * public `trim` resolves through `findSlot`, so plain placed footage is not
 * addressable by the wrapped primitive (see `executor.ts`'s KNOWN GAPS). The
 * dry-run half uses plain clips, which is what a real beat-cut acts on —
 * between them the two halves cover both target kinds honestly rather than
 * hiding the gap behind a fixture chosen to avoid it.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { type BeatGrid, useBeatGridStore } from "@/stores/beat-grid-store";
import type { TimelineElement, TimelineTrack } from "@/types/timeline";
import {
	cutOnBeat as planCutOnBeat,
	type CraftBeatMarker,
	type CraftClip,
} from "../craft/cut-on-beat";
import type { CraftOp } from "../craft/types";
import { getTimelineBeatMarkers } from "@/stores/beat-grid-store";
import { runProgram } from "./executor";
import { CUT_ON_BEAT_PROGRAM } from "./programs/cut-on-beat";
import { makeFakeEditor, type FakeElement } from "../fake-editor";

const { createDirectorApi } = await import("../director-api");
const { EditorCore: EditorCoreClass } = await import("@/core");
const { UpdateElementTrimCommand } = await import(
	"@/lib/commands/timeline/element/update-element-trim"
);

// ── fixture plumbing ─────────────────────────────────────────────────────────

/** One clip in a fixture, in the few fields both the macro and the program read. */
interface FixtureClip {
	id: string;
	startSec: number;
	durationSec: number;
	trimStart?: number;
}

interface Fixture {
	name: string;
	clips: FixtureClip[];
	/** SOURCE-time beats on the beat-source element (which sits at startTime 0, trimStart 0, so source time == timeline time). */
	beats: number[];
}

const VIDEO_TRACK_ID = "track_video";
const AUDIO_TRACK_ID = "track_audio";
const BEAT_SOURCE_ID = "el_beat_source";

/** Build the loose `TimelineTrack[]` shape both the derived-data layer and `getTimelineBeatMarkers` read. */
function fixtureTracks(fixture: Fixture): TimelineTrack[] {
	const video = {
		id: VIDEO_TRACK_ID,
		type: "video",
		elements: fixture.clips.map((clip) => ({
			id: clip.id,
			type: "video",
			name: clip.id,
			mediaId: `media_${clip.id}`,
			startTime: clip.startSec,
			duration: clip.durationSec,
			trimStart: clip.trimStart ?? 0,
			trimEnd: 0,
		})),
	};
	const audio = {
		id: AUDIO_TRACK_ID,
		type: "audio",
		elements: [
			{
				id: BEAT_SOURCE_ID,
				type: "audio",
				name: "beat source",
				mediaId: "media_song",
				startTime: 0,
				duration: 120,
				trimStart: 0,
				trimEnd: 0,
			},
		],
	};
	return [video, audio] as unknown as TimelineTrack[];
}

function fixtureGrid(fixture: Fixture): BeatGrid {
	return {
		elementId: BEAT_SOURCE_ID,
		trackId: AUDIO_TRACK_ID,
		mediaId: "media_song",
		beats: fixture.beats,
		downbeats: [],
		bpm: 120,
		energyClass: "energetic",
		analyzedAt: 0,
	};
}

/** What the MACRO is given, derived from the same fixture the program reads. */
function macroInputs(fixture: Fixture): {
	clips: CraftClip[];
	beats: CraftBeatMarker[];
} {
	const tracks = fixtureTracks(fixture);
	const video = tracks[0];
	const sorted = [...video.elements].sort((a, b) => a.startTime - b.startTime);
	return {
		clips: sorted.map((element: TimelineElement) => ({
			elementId: element.id,
			startSec: element.startTime,
			durationSec: element.duration,
			trimStart: element.trimStart,
		})),
		beats: getTimelineBeatMarkers({ tracks, grid: fixtureGrid(fixture) }),
	};
}

/**
 * Each fixture names the macro decision it exists to pin. A fixture that only
 * exercised the happy path would make parity a much weaker claim than it
 * looks: the interesting behaviour is all in the skips and the merge.
 */
const FIXTURES: Fixture[] = [
	{
		name: "single join, one beat just off it",
		clips: [
			{ id: "a", startSec: 0, durationSec: 3.9 },
			{ id: "b", startSec: 3.9, durationSec: 5 },
		],
		beats: [4.0],
	},
	{
		name: "middle clip on two joins — merges into ONE op",
		clips: [
			{ id: "a", startSec: 0, durationSec: 3.9 },
			{ id: "b", startSec: 3.9, durationSec: 4.2 },
			{ id: "c", startSec: 8.1, durationSec: 4 },
		],
		beats: [4.0, 8.0],
	},
	{
		name: "min-duration floor blocks a snap that would shrink the right clip",
		clips: [
			{ id: "a", startSec: 0, durationSec: 3.9 },
			{ id: "b", startSec: 3.9, durationSec: 0.55 },
			{ id: "c", startSec: 4.45, durationSec: 4 },
		],
		beats: [4.0],
	},
	{
		name: "gap between clips is not a join",
		clips: [
			{ id: "a", startSec: 0, durationSec: 3.9 },
			{ id: "b", startSec: 5, durationSec: 4 },
		],
		beats: [4.0],
	},
	{
		name: "already on the beat — no op",
		clips: [
			{ id: "a", startSec: 0, durationSec: 4 },
			{ id: "b", startSec: 4, durationSec: 4 },
		],
		beats: [4.0],
	},
	{
		name: "no beat within tolerance",
		clips: [
			{ id: "a", startSec: 0, durationSec: 3.0 },
			{ id: "b", startSec: 3.0, durationSec: 4 },
		],
		beats: [4.0],
	},
	{
		name: "trimStart is carried through the right clip's re-trim",
		clips: [
			{ id: "a", startSec: 0, durationSec: 2.93 },
			{ id: "b", startSec: 2.93, durationSec: 4, trimStart: 1.25 },
		],
		beats: [3.0],
	},
	{
		name: "snap backwards (beat earlier than the cut)",
		clips: [
			{ id: "a", startSec: 0, durationSec: 4.12 },
			{ id: "b", startSec: 4.12, durationSec: 4 },
		],
		beats: [4.0],
	},
	{
		name: "two candidate beats in tolerance — nearest wins",
		clips: [
			{ id: "a", startSec: 0, durationSec: 4.06 },
			{ id: "b", startSec: 4.06, durationSec: 4 },
		],
		beats: [4.0, 4.1],
	},
	{
		name: "chain of five clips, several joins snapping in sequence",
		clips: [
			{ id: "a", startSec: 0, durationSec: 1.94 },
			{ id: "b", startSec: 1.94, durationSec: 2.09 },
			{ id: "c", startSec: 4.03, durationSec: 1.92 },
			{ id: "d", startSec: 5.95, durationSec: 2.1 },
			{ id: "e", startSec: 8.05, durationSec: 3 },
		],
		beats: [2.0, 4.0, 6.0, 8.0],
	},
];

// ── 1. PLAN PARITY ───────────────────────────────────────────────────────────

describe("cutOnBeat as a program — plan parity with craft/cut-on-beat.ts", () => {
	for (const fixture of FIXTURES) {
		it(fixture.name, () => {
			const { clips, beats } = macroInputs(fixture);
			const expected = planCutOnBeat(clips, beats);

			const tracks = fixtureTracks(fixture);
			const grid = fixtureGrid(fixture);
			const run = runProgram({
				source: CUT_ON_BEAT_PROGRAM,
				mode: "dry-run",
				data: { tracks: () => tracks, beatGrid: () => grid },
			});

			expect(run.failure).toBeUndefined();
			expect(run.ok).toBe(true);
			expect(run.mode).toBe("dry-run");

			// Widened to `CraftOp` deliberately: the comparison must be against
			// the macro's own contract shape, not this package's narrower verb
			// union, or the test would be asserting a type rather than parity.
			const actual: CraftOp[] = run.ops.map((op) => ({
				verb: op.verb as string,
				args: op.args as Record<string, unknown>,
			}));
			expect(actual).toEqual(expected.ops);
			// Nothing was applied: the timeline fixture is untouched.
			expect(tracks[0].elements[0].duration).toBe(fixture.clips[0].durationSec);
		});
	}

	it("a dry run applies nothing even though it plans ops", () => {
		const fixture = FIXTURES[0];
		const tracks = fixtureTracks(fixture);
		const run = runProgram({
			source: CUT_ON_BEAT_PROGRAM,
			data: { tracks: () => tracks, beatGrid: () => fixtureGrid(fixture) },
		});
		expect(run.mode).toBe("dry-run");
		expect(run.ops.length).toBe(2);
		// Dry-run ops carry no result — nothing was called to produce one.
		expect(run.ops.every((op) => op.result === undefined)).toBe(true);
		expect(run.logs.length).toBe(1);
		expect(run.logs[0]).toContain("snapped join");
	});

	it("the SAME primitive surface expresses a variation the macro cannot — cut on downbeats only", () => {
		// The whole point of §2: this is a one-predicate diff, and there is no
		// argument to `cutOnBeat({...})` that reaches it.
		const tracks = fixtureTracks({
			name: "downbeat variation",
			clips: [
				{ id: "a", startSec: 0, durationSec: 3.9 },
				{ id: "b", startSec: 3.9, durationSec: 4.2 },
				{ id: "c", startSec: 8.1, durationSec: 4 },
			],
			beats: [],
		});
		const grid: BeatGrid = {
			elementId: BEAT_SOURCE_ID,
			trackId: AUDIO_TRACK_ID,
			mediaId: "media_song",
			beats: [4.0, 8.0],
			// Only 8.0 is a downbeat, so a downbeat-only program must snap the
			// SECOND join and leave the first alone.
			downbeats: [8.0],
			bpm: 120,
			energyClass: "energetic",
			analyzedAt: 0,
		};

		const source = `
let cs = clips({ trackId: "${VIDEO_TRACK_ID}" })
let bs = beats()
for (i, c of cs) {
  if (i + 1 < len(cs)) {
    let cut = c.startSec + c.durationSec
    for (b of bs) {
      if (b.isDownbeat && abs(b.time - cut) <= 0.15 && abs(b.time - cut) > EPSILON) {
        trim({ slotId: c.id, duration: roundSec(c.durationSec + (b.time - cut)) })
      }
    }
  }
}`;

		const run = runProgram({
			source,
			data: { tracks: () => tracks, beatGrid: () => grid },
		});
		expect(run.ok).toBe(true);
		expect(run.ops).toEqual([
			{ index: 0, verb: "trim", args: { slotId: "b", duration: 4.1 } },
		]);
	});
});

// ── 2. APPLIED PARITY ────────────────────────────────────────────────────────

/**
 * The fake editor, extended with the one command the craft/program trim path
 * reaches — same pattern (and same reason) as `director-craft.test.ts`'s
 * `makeCraftFakeEditor`: `UpdateElementTrimCommand` resolves the editor via
 * the `EditorCore.getInstance()` singleton from inside `execute()`, not via
 * the instance `createDirectorApi` was built with.
 */
function makeTrimmableFakeEditor() {
	const fake = makeFakeEditor();
	const timeline = fake.editor.timeline as unknown as {
		getTracks: () => TimelineTrack[];
		updateTracks: (tracks: TimelineTrack[]) => void;
		updateElementTrim: (input: {
			elementId: string;
			trimStart: number;
			trimEnd: number;
			startTime?: number;
			duration?: number;
		}) => void;
	};
	const liveGetTracks = timeline.getTracks;
	timeline.getTracks = () => [...liveGetTracks()] as TimelineTrack[];
	timeline.updateTracks = (tracks: TimelineTrack[]) => {
		fake.tracks.length = 0;
		fake.tracks.push(...(tracks as unknown as typeof fake.tracks));
	};
	timeline.updateElementTrim = (input) => {
		fake.editor.command.execute({
			command: new UpdateElementTrimCommand(input as never),
		});
	};
	return fake;
}

let restoreGetInstance: (() => void) | undefined;

afterEach(() => {
	restoreGetInstance?.();
	restoreGetInstance = undefined;
	// The beat grid is a module-global zustand store — reset it so a grid
	// seeded here never leaks into another test file.
	useBeatGridStore.getState().reset();
});

function patchEditorSingleton(editorLike: unknown) {
	const real = EditorCoreClass.getInstance;
	(EditorCoreClass as unknown as { getInstance: () => unknown }).getInstance =
		() => editorLike;
	restoreGetInstance = () => {
		(EditorCoreClass as unknown as { getInstance: () => unknown }).getInstance =
			real;
	};
}

const visualBase = {
	trimStart: 0,
	trimEnd: 0,
	transform: { scale: 1, position: { x: 0, y: 0 }, rotate: 0 },
	opacity: 1,
};

/**
 * Seed two GENERATIVE slots that join at 3.9s, plus a beat source with a beat
 * at 4.0s. Generative because the wrapped `trim` primitive is slot-scoped —
 * see this file's header.
 */
function seedAppliedFixture() {
	const fake = makeTrimmableFakeEditor();
	patchEditorSingleton(fake.editor);

	const beatSourceId = fake.editor.timeline.insertElement({
		element: {
			type: "audio",
			sourceType: "upload",
			mediaId: "media_song",
			name: "beat source",
			volume: 1,
			startTime: 0,
			duration: 20,
			trimStart: 0,
			trimEnd: 0,
		},
		placement: { mode: "auto", trackType: "audio" },
	});
	useBeatGridStore.getState().setGrid({
		elementId: beatSourceId,
		trackId: fake.find(beatSourceId)?.track.id ?? "",
		mediaId: "media_song",
		beats: [4.0],
		downbeats: [4.0],
		bpm: 120,
		energyClass: "energetic",
		analyzedAt: 0,
	});

	const generation = {
		prompt: "a shot",
		model: "test-model",
		duration: 4,
	} as never;
	const left = fake.editor.timeline.insertElement({
		element: {
			type: "video",
			mediaId: "m1",
			name: "clip 1",
			startTime: 0,
			duration: 3.9,
			generation,
			...visualBase,
		},
		placement: { mode: "auto", trackType: "video" },
	});
	const right = fake.editor.timeline.insertElement({
		element: {
			type: "video",
			mediaId: "m2",
			name: "clip 2",
			startTime: 3.9,
			duration: 5,
			generation,
			...visualBase,
		},
		placement: { mode: "auto", trackType: "video" },
	});
	return { fake, left, right };
}

function geometryOf(
	fake: ReturnType<typeof makeTrimmableFakeEditor>,
	ids: string[],
) {
	return ids.map((id) => {
		const element = fake.find(id)?.element as FakeElement;
		return {
			startTime: element.startTime,
			duration: element.duration,
			trimStart: element.trimStart,
		};
	});
}

describe("cutOnBeat as a program — applied parity against the live verb", () => {
	it("the verb and the program leave an identical timeline, each as ONE undo entry", () => {
		// -- the verb --
		const viaVerb = seedAppliedFixture();
		const verbApi = createDirectorApi(viaVerb.fake.editor);
		const historyBeforeVerb = viaVerb.fake.editor.command.getHistoryLength();
		const verbResult = verbApi.cutOnBeat({});
		expect(verbResult.ok).toBe(true);
		expect(viaVerb.fake.editor.command.getHistoryLength()).toBe(
			historyBeforeVerb + 1,
		);
		const verbGeometry = geometryOf(viaVerb.fake, [
			viaVerb.left,
			viaVerb.right,
		]);
		restoreGetInstance?.();
		restoreGetInstance = undefined;

		// -- the program --
		const viaProgram = seedAppliedFixture();
		const programApi = createDirectorApi(viaProgram.fake.editor);
		const historyBeforeProgram =
			viaProgram.fake.editor.command.getHistoryLength();
		const run = runProgram({
			source: CUT_ON_BEAT_PROGRAM,
			mode: "apply",
			api: programApi,
			undo: viaProgram.fake.editor.command,
			data: {
				tracks: () => viaProgram.fake.editor.timeline.getTracks(),
				beatGrid: () => useBeatGridStore.getState().grid,
			},
		});

		expect(run.failure).toBeUndefined();
		expect(run.ok).toBe(true);
		expect(run.ops.length).toBe(2);
		expect(run.ops.every((op) => op.result?.ok === true)).toBe(true);
		// The whole run is ONE undo entry, not one per primitive call.
		expect(viaProgram.fake.editor.command.getHistoryLength()).toBe(
			historyBeforeProgram + 1,
		);

		const programGeometry = geometryOf(viaProgram.fake, [
			viaProgram.left,
			viaProgram.right,
		]);
		expect(programGeometry).toEqual(verbGeometry);
		// …and it is the geometry the macro's own wiring test pins.
		expect(programGeometry[0].duration).toBeCloseTo(4.0, 5);
		expect(programGeometry[1].startTime).toBeCloseTo(4.0, 5);
		expect(programGeometry[1].trimStart).toBeCloseTo(0.1, 5);
		expect(programGeometry[1].duration).toBeCloseTo(4.9, 5);

		// One Cmd+Z puts the whole program back.
		const undone = programApi.undo();
		expect(undone.ok).toBe(true);
		const reverted = geometryOf(viaProgram.fake, [
			viaProgram.left,
			viaProgram.right,
		]);
		expect(reverted[0].duration).toBeCloseTo(3.9, 5);
		expect(reverted[1].startTime).toBeCloseTo(3.9, 5);
		expect(reverted[1].trimStart).toBeCloseTo(0, 5);
	});

	it("without an undo scope, each primitive keeps its own history entry", () => {
		const { fake } = seedAppliedFixture();
		const api = createDirectorApi(fake.editor);
		const before = fake.editor.command.getHistoryLength();
		const run = runProgram({
			source: CUT_ON_BEAT_PROGRAM,
			mode: "apply",
			api,
			data: {
				tracks: () => fake.editor.timeline.getTracks(),
				beatGrid: () => useBeatGridStore.getState().grid,
			},
		});
		expect(run.ok).toBe(true);
		expect(run.ops.length).toBe(2);
		// Two verb calls, two `withAgentOrigin` transactions, two entries — the
		// contrast that shows the batching above is doing real work.
		expect(fake.editor.command.getHistoryLength()).toBe(before + 2);
	});
});

/**
 * PLAN PARITY for `tightenToLength` as a program — same shape as
 * `cut-on-beat.program.test.ts` (see that file's header for the methodology
 * this one reuses, and `programs/tighten-to-length.ts`'s header for WHY
 * Phase 1 / `trimmableSegments` is deliberately not part of this proof: it
 * is unreachable from the verb as shipped — zero callers ever populate it —
 * so a program matching Phase 2 alone matches the verb's real behaviour
 * exactly, not a narrowed subset of it).
 *
 * Each fixture pins one documented decision from the macro's own header/
 * test suite (`craft/tighten-to-length.test.ts`, minus the
 * `trimmableSegments` cases): the no-op/shortfall guards, protected-range
 * capping, the `minClipDurationSec` floor, proportional water-filling
 * (single- and capacity-insufficient), the repack `move` pass, and
 * `protectSpeech: false`.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { TimelineTrack } from "@/types/timeline";
import {
	tightenToLength as planTightenToLength,
	type TightenElementInput,
	type TightenToLengthInput,
} from "../craft/tighten-to-length";
import type { CraftOp, TimeRangeSec } from "../craft/types";
import { runProgram } from "./executor";
import { makeFakeEditor, type FakeElement } from "../fake-editor";
import {
	buildTightenToLengthProgram,
	type TightenToLengthProgramOptions,
} from "./programs/tighten-to-length";

const VIDEO_TRACK_ID = "track_video";
const SPEECH_TRACK_ID = "track_speech";

interface FixtureClip {
	id: string;
	startSec: number;
	durationSec: number;
}

interface Fixture {
	name: string;
	clips: FixtureClip[];
	/** Becomes voiceover-shaped audio elements on a separate track, so speech() picks them up as whole-span intervals — same trick `duck-music-under-speech.program.test.ts` uses. */
	protectedRanges?: TimeRangeSec[];
	options: Omit<TightenToLengthProgramOptions, "trackId">;
}

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
			trimStart: 0,
			trimEnd: 0,
		})),
	};
	const tracks: TimelineTrack[] = [video as unknown as TimelineTrack];
	if (fixture.protectedRanges && fixture.protectedRanges.length > 0) {
		const speech = {
			id: SPEECH_TRACK_ID,
			type: "audio",
			elements: fixture.protectedRanges.map((range, i) => ({
				id: `vo${i}`,
				type: "audio",
				name: "voiceover take",
				mediaId: `media_vo${i}`,
				startTime: range.startSec,
				duration: range.endSec - range.startSec,
				trimStart: 0,
				trimEnd: 0,
				volume: 1,
				generation: { kind: "voiceover" },
			})),
		};
		tracks.push(speech as unknown as TimelineTrack);
	}
	return tracks;
}

/** What the MACRO is given, mirroring how `director-api.ts`'s `tightenToLength` verb derives it (no `trimmableSegments` — see this file's header). */
function macroInput(fixture: Fixture): TightenToLengthInput {
	const elements: TightenElementInput[] = fixture.clips.map((clip) => ({
		elementId: clip.id,
		startSec: clip.startSec,
		durationSec: clip.durationSec,
	}));
	const protectSpeech = fixture.options.protectSpeech ?? true;
	return {
		elements,
		targetDurationSec: fixture.options.targetDurationSec,
		protectedRanges: protectSpeech ? (fixture.protectedRanges ?? []) : [],
		minClipDurationSec: fixture.options.minClipDurationSec,
		convergenceToleranceSec: fixture.options.convergenceToleranceSec,
	};
}

const FIXTURES: Fixture[] = [
	{
		name: "no-op when the current runtime is already within tolerance of the target",
		clips: [{ id: "a", startSec: 0, durationSec: 5 }],
		options: { targetDurationSec: 5 },
	},
	{
		name: "no ops when the target is longer than the current cut (shortfall, not an error)",
		clips: [{ id: "a", startSec: 0, durationSec: 5 }],
		options: { targetDurationSec: 10 },
	},
	{
		name: "never trims into a protected range, even tail-only",
		clips: [{ id: "a", startSec: 0, durationSec: 10 }],
		protectedRanges: [{ startSec: 8, endSec: 9 }],
		options: { targetDurationSec: 9 },
	},
	{
		name: "a protected range that makes the target unreachable still trims the best partial",
		clips: [{ id: "a", startSec: 0, durationSec: 10 }],
		protectedRanges: [{ startSec: 8, endSec: 9 }],
		options: { targetDurationSec: 5 },
	},
	{
		name: "never trims an element below the default minClipDurationSec",
		clips: [
			{ id: "a", startSec: 0, durationSec: 1 },
			{ id: "b", startSec: 1, durationSec: 1 },
		],
		options: { targetDurationSec: 1 },
	},
	{
		name: "respects a configurable minClipDurationSec floor (and reports the shortfall)",
		clips: [{ id: "a", startSec: 0, durationSec: 10 }],
		options: { targetDurationSec: 1, minClipDurationSec: 4 },
	},
	{
		name: "distributes the remainder proportionally to each element's tail capacity — single pass",
		clips: [
			{ id: "a", startSec: 0, durationSec: 3 },
			{ id: "b", startSec: 3, durationSec: 10 },
		],
		options: { targetDurationSec: 10 },
	},
	{
		name: "capacity-insufficient case saturates every element and reports the shortfall (two-pass water-fill)",
		clips: [
			{ id: "a", startSec: 0, durationSec: 1 },
			{ id: "b", startSec: 1, durationSec: 1 },
			{ id: "c", startSec: 2, durationSec: 1 },
		],
		options: { targetDurationSec: 0.1 },
	},
	{
		name: "emits a move op for every downstream element whose start shifted",
		clips: [
			{ id: "a", startSec: 0, durationSec: 10 },
			{ id: "b", startSec: 10, durationSec: 5 },
		],
		options: { targetDurationSec: 13 },
	},
	{
		name: "omits a move op when trimming only the last element (nothing downstream shifts)",
		clips: [
			{ id: "a", startSec: 0, durationSec: 10 },
			{ id: "b", startSec: 10, durationSec: 5 },
		],
		options: { targetDurationSec: 12 },
	},
	{
		name: "protectSpeech: false ignores an available protected range",
		clips: [{ id: "a", startSec: 0, durationSec: 10 }],
		protectedRanges: [{ startSec: 8, endSec: 9 }],
		options: { targetDurationSec: 5, protectSpeech: false },
	},
	{
		name: "a configurable convergenceToleranceSec changes what counts as converged",
		clips: [{ id: "a", startSec: 0, durationSec: 5 }],
		options: { targetDurationSec: 4.9, convergenceToleranceSec: 0.05 },
	},
	{
		name: "three elements, single-pass proportional split with a protected middle element",
		clips: [
			{ id: "a", startSec: 0, durationSec: 4 },
			{ id: "b", startSec: 4, durationSec: 4 },
			{ id: "c", startSec: 8, durationSec: 4 },
		],
		protectedRanges: [{ startSec: 5, endSec: 7 }],
		options: { targetDurationSec: 9 },
	},
];

describe("tightenToLength as a program — plan parity with craft/tighten-to-length.ts", () => {
	for (const fixture of FIXTURES) {
		it(fixture.name, () => {
			const tracks = fixtureTracks(fixture);
			const expected = planTightenToLength(macroInput(fixture));

			const source = buildTightenToLengthProgram({
				...fixture.options,
				trackId: VIDEO_TRACK_ID,
			});
			const run = runProgram({
				source,
				mode: "dry-run",
				data: { tracks: () => tracks },
			});

			expect(run.failure).toBeUndefined();
			expect(run.ok).toBe(true);

			const actual: CraftOp[] = run.ops.map((op) => ({
				verb: op.verb as string,
				args: op.args as Record<string, unknown>,
			}));
			expect(actual).toEqual(expected.ops);
			// Nothing was applied: the timeline fixture is untouched.
			expect(tracks[0].elements[0].duration).toBe(fixture.clips[0].durationSec);
		});
	}

	it("resolves the target track the same way cutOnBeat's program does — first video track when trackId is omitted", () => {
		const fixture = FIXTURES[6];
		const tracks = fixtureTracks(fixture);
		const expected = planTightenToLength(macroInput(fixture));

		const source = buildTightenToLengthProgram(fixture.options);
		const run = runProgram({
			source,
			mode: "dry-run",
			data: { tracks: () => tracks },
		});

		expect(run.ok).toBe(true);
		const actual: CraftOp[] = run.ops.map((op) => ({
			verb: op.verb as string,
			args: op.args as Record<string, unknown>,
		}));
		expect(actual).toEqual(expected.ops);
	});

	it("a dry run applies nothing even though it plans ops", () => {
		const fixture = FIXTURES[6];
		const tracks = fixtureTracks(fixture);
		const source = buildTightenToLengthProgram({
			...fixture.options,
			trackId: VIDEO_TRACK_ID,
		});
		const run = runProgram({
			source,
			data: { tracks: () => tracks },
		});
		expect(run.mode).toBe("dry-run");
		expect(run.ops.length).toBeGreaterThan(0);
		expect(run.ops.every((op) => op.result === undefined)).toBe(true);
	});
});

// ── APPLIED PARITY ───────────────────────────────────────────────────────────
//
// Moved here (not deleted) from `director-craft.test.ts`'s now-retired
// `tightenToLength` describe block's "proportionally tightens to the target
// as ONE undo entry" case — same "move, don't drop" rule the brief states for
// scenario evals, applied to this applied-behaviour unit case too. Uses
// GENERATIVE slots (not plain clips): `trim`/`move` resolve through the api's
// `findSlot` — see `programs/cut-on-beat.ts`'s own applied-parity fixture for
// the same reasoning and pattern this one is copied from.

const { createDirectorApi } = await import("../director-api");
const { EditorCore: EditorCoreClass } = await import("@/core");
const { UpdateElementTrimCommand } = await import(
	"@/lib/commands/timeline/element/update-element-trim"
);
const { MoveElementCommand } = await import(
	"@/lib/commands/timeline/element/move-elements"
);

function makeTrimmableMovableFakeEditor() {
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
		moveElement: (input: {
			sourceTrackId: string;
			targetTrackId: string;
			elementId: string;
			newStartTime: number;
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
	timeline.moveElement = (input) => {
		fake.editor.command.execute({
			command: new MoveElementCommand(input as never),
		});
	};
	return fake;
}

let restoreGetInstance: (() => void) | undefined;

afterEach(() => {
	restoreGetInstance?.();
	restoreGetInstance = undefined;
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

describe("tightenToLength as a program — applied parity against a live editor", () => {
	it("proportionally tightens two equal-capacity slots to the target, as ONE undo entry", () => {
		const fake = makeTrimmableMovableFakeEditor();
		patchEditorSingleton(fake.editor);
		const api = createDirectorApi(fake.editor);

		const generation = {
			prompt: "a shot",
			model: "test-model",
			duration: 5,
		} as never;
		const c1 = fake.editor.timeline.insertElement({
			element: {
				type: "video",
				mediaId: "m1",
				name: "clip 1",
				startTime: 0,
				duration: 5,
				generation,
				...visualBase,
			},
			placement: { mode: "auto", trackType: "video" },
		});
		const c2 = fake.editor.timeline.insertElement({
			element: {
				type: "video",
				mediaId: "m2",
				name: "clip 2",
				startTime: 5,
				duration: 5,
				generation,
				...visualBase,
			},
			placement: { mode: "auto", trackType: "video" },
		});

		const historyBefore = fake.editor.command.getHistoryLength();
		const source = buildTightenToLengthProgram({
			targetDurationSec: 8,
			trackId: fake.find(c1)?.track.id,
		});
		const run = runProgram({
			source,
			mode: "apply",
			api,
			undo: fake.editor.command,
			data: { tracks: () => fake.editor.timeline.getTracks() },
		});

		expect(run.failure).toBeUndefined();
		expect(run.ok).toBe(true);
		expect(fake.editor.command.getHistoryLength()).toBe(historyBefore + 1);

		const left = fake.find(c1)?.element as FakeElement;
		const right = fake.find(c2)?.element as FakeElement;
		// Even split of the 2s excess (both clips have equal tail capacity).
		expect(left.duration).toBeCloseTo(4, 5);
		expect(right.duration).toBeCloseTo(4, 5);
		expect(right.startTime).toBeCloseTo(4, 5); // re-packed contiguously

		const undone = api.undo();
		expect(undone.ok).toBe(true);
		expect((fake.find(c1)?.element as FakeElement).duration).toBeCloseTo(5, 5);
		expect((fake.find(c2)?.element as FakeElement).startTime).toBeCloseTo(5, 5);
	});
});

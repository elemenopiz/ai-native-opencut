/**
 * PLAN PARITY for `duckMusicUnderSpeech` as a program — same shape as
 * `cut-on-beat.program.test.ts` (see that file's header for the methodology
 * this one deliberately reuses): the program in
 * `programs/duck-music-under-speech.ts` runs over a timeline fixture, and its
 * dry-run op list must be deep-equal to the frozen macro's
 * `duckMusicUnderSpeech(...)`'s `ops`, fed the SAME speech intervals and
 * music elements the fixture implies (mirroring how `director-api.ts`'s
 * `gatherSpeechIntervals`/`gatherMusicElements` derive them).
 *
 * Each fixture exercises one documented decision from the macro's own header
 * (`craft/duck-music-under-speech.ts`): the full attack/duck/recover/release
 * cycle, gap-merging, the flutter guard, element-boundary clamping, multiple
 * music elements, non-overlap, transcript-derived (not voiceover-shaped)
 * speech, and custom duck/attack/release/merge-gap options.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { TimelineElement, TimelineTrack } from "@/types/timeline";
import type { AssetTranscript } from "@/lib/search/asset-transcript";
import {
	duckMusicUnderSpeech as planDuckMusicUnderSpeech,
	type DuckMusicElement,
	type SpeechInterval,
} from "../craft/duck-music-under-speech";
import type { CraftOp } from "../craft/types";
import { runProgram } from "./executor";
import { makeFakeEditor, type FakeElement } from "../fake-editor";
import {
	buildDuckMusicUnderSpeechProgram,
	DUCK_MUSIC_UNDER_SPEECH_PROGRAM,
	type DuckMusicUnderSpeechProgramOptions,
} from "./programs/duck-music-under-speech";

const AUDIO_TRACK_ID = "track_audio";

/** One voiceover-shaped audio element — its own span IS speech, no transcript needed. */
interface VoiceoverFixtureElement {
	kind: "voiceover";
	id: string;
	startSec: number;
	durationSec: number;
}

/** One music-bed audio element — a ducking target. */
interface MusicFixtureElement {
	kind: "music";
	id: string;
	startSec: number;
	durationSec: number;
}

/** One transcript-carrying element — speech comes from its (asset-relative) transcript segments, not its own span. */
interface TranscriptFixtureElement {
	kind: "transcript";
	id: string;
	startSec: number;
	durationSec: number;
	mediaId: string;
	segments: { start: number; end: number; text: string }[];
}

type FixtureElement =
	| VoiceoverFixtureElement
	| MusicFixtureElement
	| TranscriptFixtureElement;

interface Fixture {
	name: string;
	elements: FixtureElement[];
	options?: DuckMusicUnderSpeechProgramOptions;
}

function buildTracks(fixture: Fixture): {
	tracks: TimelineTrack[];
	transcripts: Map<string, AssetTranscript>;
} {
	const transcripts = new Map<string, AssetTranscript>();
	const elements: unknown[] = fixture.elements.map((el) => {
		if (el.kind === "voiceover") {
			return {
				id: el.id,
				type: "audio",
				name: "voiceover take",
				mediaId: `media_${el.id}`,
				startTime: el.startSec,
				duration: el.durationSec,
				trimStart: 0,
				trimEnd: 0,
				volume: 1,
				generation: { kind: "voiceover" },
			};
		}
		if (el.kind === "music") {
			return {
				id: el.id,
				type: "audio",
				name: "music bed",
				mediaId: `media_${el.id}`,
				startTime: el.startSec,
				duration: el.durationSec,
				trimStart: 0,
				trimEnd: 0,
				volume: 1,
			};
		}
		transcripts.set(el.mediaId, {
			segments: el.segments.map((s) => ({
				start: s.start,
				end: s.end,
				text: s.text,
			})),
		} as unknown as AssetTranscript);
		return {
			id: el.id,
			type: "video",
			name: el.id,
			mediaId: el.mediaId,
			startTime: el.startSec,
			duration: el.durationSec,
			trimStart: 0,
			trimEnd: 0,
		};
	});
	const track = {
		id: AUDIO_TRACK_ID,
		type: "audio",
		elements,
	} as unknown as TimelineTrack;
	return { tracks: [track], transcripts };
}

/** What the MACRO is given, derived from the fixture the same way `gatherSpeechIntervals`/`gatherMusicElements` would. */
function macroInputs(fixture: Fixture): {
	speechIntervals: SpeechInterval[];
	musicElements: DuckMusicElement[];
} {
	const speechIntervals: SpeechInterval[] = [];
	const musicElements: DuckMusicElement[] = [];
	for (const el of fixture.elements) {
		if (el.kind === "voiceover") {
			speechIntervals.push({
				startSec: el.startSec,
				endSec: el.startSec + el.durationSec,
			});
		} else if (el.kind === "music") {
			musicElements.push({
				elementId: el.id,
				startSec: el.startSec,
				durationSec: el.durationSec,
			});
		} else {
			for (const seg of el.segments) {
				// sourceRangeToTimelineRange for a zero-trim, non-reversed,
				// playbackRate-1 element is a plain offset by startSec.
				speechIntervals.push({
					startSec: el.startSec + seg.start,
					endSec: el.startSec + seg.end,
				});
			}
		}
	}
	return { speechIntervals, musicElements };
}

const FIXTURES: Fixture[] = [
	{
		name: "full attack/duck/recover/release cycle for one speech interval",
		elements: [
			{ kind: "voiceover", id: "vo1", startSec: 5, durationSec: 3 },
			{ kind: "music", id: "m1", startSec: 0, durationSec: 20 },
		],
	},
	{
		name: "gap-merges two speech intervals separated by less than mergeGapSec",
		elements: [
			{ kind: "voiceover", id: "vo1", startSec: 5, durationSec: 1 },
			{ kind: "voiceover", id: "vo2", startSec: 6.2, durationSec: 0.8 },
			{ kind: "music", id: "m1", startSec: 0, durationSec: 20 },
		],
	},
	{
		name: "does not gap-merge intervals at/above mergeGapSec — two separate cycles",
		elements: [
			{ kind: "voiceover", id: "vo1", startSec: 5, durationSec: 1 },
			{ kind: "voiceover", id: "vo2", startSec: 6.4, durationSec: 1 },
			{ kind: "music", id: "m1", startSec: 0, durationSec: 20 },
		],
	},
	{
		name: "flutter guard collapses two gap-merged-but-still-close intervals into one ducked span",
		// gap between vo1 end (6) and vo2 start (6.35) is 0.35s: >= default
		// mergeGapSec (0.3, no gap-merge) but < attack+release (0.15+0.4=0.55,
		// so the per-element flutter guard collapses them).
		elements: [
			{ kind: "voiceover", id: "vo1", startSec: 5, durationSec: 1 },
			{ kind: "voiceover", id: "vo2", startSec: 6.35, durationSec: 1 },
			{ kind: "music", id: "m1", startSec: 0, durationSec: 20 },
		],
	},
	{
		name: "speech starting before the element and ending after it clamps fade times to element bounds",
		elements: [
			{ kind: "voiceover", id: "vo1", startSec: -2, durationSec: 20 },
			{ kind: "music", id: "m1", startSec: 3, durationSec: 5 },
		],
	},
	{
		name: "two music elements — only the overlapping one gets an op",
		elements: [
			{ kind: "voiceover", id: "vo1", startSec: 5, durationSec: 2 },
			{ kind: "music", id: "m1", startSec: 0, durationSec: 20 },
			{ kind: "music", id: "m2", startSec: 30, durationSec: 5 },
		],
	},
	{
		name: "no overlap between any music element and speech — no ops",
		elements: [
			{ kind: "voiceover", id: "vo1", startSec: 40, durationSec: 2 },
			{ kind: "music", id: "m1", startSec: 0, durationSec: 20 },
		],
	},
	{
		name: "transcript-derived (not voiceover-shaped) speech ducks the same way",
		elements: [
			{
				kind: "transcript",
				id: "clip1",
				startSec: 2,
				durationSec: 10,
				mediaId: "media_dialogue",
				segments: [{ start: 1, end: 4, text: "hello there" }],
			},
			{ kind: "music", id: "m1", startSec: 0, durationSec: 20 },
		],
	},
	{
		name: "custom duck/attack/release/mergeGap options",
		elements: [
			{ kind: "voiceover", id: "vo1", startSec: 5, durationSec: 1 },
			{ kind: "voiceover", id: "vo2", startSec: 6.9, durationSec: 1 },
			{ kind: "music", id: "m1", startSec: 0, durationSec: 20 },
		],
		options: {
			duckAmountDb: -6,
			attackSec: 0.3,
			releaseSec: 0.6,
			mergeGapSec: 1.0,
		},
	},
];

describe("duckMusicUnderSpeech as a program — plan parity with craft/duck-music-under-speech.ts", () => {
	for (const fixture of FIXTURES) {
		it(fixture.name, () => {
			const { tracks, transcripts } = buildTracks(fixture);
			const { speechIntervals, musicElements } = macroInputs(fixture);
			const expected = planDuckMusicUnderSpeech(
				speechIntervals,
				musicElements,
				{
					duckAmountDb: fixture.options?.duckAmountDb,
					attackSec: fixture.options?.attackSec,
					releaseSec: fixture.options?.releaseSec,
					mergeGapSec: fixture.options?.mergeGapSec,
				},
			);

			const source = buildDuckMusicUnderSpeechProgram(fixture.options ?? {});
			const run = runProgram({
				source,
				mode: "dry-run",
				data: {
					tracks: () => tracks,
					transcripts: (mediaId: string) => transcripts.get(mediaId),
				},
			});

			expect(run.failure).toBeUndefined();
			expect(run.ok).toBe(true);

			const actual: CraftOp[] = run.ops.map((op) => ({
				verb: op.verb as string,
				args: op.args as Record<string, unknown>,
			}));
			expect(actual).toEqual(expected.ops);
		});
	}

	it("the default-options program is exactly DUCK_MUSIC_UNDER_SPEECH_PROGRAM", () => {
		expect(buildDuckMusicUnderSpeechProgram()).toBe(
			DUCK_MUSIC_UNDER_SPEECH_PROGRAM,
		);
	});

	it("a dry run applies nothing even though it plans an op", () => {
		const fixture = FIXTURES[0];
		const { tracks, transcripts } = buildTracks(fixture);
		const run = runProgram({
			source: DUCK_MUSIC_UNDER_SPEECH_PROGRAM,
			data: {
				tracks: () => tracks,
				transcripts: (mediaId: string) => transcripts.get(mediaId),
			},
		});
		expect(run.mode).toBe("dry-run");
		expect(run.ops.length).toBe(1);
		expect(run.ops[0].verb).toBe("animateItem");
		expect(run.ops.every((op) => op.result === undefined)).toBe(true);
	});
});

// ── APPLIED PARITY ───────────────────────────────────────────────────────────
//
// Moved here (not deleted) from `director-craft.test.ts`'s now-retired
// `duckMusicUnderSpeech` describe block's "ducks the music bed under a
// voiceover span as ONE undo entry" case — the brief's "an eval asserting the
// verb exists must move to asserting the program produces the same result"
// rule applies to this applied-behaviour case as much as to a scenario eval.
// `animateItem` needs no generative-slot targeting swap (it already resolves
// via `findElement` — see `director-api.ts`'s craft section header), so,
// unlike `cutOnBeat`'s applied test, this fixture uses a PLAIN music element.

const { createDirectorApi } = await import("../director-api");
const { EditorCore: EditorCoreClass } = await import("@/core");
const { UpsertKeyframeCommand } = await import(
	"@/lib/commands/timeline/element/keyframes/upsert-keyframe"
);
const { BatchCommand } = await import("@/lib/commands/batch-command");

function makeAnimatableFakeEditor() {
	const fake = makeFakeEditor();
	const timeline = fake.editor.timeline as unknown as {
		getTracks: () => TimelineTrack[];
		updateTracks: (tracks: TimelineTrack[]) => void;
		upsertKeyframes: (input: {
			keyframes: Array<{
				trackId: string;
				elementId: string;
				propertyPath: string;
				time: number;
				value: unknown;
				interpolation?: string;
			}>;
		}) => void;
	};
	const liveGetTracks = timeline.getTracks;
	timeline.getTracks = () => [...liveGetTracks()] as TimelineTrack[];
	timeline.updateTracks = (tracks: TimelineTrack[]) => {
		fake.tracks.length = 0;
		fake.tracks.push(...(tracks as unknown as typeof fake.tracks));
	};
	timeline.upsertKeyframes = ({ keyframes }) => {
		if (keyframes.length === 0) return;
		const commands = keyframes.map(
			(kf) => new UpsertKeyframeCommand(kf as never),
		);
		const command =
			commands.length === 1 ? commands[0] : new BatchCommand(commands);
		fake.editor.command.execute({ command });
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

describe("duckMusicUnderSpeech as a program — applied parity against a live editor", () => {
	it("ducks the music bed under a voiceover span, as ONE undo entry", () => {
		const fake = makeAnimatableFakeEditor();
		patchEditorSingleton(fake.editor);
		const api = createDirectorApi(fake.editor);

		// Speech: voiceover-shaped audio element, timeline 2s–5s.
		fake.editor.timeline.addVoiceoverSlot({ startTime: 2, duration: 3 });
		// Music bed: a plain (non-voiceover-named) audio element.
		const musicId = fake.editor.timeline.insertElement({
			element: {
				type: "audio",
				sourceType: "upload",
				mediaId: "media_song",
				name: "Background Music",
				volume: 1,
				startTime: 0,
				duration: 10,
				trimStart: 0,
				trimEnd: 0,
			},
			placement: { mode: "auto", trackType: "audio" },
		});

		const historyBefore = fake.editor.command.getHistoryLength();
		const run = runProgram({
			source: DUCK_MUSIC_UNDER_SPEECH_PROGRAM,
			mode: "apply",
			api,
			undo: fake.editor.command,
			data: { tracks: () => fake.editor.timeline.getTracks() },
		});

		expect(run.failure).toBeUndefined();
		expect(run.ok).toBe(true);
		expect(run.ops.length).toBe(1);
		expect(fake.editor.command.getHistoryLength()).toBe(historyBefore + 1);

		const music = fake.find(musicId)?.element as FakeElement & {
			animations?: {
				channels: Record<
					string,
					{ keyframes: { value: number }[] } | undefined
				>;
			};
		};
		const channel = music.animations?.channels.volume;
		expect(channel).toBeDefined();
		expect(channel?.keyframes.length).toBeGreaterThan(0);
		const values = channel?.keyframes.map((k) => k.value) ?? [];
		expect(Math.min(...values)).toBeLessThan(1);

		const undone = api.undo();
		expect(undone.ok).toBe(true);
		const musicAfterUndo = fake.find(musicId)?.element as FakeElement & {
			animations?: { channels: Record<string, unknown> };
		};
		expect(musicAfterUndo.animations?.channels.volume).toBeUndefined();
	});
});

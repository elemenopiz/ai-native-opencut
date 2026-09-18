/**
 * `cutOnBeat` (P5 craft macro) end to end through the real agent loop —
 * `docs/plans/2026-09-18-director-autonomy-architecture.md` §6 names exactly
 * this pillar as the one the eval harness has to cover BEFORE it can be
 * migrated from a frozen macro verb to a composable program (§2 "Layer 2 —
 * Programs, not macros"): "The agent can invoke the opinion but cannot vary
 * it... those are the interesting choices, and the macro is exactly what
 * forbids them." When `cutOnBeat` becomes a program the model writes over
 * beat/clip data instead of a verb it calls, THIS scenario must still pass
 * unmodified — which is only true if its assertions never mention the verb.
 *
 * THE ASSERTION RULE, applied: every assertion below reads the RESULTING
 * TIMELINE STATE (cut positions, durations) off `getTimeline`/direct element
 * lookups — never "was `cutOnBeat` called." `mustCallVerbs` in `expect` is
 * the one necessary exception, and it's there for a DIFFERENT reason than
 * timeline correctness: it's what proves the scripted turn actually ran
 * (a silently-skipped tool call would otherwise leave the timeline
 * unchanged and this scenario would falsely read as "nothing to snap,
 * already passing"). See the craft-macro scenarios' shared header note in
 * `evals/README.md`-style commentary repeated in the sibling
 * tighten/duck-music scenario files.
 *
 * FIXTURE: a beat-analyzed music clip (the "beat source" — its own timeline
 * position is irrelevant to `cutOnBeat`, only the `useBeatGridStore` entry
 * it seeded matters — see `stores/beat-grid-store.ts`) plus two video clips
 * cut together with their join intentionally 0.1s off the nearest beat, the
 * exact "editor already cut this on their own footage, now wants it to feel
 * musical" scenario `cutOnBeat`'s own doc comment describes.
 */

import { createDirectorApi } from "../director-api";
import { makeFakeEditor, type FakeEditor } from "../fake-editor";
import { useBeatGridStore, type BeatGrid } from "@/stores/beat-grid-store";
import {
	closeTurn,
	insertClip,
	patchTrim,
	toolTurn,
	type EvalScenario,
} from "./fixtures";

/** The join between the two video clips sits at 3.9s; the analyzed beat is at
 *  4.0s — a 0.1s gap, well inside the macro's default 0.15s tolerance, so it
 *  DOES snap (this is not the "already on beat" no-op case). */
const CLIP_ONE_DURATION_SEC = 3.9;
const BEAT_TIME_SEC = 4.0;

function setupCutOnBeatProject() {
	const fake = makeFakeEditor();
	patchTrim(fake);
	const director = createDirectorApi(fake.editor);

	// A dedicated beat-source element, decoupled from the video clips it's
	// snapping (same fixture shape `director-craft.test.ts` uses for the
	// production-level wiring test) — 20s of source so the 4.0s beat falls
	// inside its visible range (`mapBeatsToTimeline` clips beats outside
	// `getVisibleSourceRange`).
	const beatSourceId = insertClip(
		fake,
		{
			id: "el_beat_source",
			type: "audio",
			name: "synth-loop.mp3",
			mediaId: "m_synth_loop",
			startTime: 0,
			duration: 20,
			trimStart: 0,
			trimEnd: 0,
		},
		{ mode: "auto", trackType: "audio" },
	);
	const grid: BeatGrid = {
		elementId: beatSourceId,
		trackId: fake.find(beatSourceId)?.track.id ?? "",
		mediaId: "m_synth_loop",
		beats: [BEAT_TIME_SEC],
		downbeats: [BEAT_TIME_SEC],
		bpm: 120,
		energyClass: "energetic",
		analyzedAt: 0,
	};
	useBeatGridStore.getState().setGrid(grid);

	// Two hand-cut-together clips — a human editor's join, not a Director verb.
	const clipOneId = insertClip(
		fake,
		{
			id: "el_clip_one",
			type: "video",
			name: "handheld-walk.mp4",
			mediaId: "m_walk",
			startTime: 0,
			duration: CLIP_ONE_DURATION_SEC,
			trimStart: 0,
			trimEnd: 0,
		},
		{ mode: "auto", trackType: "video" },
	);
	const clipTwoId = insertClip(
		fake,
		{
			id: "el_clip_two",
			type: "video",
			name: "handheld-turn.mp4",
			mediaId: "m_turn",
			startTime: CLIP_ONE_DURATION_SEC,
			duration: 5,
			trimStart: 0,
			trimEnd: 0,
		},
		{ mode: "auto", trackType: "video" },
	);

	return { fake, director, clipOneId, clipTwoId };
}

export const cutOnBeatScenario: EvalScenario = {
	id: "cut-on-beat-snaps-join-to-analyzed-beat",
	description:
		'Two hand-cut clips joined 0.1s off an analyzed beat + "snap this to the ' +
		'beat": cutOnBeat must pull the join exactly onto the beat as ONE undo ' +
		"step, asserted on the resulting clip boundaries — not on the verb name.",
	userMessage: "snap this cut onto the beat, it feels a hair off",
	setup: setupCutOnBeatProject,
	turns: () => [
		toolTurn("Snapping the join onto the nearest beat.", "t1", "cutOnBeat", {}),
		closeTurn(
			"Snapped the cut right onto the beat — should read as musical now.",
		),
	],
	expect: {
		mustCallVerbs: ["cutOnBeat"],
		mustNotAwaitApproval: true,
		mustNotGenerate: true,
	},
};

/** How many undo entries the fixture starts with — 2 hand-placed clips + 1
 *  beat-source clip, each via `insertClip`'s own `Command`, PLUS this
 *  scenario never calls anything that adds more before `cutOnBeat` runs. Kept
 *  as a named export so `evals.test.ts` doesn't hardcode a magic number next
 *  to the one-undo-step assertion it makes about `cutOnBeat`'s OWN effect. */
export const CUT_ON_BEAT_FIXTURE_HISTORY_LENGTH = 3;

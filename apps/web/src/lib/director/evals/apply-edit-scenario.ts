/**
 * `applyEdit` (the program-engine composition verb — `lib/director/program/*`)
 * end to end through the real agent loop, exercising the two things this
 * verb's whole design rests on:
 *
 *  1. THE INSPECT-THEN-APPLY LOOP is the safety story
 *     (`program/executor.ts`'s threat-model point 7 and this verb's own
 *     tool-catalog description): the SAME program text is sent TWICE — first
 *     with `mode: "dry-run"` (default), then `mode: "apply"` — and the
 *     fixture proves the dry-run call genuinely touched nothing (the undo
 *     history only grows by ONE entry across both calls, not two) before the
 *     apply call actually lands the edit.
 *  2. THE WIDENED TARGETING (Wave 2A — `director-api.ts`'s
 *     `findSlotOrElement`) closes `program/primitives.ts`'s TARGETING
 *     CAVEAT: a program can now `trim()` PLAIN PLACED FOOTAGE (a hand-placed
 *     clip with no `.generation` recipe — never a reel slot), not just
 *     generative slots. The one program below trims BOTH a plain clip and a
 *     real generative slot in the SAME run, proving the widening reaches
 *     plain footage without regressing the pre-existing slot path.
 *
 * THE ASSERTION RULE (same discipline `craft-cut-on-beat-scenario.ts` follows
 * — see its own header): assertions read the RESULTING TIMELINE STATE (the
 * two elements' actual `trimStart`/`duration` after the run, and the exact
 * undo-history length) rather than "was applyEdit called" — `mustCallVerbs`
 * is the one necessary exception, there only to prove the scripted turns
 * actually ran rather than the loop silently skipping them.
 *
 * The program text discovers its own targets via `clips()` (rather than the
 * fixture baking real ids into the program string) — `isSlot` distinguishes
 * the plain clip from the generative slot, exactly the field
 * `program/derived-data.ts`'s `toClipValue` added for precisely this
 * targeting question. This also sidesteps `agent.ts`'s short-id expansion
 * entirely: `expandIdArgs` only rewrites the OUTER tool call's `slotId`/
 * `takeId`/`slotIds` fields (see its own doc comment), never the CONTENTS of
 * a `program` string, so ids the program resolves internally are always real,
 * full ids regardless of what short ids a model would otherwise see.
 */

import { createDirectorApi } from "../director-api";
import { makeFakeEditor } from "../fake-editor";
import {
	insertClip,
	patchTrim,
	toolTurn,
	closeTurn,
	type EvalScenario,
} from "./fixtures";

const PLAIN_CLIP_DURATION_SEC = 8;
const PLAIN_CLIP_TRIM_SEC = 1;
const SLOT_DURATION_SEC = 10;
const SLOT_TRIM_SEC = 2;

/**
 * The program under test: find the one plain (non-slot) video clip and the
 * one generative video slot by scanning `clips()`, then trim BOTH — a single
 * program, a single undo entry, touching a target class
 * (`trim`/`move`/`split`/`remove`/`applyTransition`/`applyEffect`'s pre-Wave-
 * 2A `findSlot`-only resolution) could not reach at all before this widening.
 */
const APPLY_EDIT_PROGRAM = `
let cs = clips()
let plainId = ""
let plainDur = 0
let slotId = ""
let slotDur = 0
for (c of cs) {
  if (c.kind == "video") {
    if (c.isSlot == false) {
      plainId = c.id
      plainDur = c.durationSec
    } else {
      slotId = c.id
      slotDur = c.durationSec
    }
  }
}
if (plainId != "") {
  trim({ slotId: plainId, trimStart: ${PLAIN_CLIP_TRIM_SEC}, duration: plainDur - ${PLAIN_CLIP_TRIM_SEC} })
  log("trimmed plain clip", plainId)
}
if (slotId != "") {
  trim({ slotId: slotId, duration: slotDur - ${SLOT_TRIM_SEC} })
  log("trimmed generative slot", slotId)
}
`;

function setupApplyEditProject() {
	const fake = makeFakeEditor();
	patchTrim(fake);
	const director = createDirectorApi(fake.editor);

	// A hand-placed clip — bypasses every Director verb, exactly like a human
	// dragging footage onto the timeline. No `.generation` recipe, so
	// `findSlot`/`isSlotElement` never see it — the plain-footage case
	// `findSlotOrElement`'s widening exists for.
	insertClip(
		fake,
		{
			id: "el_plain_clip",
			type: "video",
			name: "handheld-broll.mp4",
			mediaId: "m_broll",
			startTime: 0,
			duration: PLAIN_CLIP_DURATION_SEC,
			trimStart: 0,
			trimEnd: 0,
		},
		{ mode: "auto", trackType: "video" },
	);

	// One real generative slot on the SAME track — proves the widening is
	// additive: the program's `trim()` call against this id must still land
	// exactly as it did before `findSlotOrElement` existed.
	director.reserveSlot({
		prompt: "drone shot of the coastline",
		duration: SLOT_DURATION_SEC,
		startTime: PLAIN_CLIP_DURATION_SEC,
	});

	return { fake, director };
}

export const applyEditScenario: EvalScenario = {
	id: "apply-edit-dry-run-then-apply-widened-targeting",
	description:
		"A plain placed clip + a generative slot, then a program that trims " +
		"BOTH: dry-run first (must change nothing), then apply (must land as " +
		"ONE undo step) — proving the inspect-then-apply loop and the widened " +
		"plain-footage targeting together.",
	userMessage:
		"trim a second off the b-roll and two seconds off the drone shot",
	setup: setupApplyEditProject,
	turns: () => [
		toolTurn(
			"Let me check what this program would do first.",
			"t1",
			"applyEdit",
			{ program: APPLY_EDIT_PROGRAM, mode: "dry-run" },
		),
		toolTurn("Looks right — applying it now.", "t2", "applyEdit", {
			program: APPLY_EDIT_PROGRAM,
			mode: "apply",
		}),
		closeTurn("Trimmed both the b-roll and the drone shot in one edit."),
	],
	expect: {
		mustCallVerbs: ["applyEdit"],
		orderedVerbPrefix: ["applyEdit", "applyEdit"],
		mustNotAwaitApproval: true,
		mustNotGenerate: true,
	},
};

/** How many undo entries the fixture starts with before any `applyEdit` call
 *  — one `insertClip` (the plain clip) + one `reserveSlot` — kept as a named
 *  export so `evals.test.ts` doesn't hardcode a magic number next to the
 *  "exactly one new entry, from the apply call, not the dry run" assertion. */
export const APPLY_EDIT_FIXTURE_HISTORY_LENGTH = 2;

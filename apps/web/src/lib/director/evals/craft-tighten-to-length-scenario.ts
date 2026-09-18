/**
 * `tightenToLength` (P5 craft macro) end to end through the real agent loop —
 * same "this must survive becoming a program" rationale as
 * `craft-cut-on-beat-scenario.ts`'s header (read that file's header for the
 * full architecture-doc citation; not repeated verbatim here).
 *
 * THE ASSERTION RULE, applied: every correctness assertion reads the
 * RESULTING clip durations/positions — never "was `tightenToLength` called."
 * `mustCallVerbs` in `expect` is the one necessary exception, for the same
 * "prove the scripted call actually ran" reason `craft-cut-on-beat-
 * scenario.ts` documents.
 *
 * FIXTURE: two hand-cut-together 5s clips (10s total, no detected
 * low-interest/silence segments, so the macro's phase-1 "shave the cheap
 * material first" never engages — every second removed comes from phase 2's
 * proportional water-fill, which is the harder-to-get-right half of the
 * macro and therefore the one worth protecting). Target: 6s. Because both
 * clips start with equal duration and equal (empty) trimmable budget, the
 * proportional split is exactly even: each clip gives up 2s, landing at 3s
 * apiece — an exact, non-approximate expected result, not just a bound.
 */

import { createDirectorApi } from "../director-api";
import { makeFakeEditor } from "../fake-editor";
import {
	closeTurn,
	insertClip,
	patchMove,
	patchTrim,
	toolTurn,
	type EvalScenario,
} from "./fixtures";

const CLIP_DURATION_SEC = 5;
const TARGET_SEC = 6;
/** Both clips are identical length with no trimmable budget, so the macro's
 *  proportional phase-2 water-fill splits the 4s excess evenly: 2s off each. */
const EXPECTED_CLIP_DURATION_SEC = 3;

function setupTightenProject() {
	const fake = makeFakeEditor();
	patchTrim(fake);
	patchMove(fake);
	const director = createDirectorApi(fake.editor);

	const clipOneId = insertClip(
		fake,
		{
			id: "el_tighten_one",
			type: "video",
			name: "interview-part-1.mp4",
			mediaId: "m_int_1",
			startTime: 0,
			duration: CLIP_DURATION_SEC,
			trimStart: 0,
			trimEnd: 0,
		},
		{ mode: "auto", trackType: "video" },
	);
	const clipTwoId = insertClip(
		fake,
		{
			id: "el_tighten_two",
			type: "video",
			name: "interview-part-2.mp4",
			mediaId: "m_int_2",
			startTime: CLIP_DURATION_SEC,
			duration: CLIP_DURATION_SEC,
			trimStart: 0,
			trimEnd: 0,
		},
		{ mode: "auto", trackType: "video" },
	);

	return { fake, director, clipOneId, clipTwoId };
}

export const tightenToLengthScenario: EvalScenario = {
	id: "tighten-to-length-shrinks-to-target",
	description:
		'Two hand-cut 5s clips (10s) + "tighten this to 6 seconds": ' +
		"tightenToLength must proportionally shave both clips down to an exact, " +
		"contiguous 6s cut — asserted on the resulting clip durations/positions, " +
		"not on the verb name.",
	userMessage: "tighten this to 6 seconds",
	setup: setupTightenProject,
	turns: () => [
		toolTurn("Tightening the cut down to 6 seconds.", "t1", "tightenToLength", {
			targetSec: TARGET_SEC,
		}),
		closeTurn("Tightened it to exactly 6 seconds — trimmed both clips evenly."),
	],
	expect: {
		mustCallVerbs: ["tightenToLength"],
		durationBoundsSec: [TARGET_SEC, TARGET_SEC],
		mustNotAwaitApproval: true,
		mustNotGenerate: true,
	},
};

export {
	CLIP_DURATION_SEC as TIGHTEN_SCENARIO_ORIGINAL_CLIP_DURATION_SEC,
	EXPECTED_CLIP_DURATION_SEC as TIGHTEN_SCENARIO_EXPECTED_CLIP_DURATION_SEC,
	TARGET_SEC as TIGHTEN_SCENARIO_TARGET_SEC,
};

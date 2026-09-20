/**
 * THE UNREACHABLE-TARGET SEAM — "refine (tighten)" when the ask is
 * structurally impossible. `craft-tighten-to-length-scenario.ts` covers the
 * happy path (an achievable target, split evenly). This scenario covers what
 * the task brief calls out separately: "when the target duration cannot be
 * met" — here, a floor (`minClipDurationSec`) high enough that the two clips'
 * combined trimmable capacity can never reach the requested target.
 *
 * THE INVARIANT UNDER TEST is NOT "does it hit the target" (it structurally
 * can't) — it's that the water-fill loop in
 * `program/programs/tighten-to-length.ts` respects its own floor and gives up
 * cleanly rather than either (a) silently claiming success at a duration it
 * didn't reach, or (b) ignoring the floor and producing a degenerate/
 * negative-duration clip to force the number down. `applyEdit` itself must
 * still report `ok: true` (a shorter-than-asked-for cut is a legitimate,
 * reported outcome — not a thrown error), so this is regular expect-and-pass
 * coverage, not a negative fixture.
 */

import { createDirectorApi } from "../director-api";
import { makeFakeEditor } from "../fake-editor";
import { buildTightenToLengthProgram } from "../program/programs/tighten-to-length";
import {
	closeTurn,
	insertClip,
	patchMove,
	patchTrim,
	toolTurn,
	type EvalScenario,
} from "./fixtures";

const CLIP_DURATION_SEC = 5;
/** Unreachably aggressive — the whole point of this fixture. */
const TARGET_SEC = 1;
/** A floor well above what an even split of `TARGET_SEC` would need — this is
 *  what makes the target structurally unreachable rather than merely tight. */
const MIN_CLIP_DURATION_SEC = 4;
/** Each clip can give up at most `CLIP_DURATION_SEC - MIN_CLIP_DURATION_SEC`
 *  (1s) from capacity; both clips floor out, so the achievable total is
 *  `2 * MIN_CLIP_DURATION_SEC`, not `TARGET_SEC`. */
export const TIGHTEN_UNREACHABLE_ACHIEVED_DURATION_SEC =
	2 * MIN_CLIP_DURATION_SEC;

function setupUnreachableTightenProject() {
	const fake = makeFakeEditor();
	patchTrim(fake);
	patchMove(fake);
	const director = createDirectorApi(fake.editor);

	insertClip(
		fake,
		{
			id: "el_floor_one",
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
	insertClip(
		fake,
		{
			id: "el_floor_two",
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

	return { fake, director };
}

export const tightenTargetUnreachableScenario: EvalScenario = {
	id: "tighten-to-length-target-unreachable",
	description:
		'Two 5s clips, a 4s per-clip floor, and "tighten this to 1 second": the ' +
		"target is structurally impossible, so the program must stop at the " +
		"floor (4s per clip, 8s total) rather than overshoot it or silently " +
		"claim the impossible target was hit.",
	userMessage: "tighten this down to 1 second",
	setup: setupUnreachableTightenProject,
	turns: () => [
		toolTurn("Tightening this as far as I safely can.", "t1", "applyEdit", {
			program: buildTightenToLengthProgram({
				targetDurationSec: TARGET_SEC,
				minClipDurationSec: MIN_CLIP_DURATION_SEC,
				protectSpeech: false,
			}),
			mode: "apply",
		}),
		closeTurn(
			"I couldn't get all the way to 1 second without cutting into the " +
				"clips too aggressively — this is as tight as it safely gets at 8 " +
				"seconds.",
		),
	],
	expect: {
		mustCallVerbs: ["applyEdit"],
		durationBoundsSec: [
			TIGHTEN_UNREACHABLE_ACHIEVED_DURATION_SEC,
			TIGHTEN_UNREACHABLE_ACHIEVED_DURATION_SEC,
		],
		mustNotAwaitApproval: true,
		mustNotGenerate: true,
	},
};

export {
	CLIP_DURATION_SEC as TIGHTEN_UNREACHABLE_ORIGINAL_CLIP_DURATION_SEC,
	MIN_CLIP_DURATION_SEC as TIGHTEN_UNREACHABLE_MIN_CLIP_DURATION_SEC,
	TARGET_SEC as TIGHTEN_UNREACHABLE_TARGET_SEC,
};

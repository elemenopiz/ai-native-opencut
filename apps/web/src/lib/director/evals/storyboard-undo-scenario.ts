/**
 * UNDO OF A MULTI-STEP OPERATION — item 4 of the task brief ("failure/
 * recovery"). `storyboard` places N generative slots as ONE atomic undo
 * entry (`director-api.ts`'s `storyboard` wraps the whole shot loop in
 * `editor.command.beginTransaction()`/`commitTransaction()` — see its own
 * doc comment); this scenario locks in the user-facing half of that
 * guarantee: a single `undo` call after a multi-shot `storyboard` reverts
 * ALL of it, not just the last shot.
 *
 * THIS MATTERS FOR THE REFACTOR for a different reason than the craft-macro
 * scenarios: `docs/plans/2026-09-18-director-autonomy-architecture.md` §2
 * ("Layer 2 — Programs, not macros") proposes collapsing many verb calls
 * into ONE `applyEdit(program)` call, and §6 states the safety case in as
 * many words: "A program is inspectable before it runs, its effects are
 * enumerable, and the whole run can be one atomic undo entry." This
 * scenario is the CURRENT baseline for "one call, one undo entry, no matter
 * how many things it touched" — a `storyboard` call today, an
 * `applyEdit(program)` call tomorrow, same guarantee, same regression test
 * shape.
 *
 * THE ASSERTION RULE, applied: the assertion is "the reel has 0 slots and
 * the timeline is empty after one `undo`" — an observable end state that
 * says nothing about HOW the 3 shots got placed, only that removing them
 * again is atomic. `mustCallVerbs` is the one necessary exception, to prove
 * the scripted `storyboard`/`undo` calls actually ran (an unreachable/
 * silently-skipped `undo` would otherwise leave 3 slots on the timeline and
 * this scenario would wrongly read as a FAILURE rather than the intended
 * "should have gone back to zero").
 */

import { createDirectorApi } from "../director-api";
import { makeFakeEditor } from "../fake-editor";
import {
	closeTurn,
	readyExecutor,
	toolTurn,
	type EvalScenario,
} from "./fixtures";

function setupEmptyProjectForUndo() {
	const fake = makeFakeEditor();
	const director = createDirectorApi(fake.editor, {
		executor: readyExecutor(),
	});
	return { fake, director };
}

export const multiStepUndoScenario: EvalScenario = {
	id: "undo-reverts-whole-multishot-storyboard",
	description:
		'Empty project + "storyboard 3 shots" + "actually, undo that": a SINGLE ' +
		"undo call after a 3-shot storyboard must remove all 3 slots and return " +
		"the timeline to empty — proving storyboard's multi-shot batch is one " +
		"atomic undo entry, the baseline the future applyEdit(program) atomicity " +
		"guarantee has to match.",
	userMessage:
		"storyboard a 3-shot teaser about a sunrise hike — actually, scrap that, undo it",
	setup: setupEmptyProjectForUndo,
	turns: () => [
		toolTurn(
			"Storyboarding a 3-shot sunrise-hike sequence.",
			"t1",
			"storyboard",
			{
				shots: [
					{ prompt: "dawn light over a ridgeline", duration: 4 },
					{ prompt: "boots on a dirt trail, sunrise behind", duration: 4 },
					{ prompt: "wide summit shot, sun fully up", duration: 4 },
				],
				bible: { palette: "warm dawn light" },
			},
		),
		toolTurn(
			"Undoing the storyboard — reverting all three shots.",
			"t2",
			"undo",
			{},
		),
		closeTurn("Scrapped it — back to an empty timeline."),
	],
	expect: {
		mustCallVerbs: ["storyboard", "undo"],
		orderedVerbPrefix: ["storyboard", "undo"],
		durationBoundsSec: [0, 0],
		slotCountBounds: [0, 0],
		mustNotAwaitApproval: true,
		mustNotGenerate: true,
	},
};

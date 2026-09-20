/**
 * THE MOVED-OR-REMOVED-ELEMENT SEAM — the task brief's third named seam:
 * "when an element the plan refers to has been moved or removed." A model's
 * plan can go stale between the turn that decided on a target id and the
 * turn that acts on it (a human edit lands mid-conversation, an earlier
 * agent turn in the same run already removed the element, or the model is
 * simply working from a slightly outdated mental model of the timeline).
 *
 * WHERE THIS ACTUALLY GETS CAUGHT: not inside `trim` itself. Every direct
 * tool call's `slotId`/`takeId` is run through `agent.ts`'s `expandIdArgs`
 * BEFORE the verb ever sees it, resolving a (possibly short) id against
 * `reelShortIdMap(director)` — a `ShortIdMap` built ONLY from
 * `director.getReel().slots` (see `agent.ts`'s own doc comment on
 * `ID_ARG_FIELDS`: plain, non-generative elements and track ids are never in
 * this id space at all). `ShortIdMap.expand()` THROWS `Unknown id "..." — no
 * slot/take matches that prefix.` on a miss (`short-id.ts`) — a stale id
 * never reaches `trim`'s own `findSlotOrElement`/`failSlotNotFound` path,
 * because it never gets that far. `agent.ts`'s `executeTool` wraps this
 * exact call in a `try/catch` for precisely this reason ("Ambiguous/unknown
 * ids surface as a failed step... rather than crashing the loop"), so the
 * thrown error still degrades to a clean `ok: false` step — just with the
 * short-id layer's OWN message shape, not `trim`'s.
 *
 * STRUCTURED LIKE `brokenVerbScenario` IN `fixtures.ts`, not the "must always
 * pass" scenarios: this run contains a DELIBERATE `ok: false` step, so it is
 * NOT added to `evals.test.ts`'s `allScenarios` sweep
 * (`assertGenericInvariants`'s `assertNoUnhandledErrors` would flag it, and
 * rightly so for every scenario that sweep covers). It gets its own dedicated
 * test instead, using the assertion helpers directly — the same pattern
 * `evals.test.ts` already uses for `brokenVerbScenario`.
 *
 * The distinction from `brokenVerbScenario` that matters: THAT fixture is a
 * genuine error case (a hallucinated verb name — nothing should ever call
 * it). THIS one is a normal, expected-to-happen domain event a real agent
 * recovers from constantly — the interesting assertion is that the failure
 * degrades to a clean, non-crashing step (never a raw stack trace) and that
 * nothing on the timeline moved as a side effect of the failed call.
 */

import { createDirectorApi } from "../director-api";
import { makeFakeEditor } from "../fake-editor";
import { closeTurn, insertClip, toolTurn, type EvalScenario } from "./fixtures";

/** An id that was never minted by this fixture's `setup()` — standing in for
 *  "the plan's target element is gone" (removed by an intervening edit, or a
 *  stale id carried over from earlier in the conversation). Deliberately NOT
 *  shaped like a real generated id, so it can never accidentally collide with
 *  one via `ShortIdMap`'s prefix matching. */
const STALE_ELEMENT_ID = "el_ghost_shot_removed_earlier";

function setupStaleReferenceProject() {
	const fake = makeFakeEditor();
	const director = createDirectorApi(fake.editor);

	// A REAL generative slot, so `reelShortIdMap`'s id set is non-trivial (not
	// just "an empty reel", a different, already-covered case) — the model
	// COULD have targeted this one; it targets the stale id instead.
	director.reserveSlot({
		prompt: "drone shot of the coastline",
		duration: 6,
		startTime: 0,
	});

	// A plain hand-placed clip too, so this project also looks like a normal
	// mid-edit timeline, not a bare single-slot fixture.
	insertClip(
		fake,
		{
			id: "el_still_here",
			type: "video",
			name: "handheld-broll.mp4",
			mediaId: "m_broll",
			startTime: 6,
			duration: 8,
			trimStart: 0,
			trimEnd: 0,
		},
		{ mode: "auto", trackType: "video" },
	);

	return { fake, director };
}

export const staleReferenceScenario: EvalScenario = {
	id: "stale-reference-trim-removed-element",
	description:
		"NEGATIVE-SHAPED fixture (like brokenVerbScenario): the scripted model " +
		"targets an element id that no longer exists on the timeline — the " +
		"short-id expansion layer must degrade to a clean ok:false step (never " +
		"throw past itself), the timeline must be untouched, and the run must " +
		"still close cleanly.",
	userMessage: "trim the drone shot down a bit",
	setup: setupStaleReferenceProject,
	turns: () => [
		toolTurn("Trimming the drone shot.", "t1", "trim", {
			slotId: STALE_ELEMENT_ID,
			duration: 4,
		}),
		closeTurn(
			"I couldn't find that shot anymore — it may have been removed. Want me " +
				"to pull up the current timeline and pick another one to trim?",
		),
	],
	expect: {},
};

export { STALE_ELEMENT_ID };

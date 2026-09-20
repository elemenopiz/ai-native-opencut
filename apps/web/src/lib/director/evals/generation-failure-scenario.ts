/**
 * A GENERATION THAT FAILS MID-RUN — item 4 of the task brief ("failure/
 * recovery"). Two shots go into one `generate` call; one is designed to fail
 * with a non-retryable provider error (`director-api.ts`'s self-correction
 * loop — see `failure-classification.ts` — never retries "invalid request"),
 * the other succeeds. The point under test: a partial failure must degrade
 * gracefully to a `ok: true` step with the failed slot clearly reported, NOT
 * an unhandled step error (`assertNoUnhandledErrors` in `assertions.ts`
 * would flag a THROWN failure; a reported one is the correct, designed
 * outcome and must NOT be flagged) — and the two slots' RESULTING STATUSES
 * on the reel must reflect exactly what happened to each, independently.
 *
 * THE ASSERTION RULE, applied: every assertion reads each slot's OWN status/
 * takeCount off `getReel()` after the run — never "did `generate` report a
 * failure" as the primary check (that's corroborating, not load-bearing; see
 * `evals.test.ts`'s dedicated test for exactly which field is which).
 * `mustCallVerbs` is the one necessary exception, same "prove the call
 * actually ran" reason the other scenarios in this directory document.
 *
 * DETERMINISM: the failing executor branches on the PROMPT TEXT (a
 * structural marker, "FAIL-THIS-SHOT", not a random/flaky condition) —
 * same "no real network, no flakiness" discipline `readyExecutor` follows,
 * just with one deterministic unhappy path added.
 */

import { createDirectorApi } from "../director-api";
import { makeFakeEditor } from "../fake-editor";
import type { GenerateExecutor } from "../types";
import {
	closeTurn,
	fastRecovery,
	toolTurn,
	type EvalScenario,
} from "./fixtures";

/** Any shot whose prompt contains this marker fails, non-retryably, on every
 *  attempt — every other shot succeeds. Mirrors `director-recovery.test.ts`'s
 *  "invalid request" fixture (a `classifyFailure`-recognized non-retryable
 *  class), so the self-correction loop gives up after exactly one attempt
 *  instead of retrying (deterministic call count, no backoff to fake). */
const FAIL_MARKER = "FAIL-THIS-SHOT";

function partialFailureExecutor(): GenerateExecutor {
	return {
		run: async ({ takeId, spec }) => {
			if (spec.prompt.includes(FAIL_MARKER)) {
				return { status: "failed", error: "invalid request: bad resolution" };
			}
			return { status: "ready", mediaId: `media-${takeId}` };
		},
	};
}

function setupPartialFailureProject() {
	const fake = makeFakeEditor();
	const director = createDirectorApi(fake.editor, {
		executor: partialFailureExecutor(),
		recovery: fastRecovery,
	});
	return { fake, director };
}

export const generationFailureScenario: EvalScenario = {
	id: "generation-partial-failure-mid-run",
	description:
		"Two-shot storyboard, one shot's generation fails with a non-retryable " +
		"provider error: the run must still complete cleanly (no unhandled step " +
		"error) with the failed slot reported as failed and the other slot " +
		"unaffected and ready — asserted per-slot on getReel(), not on the " +
		"generate step's own ok/message fields alone.",
	userMessage:
		"make two quick shots: a calm harbor at dawn, and a shot that will fail",
	setup: setupPartialFailureProject,
	turns: () => [
		toolTurn("Storyboarding both shots.", "t1", "storyboard", {
			shots: [
				{ prompt: "a calm harbor at dawn, still water", duration: 4 },
				{
					prompt: `a shot that always fails (${FAIL_MARKER})`,
					duration: 4,
				},
			],
			budgetUsd: 10,
		}),
		toolTurn("Generating both shots.", "t2", "generate", { slotIds: "all" }),
		closeTurn(
			"One shot's in — the harbor at dawn. The second one hit a generation " +
				"error and needs your input before I retry it.",
		),
	],
	expect: {
		mustCallVerbs: ["storyboard", "generate"],
		orderedVerbPrefix: ["storyboard", "generate"],
		slotCountBounds: [2, 2],
		mustNotAwaitApproval: true,
	},
};

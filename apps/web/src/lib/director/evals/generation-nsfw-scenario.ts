/**
 * FAILURE MODE 1 of 4 named in the task brief — a generation request REJECTED
 * FOR CONTENT POLICY (`nsfw`). This is a TERMINAL job status, not a
 * retryable error: `failure-classification.ts`'s `classifyFailure` matches
 * "nsfw" via its `SAFETY_RE` pattern into `class: "safety"`, and
 * `director-api.ts`'s `runTakeWithRecovery` treats `"safety"` specially — it
 * never blind-retries the same prompt (that would just fail again), it
 * AUTO-REPHRASES it once (`recovery.maxRephrases`, default 1) and tries
 * again, then gives up cleanly if the rephrase still trips the filter.
 *
 * TWO shots, same shape `generation-failure-scenario.ts` uses (one succeeds,
 * one is flagged) — NOT because this scenario is about partial failure per
 * se, but because `generate()`'s own top-level result is `ok: false` when
 * EVERY targeted slot fails (`director-api.ts`: "Nothing rendered anywhere ⇒
 * a hard failure the user must resolve") — a correct, deliberate outcome
 * that `assertNoUnhandledErrors` cannot (and should not) tell apart from a
 * crash at the generic-sweep level. A second, healthy shot keeps the
 * `generate` step itself `ok: true` (a partial failure, reported), which is
 * what actually lets this scenario live in `evals.test.ts`'s `allScenarios`
 * sweep instead of needing the `staleReferenceScenario`-style opt-out.
 *
 * MARKER CHOICE MATTERS HERE, unlike `generation-failure-scenario.ts`'s
 * `FAIL_MARKER`: `director-api.ts`'s `defaultSafetyRephrase` STRIPS common
 * flagged terms (`FLAGGED_TERMS_RE` — "nude", "nsfw", "explicit", …) before
 * retrying, so a marker literally containing "nsfw" would be silently
 * scrubbed by the very rephrase this scenario is trying to exercise, and the
 * "always fails" assumption would quietly break (the 2nd attempt would look
 * like a fresh, unflagged prompt and succeed). The marker below deliberately
 * contains none of `FLAGGED_TERMS_RE`'s words, so it survives the rephrase
 * and the shot fails identically on both attempts — the error TEXT returned
 * to the classifier (a separate string) still says "nsfw" so
 * `classifyFailure` takes the safety branch for the right reason.
 *
 * THE ASSERTION RULE, same discipline `generation-failure-scenario.ts`
 * documents: every load-bearing assertion reads the slot's OWN status off
 * `getReel()`, plus the ATTEMPT COUNT the executor itself observed (proof the
 * recovery loop took the safety branch — one rephrase, not an open-ended
 * retry loop) — never "did the executor's raw error text leak" as the only
 * check (that's `describeSlotGeneration`'s job, covered by construction: it
 * only ever emits class labels, never the raw string — see
 * `director-api.ts`'s `FAILURE_LABEL`/`summarizeFailures`).
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

/** Deliberately clear of every word `FLAGGED_TERMS_RE` strips — see this
 *  file's header. */
const NSFW_MARKER = "ALWAYS-FLAGGED-BY-MODERATION-SHOT";

/** Attempts made for the flagged shot: 1 initial + `maxRephrases` (default 1)
 *  — see `director-api.ts`'s `runTakeWithRecovery`: a `"safety"` failure never
 *  enters the retryable-backoff branch at all, so this is exactly 2, not
 *  3 (contrast `generation-rate-limit-scenario.ts`'s provider-class 3). */
export const NSFW_SCENARIO_EXPECTED_ATTEMPTS = 2;

let nsfwAttempts = 0;

/** Reset on every `setup()` call so re-running the scenario (or running it
 *  alongside others in the same file) never leaks a stale count — mirrors
 *  `useBeatGridStore.getState().reset()` in `evals.test.ts`'s `afterEach`,
 *  just scoped to this module's own counter instead of a shared store. */
function nsfwExecutor(): GenerateExecutor {
	return {
		run: async ({ takeId, spec }) => {
			if (spec.prompt.includes(NSFW_MARKER)) {
				nsfwAttempts++;
				// Realistic provider phrasing (mirrors how a raw moderation
				// rejection actually reads) — never asserted verbatim anywhere a
				// customer would see it; only `classifyFailure`'s SAFETY_RE match
				// and the resulting GENERIC class label are load-bearing.
				return {
					status: "failed",
					error: "Content flagged: nsfw material detected in generated frame.",
				};
			}
			return { status: "ready", mediaId: `media-${takeId}` };
		},
	};
}

function setupNsfwProject() {
	nsfwAttempts = 0;
	const fake = makeFakeEditor();
	const director = createDirectorApi(fake.editor, {
		executor: nsfwExecutor(),
		recovery: fastRecovery,
	});
	return { fake, director };
}

export const generationNsfwScenario: EvalScenario = {
	id: "generation-nsfw-content-policy-rejection",
	description:
		"Two shots, one flagged for content policy (nsfw) on every attempt: " +
		"the Director must auto-rephrase the flagged one once, then give up " +
		"cleanly on it — a terminal, non-retryable outcome reported as a " +
		"generic content-safety rejection, never the raw provider text — " +
		"while the healthy shot is unaffected.",
	userMessage:
		"make two shots: a calm city skyline, and a late-night rooftop party",
	setup: setupNsfwProject,
	turns: () => [
		toolTurn("Storyboarding both shots.", "t1", "storyboard", {
			shots: [
				{ prompt: "a calm city skyline at dusk, still and quiet", duration: 4 },
				{ prompt: `a late-night rooftop party (${NSFW_MARKER})`, duration: 4 },
			],
			budgetUsd: 10,
		}),
		toolTurn("Rendering both shots.", "t2", "generate", { slotIds: "all" }),
		closeTurn(
			"The skyline shot is in. The rooftop party got flagged by the " +
				"content-safety filter, even after a reworded attempt — try " +
				"describing it a bit differently and I'll give it another shot.",
		),
	],
	expect: {
		mustCallVerbs: ["storyboard", "generate"],
		orderedVerbPrefix: ["storyboard", "generate"],
		slotCountBounds: [2, 2],
		mustNotAwaitApproval: true,
	},
};

/** Read after `runScenario` — the executor invocation count for the flagged
 *  shot, proof the recovery loop took the safety (rephrase-once) branch
 *  rather than the retryable-backoff branch. */
export function getNsfwAttemptCount(): number {
	return nsfwAttempts;
}

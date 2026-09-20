/**
 * FAILURE MODE 3 of 4 named in the task brief — A JOB THAT NEVER FINISHES,
 * STILL QUEUED PAST A 10-MINUTE WALL. The real wall-clock version of this
 * lives client-side (`stores/generation-status-store.ts`'s ~8-minute poll
 * ceiling) and server-side (`lib/studio/settle-generation.ts`'s `budgetMs`
 * poll loop, whose own doc comment states the contract: "Throws... on budget
 * exhaustion" with the message `"${label} took too long to respond"`). This
 * harness cannot (and must not) actually wait out a real timeout — see the
 * standing rule "no live API calls... provider failures are simulated, never
 * provoked" — so this scenario simulates the BOUNDARY OUTCOME a real timeout
 * produces: `studio-executor.ts` catches that thrown error and reports
 * `{status: "failed", error: "<label> took too long to respond"}`, which
 * `classifyFailure`'s `TIMEOUT_RE` recognizes ("took too long") into
 * `class: "timeout", retryable: true` — the exact string `settleGeneration`
 * actually throws, reused here verbatim so this scenario is pinned to the
 * REAL wording, not an approximation of it.
 *
 * A timed-out job is retryable (a second attempt might just be faster), so
 * this follows the same retry-then-give-up shape
 * `generation-rate-limit-scenario.ts` does, and for the same reason: both are
 * `class: "provider"`/`"timeout"`-shaped, non-safety failures. Same TWO-shot
 * structure too, and for the identical reason (see that file's header): a
 * single always-failing shot would make `generate()`'s own result `ok:
 * false`, which `assertNoUnhandledErrors` would (correctly) flag.
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

const STUCK_MARKER = "STUCK-QUEUED-SHOT";

/** 1 initial attempt + `maxRetries` (default 2) = 3, same retryable shape as
 *  `generation-rate-limit-scenario.ts`. */
export const STUCK_TIMEOUT_SCENARIO_EXPECTED_ATTEMPTS = 3;

let stuckAttempts = 0;

function stuckTimeoutExecutor(): GenerateExecutor {
	return {
		run: async ({ takeId, spec }) => {
			if (spec.prompt.includes(STUCK_MARKER)) {
				stuckAttempts++;
				// The EXACT message `settleGeneration` throws on budget exhaustion
				// (`lib/studio/settle-generation.ts`) — this scenario simulates the
				// boundary outcome of a job stuck queued past the poll wall, not the
				// wall-clock wait itself.
				return {
					status: "failed",
					error: "Higgsfield took too long to respond",
				};
			}
			return { status: "ready", mediaId: `media-${takeId}` };
		},
	};
}

function setupStuckTimeoutProject() {
	stuckAttempts = 0;
	const fake = makeFakeEditor();
	const director = createDirectorApi(fake.editor, {
		executor: stuckTimeoutExecutor(),
		recovery: fastRecovery,
	});
	return { fake, director };
}

export const generationStuckTimeoutScenario: EvalScenario = {
	id: "generation-stuck-queued-past-timeout-wall",
	description:
		"Two shots, one whose job never resolves before the polling budget " +
		"runs out on every attempt: the Director must retry that one with " +
		"backoff up to the ceiling, then give up cleanly with a generic " +
		"timeout message — never naming the provider or the wall-clock " +
		"budget — while the healthy shot lands unaffected.",
	userMessage:
		"make two shots: a calm lake at sunrise, and fireworks over the harbor",
	setup: setupStuckTimeoutProject,
	turns: () => [
		toolTurn("Storyboarding both shots.", "t1", "storyboard", {
			shots: [
				{ prompt: "a calm lake at sunrise, still water", duration: 4 },
				{ prompt: `fireworks over the harbor (${STUCK_MARKER})`, duration: 4 },
			],
			budgetUsd: 10,
		}),
		toolTurn("Rendering both shots.", "t2", "generate", { slotIds: "all" }),
		closeTurn(
			"The lake shot is in. The fireworks render is taking far longer than " +
				"it should and didn't finish after a few tries — I've stopped " +
				"waiting on it. Want me to try a shorter or simpler shot instead?",
		),
	],
	expect: {
		mustCallVerbs: ["storyboard", "generate"],
		orderedVerbPrefix: ["storyboard", "generate"],
		slotCountBounds: [2, 2],
		mustNotAwaitApproval: true,
	},
};

export function getStuckTimeoutAttemptCount(): number {
	return stuckAttempts;
}

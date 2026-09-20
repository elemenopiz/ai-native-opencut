/**
 * FAILURE MODE 2 of 4 named in the task brief — HTTP 429 RATE LIMITING.
 * Unlike a content-policy rejection, a 429 IS retryable: `classifyFailure`
 * maps `status: 429` to `class: "provider", retryable: true` (see
 * `failure-classification.ts` — "Retryable provider hiccups (network +
 * overload + rate limiting)"), so `runTakeWithRecovery` backs off and retries
 * up to `recovery.maxRetries` (default 2) times before giving up. This
 * scenario pins a shot that is rate-limited on EVERY attempt (the demo-day
 * worst case — the provider is genuinely saturated, not just having one bad
 * request), so the retry ceiling is what actually stops the loop.
 *
 * TWO shots (one healthy, one always rate-limited) for the same reason
 * `generation-nsfw-scenario.ts`'s header explains: `generate()`'s own result
 * is `ok: false` only when EVERY targeted slot fails outright, which would
 * make `assertNoUnhandledErrors` (correctly) flag a single-shot version of
 * this fixture. A second healthy shot keeps the `generate` step `ok: true` —
 * a partial failure, reported — so this can live in the normal sweep.
 *
 * The classification is constructed directly via `classifyFailure({status:
 * 429, ...})` in the executor (rather than relying on `SAFETY_RE`/
 * `TRANSIENT_RE` text matching, which `generation-nsfw-scenario.ts` and
 * `generation-stuck-timeout-scenario.ts` lean on instead) — this is the one
 * scenario in this set that pins the STATUS-CODE branch of the classifier,
 * mirroring exactly what `studio-executor.ts` does when it threads a real
 * HTTP status through from the fetch boundary.
 *
 * `fastRecovery`'s no-op `sleep` is what makes 2 real backoff retries cost
 * zero wall-clock time in this suite — see `fixtures.ts`.
 */

import { createDirectorApi } from "../director-api";
import { makeFakeEditor } from "../fake-editor";
import { classifyFailure } from "../failure-classification";
import type { GenerateExecutor } from "../types";
import {
	closeTurn,
	fastRecovery,
	toolTurn,
	type EvalScenario,
} from "./fixtures";

const RATE_LIMIT_MARKER = "RATE-LIMITED-SHOT";

/** 1 initial attempt + `maxRetries` (default 2) backoff retries = 3 — the
 *  retryable-provider branch, contrast the safety-class scenario's 2. */
export const RATE_LIMIT_SCENARIO_EXPECTED_ATTEMPTS = 3;

let rateLimitAttempts = 0;

function rateLimitExecutor(): GenerateExecutor {
	return {
		run: async ({ takeId, spec }) => {
			if (spec.prompt.includes(RATE_LIMIT_MARKER)) {
				rateLimitAttempts++;
				return {
					status: "failed",
					error: "429 Too Many Requests",
					// Pre-classified via the real classifier with a real status code
					// — see this file's header for why this scenario pins the
					// status-driven branch rather than text-matching.
					failure: classifyFailure({
						error: "429 Too Many Requests",
						status: 429,
					}),
				};
			}
			return { status: "ready", mediaId: `media-${takeId}` };
		},
	};
}

function setupRateLimitProject() {
	rateLimitAttempts = 0;
	const fake = makeFakeEditor();
	const director = createDirectorApi(fake.editor, {
		executor: rateLimitExecutor(),
		recovery: fastRecovery,
	});
	return { fake, director };
}

export const generationRateLimitScenario: EvalScenario = {
	id: "generation-http-429-rate-limited",
	description:
		"Two shots, one HTTP 429 rate-limited on every attempt: the Director " +
		"must back off and retry that one up to the configured ceiling, then " +
		"give up cleanly with a generic provider-error message — never the " +
		"raw '429 Too Many Requests' text — while the healthy shot lands " +
		"unaffected.",
	userMessage:
		"make two shots: a quiet park bench, and a crowded subway platform at rush hour",
	setup: setupRateLimitProject,
	turns: () => [
		toolTurn("Storyboarding both shots.", "t1", "storyboard", {
			shots: [
				{ prompt: "a quiet park bench in autumn light", duration: 4 },
				{
					prompt: `a crowded subway platform (${RATE_LIMIT_MARKER})`,
					duration: 4,
				},
			],
			budgetUsd: 10,
		}),
		toolTurn("Rendering both shots.", "t2", "generate", { slotIds: "all" }),
		closeTurn(
			"The park bench shot is in. The generator's under heavy load right " +
				"now and the subway shot didn't come through after a few tries — " +
				"give it a minute and ask me to try again.",
		),
	],
	expect: {
		mustCallVerbs: ["storyboard", "generate"],
		orderedVerbPrefix: ["storyboard", "generate"],
		slotCountBounds: [2, 2],
		mustNotAwaitApproval: true,
	},
};

export function getRateLimitAttemptCount(): number {
	return rateLimitAttempts;
}

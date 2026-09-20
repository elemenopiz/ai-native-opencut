/**
 * FAILURE MODE 4 of 4 named in the task brief — a generation request
 * rejected for DEPICTING A PUBLIC FIGURE OR TRADEMARK (`ip_detected`). The
 * brief states this plainly: "both [nsfw and ip_detected] are terminal job
 * statuses, not retryable errors." Higgsfield's own two documented content
 * filters are exactly `nsfw` and `ip_detected`
 * (`docs/plans/2026-09-18-challenge-execution-timeline.md` §2) — both
 * "prompt/content filters returning 'rephrase'", i.e. the SAME recovery
 * shape: auto-rephrase once, then give up. `nsfw` gets that treatment today
 * (`generation-nsfw-scenario.ts` proves it, 2 attempts). This scenario proves
 * `ip_detected` does NOT.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * THIS IS A FINDING, NOT A REGRESSION GUARD YET — see the report for detail.
 * ──────────────────────────────────────────────────────────────────────────
 * `failure-classification.ts`'s `SAFETY_RE` lists `nsfw` (and `flagged`,
 * `moderation`, `explicit`, `sexual`, `blocked`, `prohibit*`, `disallow*`,
 * `violat*`, `sensitive`, `graphic content`, `policy violation`, `rejected
 * by`, …) but has NO pattern for `ip_detected`, "public figure", "trademark",
 * or "recognizable likeness". A raw `ip_detected` error therefore falls all
 * the way through `classifyFailure` to the `"unknown"` fallback —
 * `retryable: true` — which `runTakeWithRecovery` treats exactly like a
 * transient provider hiccup: it burns `recovery.maxRetries` (default 2) real
 * retries against a request that is GUARANTEED to fail again with the exact
 * same content (a public figure's face doesn't stop being in the prompt on
 * retry #2), instead of taking the one-rephrase-then-escalate path a
 * genuinely terminal content-policy rejection deserves. On camera, that is
 * the difference between "fails fast, Director asks for a different shot"
 * and "visibly stalls for two extra round-trips before failing anyway."
 *
 * This does NOT leak a raw provider string to the user (`FAILURE_LABEL`'s
 * `"unknown error"` is just as generic as `"content-safety rejection"` would
 * be) — it is a MISCLASSIFICATION, not a leak: wrong recovery strategy, not
 * wrong secrecy. `failure-classification.ts` is outside `evals/`'s ownership
 * (this directory owns fixtures and assertions, not the classifier), so per
 * this task's brief this is reported, not fixed here.
 *
 * `test.failing` (Bun's `it()`/`test()` modifier — inverts pass/fail) is used
 * in `evals.test.ts` for the dedicated assertion on this scenario, so the
 * suite stays green today AND flips to a loud failure the moment someone
 * fixes `classifyFailure` and forgets to un-mark it — the intended signal to
 * finish the fix (delete `.failing`, confirm 2 attempts) rather than leaving
 * a silently-passing test that no longer means anything.
 *
 * TWO shots (one healthy) for the same structural reason
 * `generation-nsfw-scenario.ts`'s header explains — a single always-failing
 * shot would make `generate()`'s own step `ok: false`, unrelated to the
 * misclassification finding this scenario exists to pin.
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

const IP_DETECTED_MARKER = "IP-DETECTED-SHOT";

/**
 * What a CORRECTLY safety-classified terminal rejection would cost: 1 initial
 * attempt + `maxRephrases` (default 1) = 2 — identical shape to
 * `generation-nsfw-scenario.ts`. Exported so the dedicated (`test.failing`)
 * assertion in `evals.test.ts` names the expectation precisely rather than a
 * bare literal.
 */
export const IP_DETECTED_SCENARIO_DESIRED_ATTEMPTS = 2;

let ipDetectedAttempts = 0;

function ipDetectedExecutor(): GenerateExecutor {
	return {
		run: async ({ takeId, spec }) => {
			if (spec.prompt.includes(IP_DETECTED_MARKER)) {
				ipDetectedAttempts++;
				// Higgsfield's own documented terminal status name — see this
				// file's header. No status code is threaded here on purpose: this
				// is exactly what `studio-executor.ts` forwards when a provider
				// reports a named terminal status rather than an HTTP code.
				return {
					status: "failed",
					error: "ip_detected: recognizable public figure in frame",
				};
			}
			return { status: "ready", mediaId: `media-${takeId}` };
		},
	};
}

function setupIpDetectedProject() {
	ipDetectedAttempts = 0;
	const fake = makeFakeEditor();
	const director = createDirectorApi(fake.editor, {
		executor: ipDetectedExecutor(),
		recovery: fastRecovery,
	});
	return { fake, director };
}

export const generationIpDetectedScenario: EvalScenario = {
	id: "generation-ip-detected-public-figure-rejection",
	description:
		"Two shots, one rejected for depicting a recognizable public " +
		"figure/trademark (ip_detected) on every attempt: DESIRED behavior is " +
		"the same terminal, one-rephrase-then-escalate shape nsfw already " +
		"gets. See this file's header — that is NOT what happens today.",
	userMessage:
		"make two shots: a generic street performer, and a famous pop star performing on stage",
	setup: setupIpDetectedProject,
	turns: () => [
		toolTurn("Storyboarding both shots.", "t1", "storyboard", {
			shots: [
				{ prompt: "a generic street performer playing guitar", duration: 4 },
				{
					prompt: `a famous pop star performing (${IP_DETECTED_MARKER})`,
					duration: 4,
				},
			],
			budgetUsd: 10,
		}),
		toolTurn("Rendering both shots.", "t2", "generate", { slotIds: "all" }),
		closeTurn(
			"The street performer shot is in. The pop star shot got flagged for " +
				"depicting a recognizable public figure, even after a reworded " +
				"attempt — try a generic performer instead and I'll give it " +
				"another shot.",
		),
	],
	expect: {
		mustCallVerbs: ["storyboard", "generate"],
		orderedVerbPrefix: ["storyboard", "generate"],
		slotCountBounds: [2, 2],
		mustNotAwaitApproval: true,
	},
};

export function getIpDetectedAttemptCount(): number {
	return ipDetectedAttempts;
}

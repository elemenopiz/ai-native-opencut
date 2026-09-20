/**
 * FAILURE MODE 4 of 4 named in the task brief — a generation request
 * rejected for DEPICTING A PUBLIC FIGURE OR TRADEMARK (`ip_detected`). The
 * brief states this plainly: "both [nsfw and ip_detected] are terminal job
 * statuses, not retryable errors." Higgsfield's own two documented content
 * filters are exactly `nsfw` and `ip_detected`
 * (`docs/plans/2026-09-18-challenge-execution-timeline.md` §2) — both
 * "prompt/content filters returning 'rephrase'", i.e. the SAME recovery
 * shape: auto-rephrase once, then give up. `nsfw` gets that treatment today
 * (`generation-nsfw-scenario.ts` proves it, 2 attempts). This scenario now
 * proves `ip_detected` does too.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * FIXED — this started life as a `test.failing` FINDING, now a real guard.
 * ──────────────────────────────────────────────────────────────────────────
 * `failure-classification.ts`'s `SAFETY_RE` used to list `nsfw` (and
 * `flagged`, `moderation`, `explicit`, `sexual`, `blocked`, `prohibit*`,
 * `disallow*`, `violat*`, `sensitive`, `graphic content`, `policy violation`,
 * `rejected by`, …) but had NO pattern for `ip_detected`, "public figure",
 * "trademark", or "recognizable likeness". A raw `ip_detected` error
 * therefore fell all the way through `classifyFailure` to the `"unknown"`
 * fallback — `retryable: true` — which `runTakeWithRecovery` treated exactly
 * like a transient provider hiccup: it burned `recovery.maxRetries` (default
 * 2) real retries against a request that is GUARANTEED to fail again with
 * the exact same content (a public figure's face doesn't stop being in the
 * prompt on retry #2), instead of taking the one-rephrase-then-escalate path
 * a genuinely terminal content-policy rejection deserves. On camera, that
 * was the difference between "fails fast, Director asks for a different
 * shot" and "visibly stalls for two extra round-trips before failing
 * anyway."
 *
 * `SAFETY_RE` now also matches `ip_detected`, "public figure", "trademark",
 * "branded character", and "recognizable likeness" (see
 * `failure-classification.ts`), so this takes the same 2-attempt
 * one-rephrase-then-escalate path `nsfw` already gets. The dedicated
 * assertion in `evals.test.ts` was un-marked from `test.failing` to `test`
 * in the same change — it is a regression guard now, not a pinned bug.
 *
 * TWO shots (one healthy) for the same structural reason
 * `generation-nsfw-scenario.ts`'s header explains — a single always-failing
 * shot would make `generate()`'s own step `ok: false`, unrelated to the
 * classification behavior this scenario exists to guard.
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

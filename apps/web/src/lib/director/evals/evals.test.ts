/**
 * Director eval harness v0 — DETERMINISTIC tier (P8 of
 * `docs/plans/2026-07-19-director-northstar.md`).
 *
 * Wires `fixtures.ts` + `runner.ts` + `assertions.ts` into `bun test` so the
 * three scripted scenarios run in the normal battery, guarding loop
 * machinery, verb dispatch, and timeline invariants across prompt/brain
 * changes (prod runs Kimi k2.6, local dev often Gemini — this tier is brain-
 * agnostic: it drives the frontier loop with a scripted, mocked model, so it
 * catches loop/prompt/verb regressions independent of which brain answers in
 * production). See `evals/README.md` for how to add a scenario and the note
 * on the scored (real-model) tier that comes later.
 *
 * Mock hygiene: `runner.ts` reassigns `global.fetch` per run (the same seam
 * `agent-streaming.test.ts`/`agent-budget.test.ts`/`agent-gemini.test.ts`
 * use — see `runner.ts`'s header comment for why no better seam exists).
 * `mock.restore()` does NOT undo a plain property assignment, so — exactly
 * like those files — we capture the original `fetch` once and restore it by
 * hand in `afterEach`, every test, unconditionally.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
	brokenVerbScenario,
	clarifyScenario,
	scenarios,
	teaserScenario,
	tightenScenario,
} from "./fixtures";
import { runScenario } from "./runner";
import {
	assertKnownVerbs,
	assertNoUnhandledErrors,
	assertScenario,
} from "./assertions";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("Director eval harness — deterministic tier", () => {
	for (const scenario of scenarios) {
		test(`${scenario.id}: ${scenario.description}`, async () => {
			const run = await runScenario(scenario);
			const violations = assertScenario(run, scenario.expect);

			if (violations.length > 0) {
				const detail = violations
					.map((v) => `  [${v.code}] ${v.message}`)
					.join("\n");
				throw new Error(
					`Scenario "${scenario.id}" failed ${violations.length} invariant(s):\n${detail}`,
				);
			}
		});
	}

	test("teaser scenario's steps are exactly storyboard → generate (no extra/missing calls)", async () => {
		const run = await runScenario(teaserScenario);
		expect(run.steps.map((s) => s.action)).toEqual(["storyboard", "generate"]);
		expect(run.steps.every((s) => s.ok)).toBe(true);
		expect(run.reelAfter.slots).toHaveLength(3);
		expect(run.reelAfter.slots.every((s) => s.takeCount > 0)).toBe(true);
	});

	test("tighten scenario's getTimeline call surfaces the uploaded clips getReel() alone would hide", async () => {
		const run = await runScenario(tightenScenario);
		// The one reel slot `setupMixedTimeline` reserved, captured BEFORE the
		// run mutated anything — the id the scripted `trim` call should have used.
		const slotId = run.reelBefore.slots[0]?.id as string;
		expect(slotId).toBeDefined();

		// The regression this locks in: getReel() sees only the generative slot;
		// getTimeline's OWN response (not just the final timeline snapshot) must
		// have reported the uploaded clips too, or the "fix" is a no-op.
		const getTimelineStep = run.events.find(
			(e) => e.type === "tool_finish" && e.step.action === "getTimeline",
		);
		expect(getTimelineStep).toBeDefined();

		const uploadedClipCount = run.timelineBefore?.tracks
			.flatMap((t) => t.elements)
			.filter((el) => !el.isGenerative).length;
		expect(uploadedClipCount).toBe(2);

		// Trim landed on the generative slot, not a hallucinated id.
		const trimStep = run.steps.find((s) => s.action === "trim");
		expect(trimStep?.ok).toBe(true);
		expect(trimStep?.args.slotId).toBe(slotId);
	});

	test("clarify scenario makes zero tool calls and stops in exactly one model round-trip", async () => {
		const run = await runScenario(clarifyScenario);
		expect(run.steps).toHaveLength(0);
		expect(run.modelCallCount).toBe(1);
		expect(run.awaitingApproval).toBe(false);
		expect(run.finalMessage.length).toBeGreaterThan(0);
	});

	describe("negative fixture — proves the harness can actually fail", () => {
		test("a scripted call to a non-catalog verb is flagged, not silently accepted", async () => {
			const run = await runScenario(brokenVerbScenario);

			// The loop itself survives (executeTool degrades gracefully) — but the
			// step recorded ok:false, and BOTH invariant checks must catch it.
			const unknownStep = run.steps.find(
				(s) => s.action === "deleteEverything",
			);
			expect(unknownStep?.ok).toBe(false);

			const knownVerbViolations = assertKnownVerbs(run);
			expect(knownVerbViolations.length).toBeGreaterThan(0);
			expect(knownVerbViolations[0]?.code).toBe("unknown-verb");

			const errorViolations = assertNoUnhandledErrors(run);
			expect(errorViolations.length).toBeGreaterThan(0);

			// And the full scenario-level sweep (what the 3 real scenarios above
			// are held to) must also fail this fixture — proving `assertScenario`
			// isn't vacuously green.
			const allViolations = assertScenario(run, {});
			expect(allViolations.length).toBeGreaterThan(0);
		});
	});
});

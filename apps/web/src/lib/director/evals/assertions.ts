/**
 * Invariant checks over an {@link EvalRun} — the deterministic tier's actual
 * pass/fail logic. Every function here is pure: `(run, …) => Violation[]`, an
 * empty array meaning "held." `evals.test.ts` composes the generic checks with
 * each scenario's declared `ScenarioExpectations` (see `fixtures.ts`).
 */

import { toolCatalog } from "../tool-catalog";
import { MAX_MODEL_CALLS } from "../agent";
import type { EvalRun } from "./runner";
import type { ScenarioExpectations } from "./fixtures";

export interface Violation {
	code: string;
	message: string;
}

const CATALOG = toolCatalog();
const KNOWN_VERBS = new Set(CATALOG.map((t) => t.name));

/** Every executed step's action must be a real, registered verb. Catches a
 *  model hallucinating a tool name — the loop degrades this to a graceful
 *  `ok:false` step rather than crashing (see `executeTool`), so this is the
 *  only thing that actually flags it. */
export function assertKnownVerbs(run: EvalRun): Violation[] {
	return run.steps
		.filter((s) => !KNOWN_VERBS.has(s.action))
		.map((s) => ({
			code: "unknown-verb",
			message: `Step called "${s.action}", which is not registered in toolCatalog(). Message: ${s.message}`,
		}));
}

/** Every executed step's args must carry every `required` field the catalog's
 *  own `inputSchema` demands for that verb — a cheap, schema-driven sanity
 *  check independent of what the handler itself tolerates. */
export function assertArgsValidate(run: EvalRun): Violation[] {
	const violations: Violation[] = [];
	for (const step of run.steps) {
		const descriptor = CATALOG.find((t) => t.name === step.action);
		if (!descriptor) continue; // flagged by assertKnownVerbs already
		for (const key of descriptor.inputSchema.required ?? []) {
			const value = step.args[key];
			if (value === undefined || value === null || value === "") {
				violations.push({
					code: "missing-required-arg",
					message: `Step "${step.action}" is missing required arg "${key}" (schema: ${JSON.stringify(descriptor.inputSchema.required)}).`,
				});
			}
		}
	}
	return violations;
}

/** No step may have errored. `executeTool` never throws past itself, so an
 *  `ok:false` step is always a DELIBERATE domain response, not a crash — but
 *  a scripted, deterministic scenario should never hit one; if it does, either
 *  the fixture's args are wrong or a verb regressed. */
export function assertNoUnhandledErrors(run: EvalRun): Violation[] {
	return run.steps
		.filter((s) => !s.ok)
		.map((s) => ({
			code: "step-error",
			message: `Step "${s.action}" failed: ${s.message}`,
		}));
}

/** The run must have reached a clean close within the loop's own ceiling
 *  (`MAX_MODEL_CALLS`), with a non-empty final message — the "no infinite
 *  loop" guarantee. */
export function assertTerminated(
	run: EvalRun,
	maxModelCalls: number = MAX_MODEL_CALLS,
): Violation[] {
	const violations: Violation[] = [];
	if (run.modelCallCount >= maxModelCalls) {
		violations.push({
			code: "not-terminated",
			message: `Run consumed ${run.modelCallCount} model call(s), hitting the ${maxModelCalls}-call ceiling — it likely never reached a clean close.`,
		});
	}
	if (!run.finalMessage || !run.finalMessage.trim()) {
		violations.push({
			code: "no-final-message",
			message: "Run produced no final message.",
		});
	}
	return violations;
}

/** Every `slotId` cross-reference on the timeline must resolve to a real reel
 *  slot, and every reel slot must appear somewhere on the timeline — catches a
 *  mutation that updates one view (`getReel`) without the other
 *  (`getTimeline`), which is exactly the class of bug @423b23f0 fixed. */
export function assertNoOrphanedElements(run: EvalRun): Violation[] {
	const violations: Violation[] = [];
	const timeline = run.timelineAfter;
	const reel = run.reelAfter;
	if (!timeline) return violations;

	const reelIds = new Set(reel.slots.map((s) => s.id));
	const timelineSlotIds = new Set<string>();
	for (const track of timeline.tracks) {
		for (const el of track.elements) {
			if (!el.slotId) continue;
			timelineSlotIds.add(el.slotId);
			if (!reelIds.has(el.slotId)) {
				violations.push({
					code: "orphaned-slot-ref",
					message: `Timeline element "${el.id}" references slotId "${el.slotId}", which is not in getReel().slots.`,
				});
			}
		}
	}
	for (const id of reelIds) {
		if (!timelineSlotIds.has(id)) {
			violations.push({
				code: "reel-slot-missing-from-timeline",
				message: `Reel slot "${id}" does not appear on the timeline.`,
			});
		}
	}
	return violations;
}

/** Total timeline duration after the run must land within `[min, max]` seconds. */
export function assertDurationBounds(
	run: EvalRun,
	bounds: [number, number],
): Violation[] {
	const total = run.timelineAfter?.totalDurationSec ?? 0;
	const [min, max] = bounds;
	if (total < min || total > max) {
		return [
			{
				code: "duration-out-of-bounds",
				message: `Timeline duration ${total}s is outside the expected [${min}, ${max}]s range.`,
			},
		];
	}
	return [];
}

/** `getReel().slots.length` after the run must land within `[min, max]`. */
export function assertSlotCountBounds(
	run: EvalRun,
	bounds: [number, number],
): Violation[] {
	const count = run.reelAfter.slots.length;
	const [min, max] = bounds;
	if (count < min || count > max) {
		return [
			{
				code: "slot-count-out-of-bounds",
				message: `getReel().slots.length ${count} is outside the expected [${min}, ${max}] range.`,
			},
		];
	}
	return [];
}

/** Every verb in `verbs` must have been called at least once. */
export function assertMustCallVerbs(
	run: EvalRun,
	verbs: string[],
): Violation[] {
	const called = new Set(run.steps.map((s) => s.action));
	return verbs
		.filter((v) => !called.has(v))
		.map((v) => ({
			code: "missing-expected-verb",
			message: `Expected verb "${v}" to be called at least once; it never was. Actual steps: [${run.steps.map((s) => s.action).join(", ")}].`,
		}));
}

/** The first `prefix.length` executed steps' actions must equal `prefix`, in order. */
export function assertOrderedVerbPrefix(
	run: EvalRun,
	prefix: string[],
): Violation[] {
	const actual = run.steps.slice(0, prefix.length).map((s) => s.action);
	const matches =
		actual.length === prefix.length && actual.every((a, i) => a === prefix[i]);
	if (matches) return [];
	return [
		{
			code: "wrong-verb-order",
			message: `Expected the first ${prefix.length} step(s) to be [${prefix.join(", ")}], got [${actual.join(", ")}].`,
		},
	];
}

/** The timeline must be unchanged (same element count AND same total duration)
 *  — the clarify-vs-act invariant: a text-only, question-asking turn must not
 *  mutate the project. */
export function assertNoMutation(run: EvalRun): Violation[] {
	const violations: Violation[] = [];
	const before = run.timelineBefore;
	const after = run.timelineAfter;
	const beforeDuration = before?.totalDurationSec ?? 0;
	const afterDuration = after?.totalDurationSec ?? 0;
	if (beforeDuration !== afterDuration) {
		violations.push({
			code: "unexpected-mutation",
			message: `Timeline duration changed from ${beforeDuration}s to ${afterDuration}s though this scenario expects no mutation.`,
		});
	}
	const beforeCount =
		before?.tracks.reduce((n, t) => n + t.elementCount, 0) ?? 0;
	const afterCount = after?.tracks.reduce((n, t) => n + t.elementCount, 0) ?? 0;
	if (beforeCount !== afterCount) {
		violations.push({
			code: "unexpected-mutation",
			message: `Timeline element count changed from ${beforeCount} to ${afterCount} though this scenario expects no mutation.`,
		});
	}
	return violations;
}

/** The run must not have ended awaiting cost-approval (i.e. it should have
 *  proceeded/down-routed cleanly under its scripted budget, never paused). */
export function assertNotAwaitingApproval(run: EvalRun): Violation[] {
	if (!run.awaitingApproval) return [];
	return [
		{
			code: "unexpected-approval-pause",
			message: `Run paused awaiting cost approval (final message: "${run.finalMessage}") though this scenario expects it to proceed without pausing.`,
		},
	];
}

/**
 * The full generic invariant sweep every scenario gets, regardless of its own
 * `expect` bag: catalog membership, arg validation, no unhandled errors, clean
 * termination, no orphaned elements.
 */
export function assertGenericInvariants(run: EvalRun): Violation[] {
	return [
		...assertKnownVerbs(run),
		...assertArgsValidate(run),
		...assertNoUnhandledErrors(run),
		...assertTerminated(run),
		...assertNoOrphanedElements(run),
	];
}

/** Layer a scenario's declared `ScenarioExpectations` on top of the generic
 *  sweep — the single entry point `evals.test.ts` calls per scenario. */
export function assertScenario(
	run: EvalRun,
	expect: ScenarioExpectations,
): Violation[] {
	const violations = [...assertGenericInvariants(run)];
	if (expect.mustCallVerbs) {
		violations.push(...assertMustCallVerbs(run, expect.mustCallVerbs));
	}
	if (expect.orderedVerbPrefix) {
		violations.push(...assertOrderedVerbPrefix(run, expect.orderedVerbPrefix));
	}
	if (expect.durationBoundsSec) {
		violations.push(...assertDurationBounds(run, expect.durationBoundsSec));
	}
	if (expect.slotCountBounds) {
		violations.push(...assertSlotCountBounds(run, expect.slotCountBounds));
	}
	if (expect.mustNotMutateTimeline) {
		violations.push(...assertNoMutation(run));
	}
	if (expect.mustNotAwaitApproval) {
		violations.push(...assertNotAwaitingApproval(run));
	}
	return violations;
}

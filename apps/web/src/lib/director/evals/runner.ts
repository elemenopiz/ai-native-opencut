/**
 * Drives one {@link EvalScenario} through the REAL `runDirectorAgent` frontier
 * loop and records a structured transcript for `assertions.ts` to check.
 *
 * Injection seam: `runDirectorAgent`'s frontier brain hard-codes a single
 * `fetch("/api/llm/agent", …)` call inside `callAgentRelay` (`agent.ts`) with
 * no injectable transport parameter — there is no constructor-injected model
 * client to pass in. The ENTIRE existing Director suite (agent-streaming,
 * agent-budget, agent-gemini, mcp-meta-verbs, …) already treats
 * `global.fetch` reassignment as that seam, because it's the only one that
 * exists. This module follows the exact same pattern, not a new one:
 *   - replace `global.fetch` for the duration of one `runScenario()` call
 *   - the mock is a plain `async (...) => Response`, never `mock.module`
 *     (the leak vector called out in the bun-test-global-fetch-leak incident
 *     — `mock.module` patches the module registry process-globally; a bare
 *     function assignment to `global.fetch` does not touch the registry)
 *   - restoration is the CALLER's job (see `evals.test.ts`'s `afterEach`),
 *     mirroring `agent-streaming.test.ts`'s documented hygiene: capture
 *     `globalThis.fetch` before any test runs, restore it by hand after
 *     every test, because `mock.restore()` alone does not undo a property
 *     assignment.
 */

import {
	runDirectorAgent,
	type AgentToolStep,
	type DirectorEvent,
} from "../agent";
import type { DirectorApi } from "../director-api";
import type { FakeEditor } from "../fake-editor";
import type { EvalScenario } from "./fixtures";

/** Structured record of one scenario's run — everything `assertions.ts` needs,
 *  nothing it has to re-derive. */
export interface EvalRun {
	scenarioId: string;
	userMessage: string;
	finalMessage: string;
	steps: AgentToolStep[];
	events: DirectorEvent[];
	awaitingApproval: boolean;
	cancelled: boolean;
	/** Number of scripted model round-trips the loop actually consumed. */
	modelCallCount: number;
	timelineBefore: ReturnType<DirectorApi["getTimeline"]>["data"];
	timelineAfter: ReturnType<DirectorApi["getTimeline"]>["data"];
	reelBefore: ReturnType<DirectorApi["getReel"]>;
	reelAfter: ReturnType<DirectorApi["getReel"]>;
	/** Raw fake-editor state, for assertions that need to walk tracks directly. */
	fake: FakeEditor;
	director: DirectorApi;
}

/**
 * Run one scenario. Sets `global.fetch` to a stub that plays back the
 * scenario's scripted turns in order and throws a clear, scenario-named error
 * if the loop asks for MORE model turns than were scripted (a fixture that
 * under-scripts a turn should fail loudly, not hang or silently reuse a
 * response). Does NOT restore `global.fetch` — see the module doc comment;
 * that's `evals.test.ts`'s `afterEach` responsibility, same as every other
 * Director test file that touches this seam.
 */
export async function runScenario(scenario: EvalScenario): Promise<EvalRun> {
	const { fake, director } = scenario.setup();
	const turns = scenario.turns({ fake, director });
	let call = 0;

	global.fetch = (async () => {
		const turn = turns[call++];
		if (!turn) {
			throw new Error(
				`Scenario "${scenario.id}" made ${call} model round-trip(s) but only ` +
					`${turns.length} turn(s) were scripted. Either the fixture under-scripted ` +
					"a turn, or the loop behaved differently than the fixture assumed — add " +
					"a turn or investigate before widening this.",
			);
		}
		return turn();
	}) as unknown as typeof fetch;

	const events: DirectorEvent[] = [];
	const timelineBefore = director.getTimeline().data;
	const reelBefore = director.getReel();

	const result = await runDirectorAgent({
		director,
		chat: async () => "",
		userMessage: scenario.userMessage,
		brain: "frontier",
		onEvent: (e) => events.push(e),
	});

	const timelineAfter = director.getTimeline().data;
	const reelAfter = director.getReel();

	return {
		scenarioId: scenario.id,
		userMessage: scenario.userMessage,
		finalMessage: result.finalMessage,
		steps: result.steps,
		events,
		awaitingApproval: result.awaitingApproval !== undefined,
		cancelled: result.cancelled ?? false,
		modelCallCount: call,
		timelineBefore,
		timelineAfter,
		reelBefore,
		reelAfter,
		fake,
		director,
	};
}

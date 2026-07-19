/**
 * Deterministic-tier fixtures for the Director eval harness (P8 of
 * `docs/plans/2026-07-19-director-northstar.md`).
 *
 * Each {@link EvalScenario} pairs a seeded project/timeline state with a
 * SCRIPTED sequence of model turns (the exact tool-call decisions a model
 * would make) so `runner.ts` can drive the REAL `runDirectorAgent` loop over
 * REAL `DirectorApi`/`fake-editor.ts` state with no live model call — the
 * same "mock only `global.fetch`, drive the real loop" pattern used by
 * `agent-streaming.test.ts`, `agent-budget.test.ts`, and
 * `agent-gemini.test.ts` (471 tests already lean on it; see those files'
 * header comments for the mock-hygiene story this harness inherits).
 *
 * `agent.ts` / `tool-catalog.ts` / `director-api.ts` / `types.ts` are
 * READ-ONLY from this directory — everything here only ever CALLS them.
 */

import type { Command } from "@/lib/commands";
import { createDirectorApi, type DirectorApi } from "../director-api";
import {
	makeFakeEditor,
	type FakeEditor,
	type FakeElement,
} from "../fake-editor";
import type { GenerateExecutor } from "../types";

/**
 * `FakeEditor.editor` is typed as the REAL `EditorCore` (so verb calls
 * type-check against production signatures), but its `timeline.insertElement`
 * is actually `fake-editor.ts`'s loose stub — `Partial<FakeElement> &
 * {type}`, not the real `CreateVideoElement` (which additionally demands
 * `transform`/`opacity` etc. no fake-editor test authors an id/mediaId-only
 * clip). Hand-placing an uploaded clip (this file's whole point — the
 * "human dragged this onto the timeline" fixture, bypassing every Director
 * verb) has to go through `insertElement`, so this narrows back to the
 * stub's REAL runtime signature rather than fighting the wider real type.
 */
function insertClip(
	fake: FakeEditor,
	element: Partial<FakeElement> & { type: FakeElement["type"] },
	placement:
		| { mode: "explicit"; trackId: string }
		| { mode: "auto"; trackType?: string },
): string {
	const insert = fake.editor.timeline.insertElement as unknown as (args: {
		element: Partial<FakeElement> & { type: FakeElement["type"] };
		placement: typeof placement;
	}) => string;
	return insert({ element, placement });
}

/**
 * `fake-editor.ts`'s `timeline` stub implements only the surface its OWN test
 * suite needed (slot/take bookkeeping) — it has no `updateElementTrim`, so
 * `director-api.ts`'s `trim` verb 500s against it out of the box. This is a
 * known, precedented gap: `adapter-defaults.test.ts` hits the same hole and
 * patches `timeline.updateElementTrim` locally in ITS OWN file rather than
 * editing the shared stub (see that file's `makePatchableFakeEditor` — it
 * goes further and reuses the real `UpdateElementTrimCommand` against a
 * patched `EditorCore.getInstance()` singleton, because it's specifically
 * testing that command's merge semantics). This harness only needs `trim` to
 * MUTATE the located element with real undo/redo — not to re-verify the
 * production command's defaulting logic (already covered there) — so this is
 * a lighter, self-contained patch: no global singleton touched, nothing to
 * restore across files.
 */
function patchTrim(fake: FakeEditor): void {
	const timeline = fake.editor.timeline as unknown as {
		updateElementTrim: (input: {
			elementId: string;
			trimStart: number;
			trimEnd: number;
			startTime?: number;
			duration?: number;
		}) => void;
	};
	timeline.updateElementTrim = (input) => {
		const located = fake.find(input.elementId);
		if (!located) return;
		const { element } = located;
		const prev = { ...element };
		const command: Command = {
			execute: () => {
				element.trimStart = input.trimStart;
				element.trimEnd = input.trimEnd;
				if (input.startTime !== undefined) element.startTime = input.startTime;
				if (input.duration !== undefined) element.duration = input.duration;
			},
			undo: () => {
				element.trimStart = prev.trimStart;
				element.trimEnd = prev.trimEnd;
				element.startTime = prev.startTime;
				element.duration = prev.duration;
			},
			redo() {
				this.execute();
			},
			getDescription: () => "Trim element",
		};
		fake.editor.command.execute({ command });
	};
}

// ── shared scripting helpers (mirrors agent-streaming.test.ts's `frame`/`sseResponse`) ──

/** One Anthropic-relay SSE frame (`event:` + `data:` + blank line — the shape `/api/llm/agent` emits). */
function frame(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A 200 `text/event-stream` Response streaming `frames`. Build a FRESH one per
 *  scripted turn — a `Response` body is single-use. */
function sseResponse(frames: string[]): Response {
	const bytes = new TextEncoder().encode(frames.join(""));
	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			c.enqueue(bytes);
			c.close();
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "text/event-stream; charset=utf-8" },
	});
}

/** A model turn that calls exactly one tool, then stops for the loop to run it. */
function toolTurn(
	text: string,
	toolId: string,
	name: string,
	input: Record<string, unknown>,
): () => Response {
	return () =>
		sseResponse([
			frame("final", {
				content: [
					{ type: "text", text },
					{ type: "tool_use", id: toolId, name, input },
				],
				stop_reason: "tool_use",
				model: "test",
			}),
			frame("done", {}),
		]);
}

/** A closing model turn: plain text, no tool call, `end_turn`. */
function closeTurn(text: string): () => Response {
	return () =>
		sseResponse([
			frame("final", {
				content: [{ type: "text", text }],
				stop_reason: "end_turn",
				model: "test",
			}),
			frame("done", {}),
		]);
}

/** An executor that always succeeds synchronously — deterministic, no network,
 *  no retries. Every scenario that generates uses this (mirrors the
 *  `readyExecutor` pattern in `agent-undo.test.ts`/`agent-budget.test.ts`). */
function readyExecutor(): GenerateExecutor {
	return {
		run: async ({ takeId }) => ({
			status: "ready",
			mediaId: `media-${takeId}`,
		}),
	};
}

/** No sleeping in the generation-recovery loop during evals. */
const fastRecovery = { sleep: async () => {} };

// ── scenario contract ────────────────────────────────────────────────────────

/** Declarative invariants a scenario's run must satisfy — consumed by `assertions.ts`
 *  in `evals.test.ts` (kept as plain data here so `fixtures.ts` never needs to
 *  import the runner/assertions types and create a cycle). */
export interface ScenarioExpectations {
	/** Every one of these verbs must appear at least once among the executed steps. */
	mustCallVerbs?: string[];
	/** The first N executed steps' actions must equal this, IN ORDER. */
	orderedVerbPrefix?: string[];
	/** [min, max] seconds the TOTAL timeline duration must land in after the run. */
	durationBoundsSec?: [number, number];
	/** [min, max] slots `getReel()` must report after the run. */
	slotCountBounds?: [number, number];
	/** True ⇒ the timeline must be byte-for-byte unchanged (element count + duration) after the run. */
	mustNotMutateTimeline?: boolean;
	/** True ⇒ the run must end without pausing on the cost-approval gate. */
	mustNotAwaitApproval?: boolean;
}

export interface EvalScenario {
	id: string;
	description: string;
	userMessage: string;
	/** Build the seeded `DirectorApi` + underlying fake editor for this scenario. Called ONCE per run. */
	setup: () => { fake: FakeEditor; director: DirectorApi };
	/**
	 * One factory per model round-trip the loop will `fetch()`, in order.
	 * Receives the SAME `{ fake, director }` `setup()` just built (not a fresh
	 * call) — scenarios that script a call against an id `setup()` reserved
	 * (e.g. `tightenScenario`'s slot) read it off this context instead of a
	 * second `setup()` call, which would mint different ids (`fake-editor.ts`'s
	 * id counter is shared, incrementing, module state).
	 */
	turns: (ctx: {
		fake: FakeEditor;
		director: DirectorApi;
	}) => Array<() => Response>;
	expect: ScenarioExpectations;
}

// ── (a) empty project + "make a 15s teaser" — generative-slot planning ──────

function setupEmptyProject() {
	const fake = makeFakeEditor();
	const director = createDirectorApi(fake.editor, {
		executor: readyExecutor(),
	});
	return { fake, director };
}

export const teaserScenario: EvalScenario = {
	id: "empty-project-teaser",
	description:
		'Empty project, "make a 15s teaser": exercises storyboard planning followed by ' +
		"a budgeted generate — the generative-slot happy path from nothing.",
	userMessage: "make a 15s teaser",
	setup: setupEmptyProject,
	turns: () => [
		// (Doesn't need `ctx` — nothing here targets an id `setup()` minted.)
		toolTurn(
			"I'll plan a three-shot teaser under a shared style bible.",
			"t1",
			"storyboard",
			{
				shots: [
					{
						prompt: "wide establishing shot of the skyline at dusk",
						intent: "cold open",
						duration: 5,
						importance: "hero",
					},
					{
						prompt: "close-up on neon signage reflecting in the rain",
						intent: "texture beat",
						duration: 5,
						importance: "support",
					},
					{
						prompt: "final push-in on the skyline as lights ignite",
						intent: "payoff",
						duration: 5,
						importance: "hero",
					},
				],
				bible: {
					palette: "neon-noir",
					lensMood: "anamorphic, moody, shallow DoF",
					setting: "downtown at night",
				},
				// Generous cap so the loop's budget gate always PROCEEDS (never
				// pauses/down-routes) — deterministic regardless of the registered
				// backend catalog's exact rates. See runner.ts / fixtures.ts header.
				budgetUsd: 10,
			},
		),
		toolTurn("Rendering all three shots now.", "t2", "generate", {
			slotIds: "all",
		}),
		closeTurn(
			"Your 15-second teaser is ready — three shots, neon-noir and moody.",
		),
	],
	expect: {
		mustCallVerbs: ["storyboard", "generate"],
		orderedVerbPrefix: ["storyboard", "generate"],
		durationBoundsSec: [12, 18],
		slotCountBounds: [3, 3],
		mustNotAwaitApproval: true,
	},
};

// ── (b) hand-built timeline + "tighten this up" — getTimeline-grounded editing ──

/**
 * A timeline built the way a human editor actually leaves one: two uploaded
 * clips placed directly on the timeline (NOT through any Director verb — no
 * `.generation` recipe, so `getReel()` cannot see them at all — see
 * `director-timeline.test.ts` and commit 423b23f0), plus ONE pre-existing
 * generative slot (a shot the Director made earlier in the project). This is
 * the exact gap `getTimeline` (@770a3141) closed: before it, the Director's
 * only view of the project was `getReel()`, which reported this timeline as a
 * near-empty 1-slot reel — hiding the two uploaded clips entirely.
 */
function setupMixedTimeline() {
	const fake = makeFakeEditor();
	patchTrim(fake);
	const director = createDirectorApi(fake.editor, {
		executor: readyExecutor(),
		recovery: fastRecovery,
	});

	// Hand-placed uploaded footage — bypasses every Director verb, exactly like
	// a human dragging clips onto the timeline.
	const introClip = {
		id: "el_intro_clip",
		type: "video" as const,
		name: "handheld-intro.mp4",
		mediaId: "m_intro",
		startTime: 0,
		duration: 8,
		trimStart: 0,
		trimEnd: 0,
	};
	insertClip(fake, introClip, { mode: "auto", trackType: "video" });
	const outroClip = {
		id: "el_outro_clip",
		type: "video" as const,
		name: "handheld-outro.mp4",
		mediaId: "m_outro",
		startTime: 8,
		duration: 6,
		trimStart: 0,
		trimEnd: 0,
	};
	insertClip(fake, outroClip, { mode: "auto", trackType: "video" });

	// One pre-existing generative slot, already rendered — a real reel slot the
	// Director CAN edit (trim/remove operate on generative slots only; see
	// `findSlot`/`isSlotElement` in `director-api.ts`).
	const reserved = director.reserveSlot({
		prompt: "drone shot of the crowd cheering",
		duration: 10,
		startTime: 14,
	});
	const slotId = reserved.data?.slotId as string;

	return { fake, director, slotId };
}

export const tightenScenario: EvalScenario = {
	id: "mixed-timeline-tighten",
	description:
		'Hand-built timeline (2 uploaded clips + 1 generative slot) + "tighten this ' +
		'up": the model must call getTimeline to see the FULL picture (getReel() ' +
		"alone hides the uploaded clips), then trim the one element it can actually " +
		"edit using the id getTimeline gave it.",
	userMessage: "tighten this up, it's dragging",
	setup: () => {
		const { fake, director } = setupMixedTimeline();
		return { fake, director };
	},
	// Reads the slot id off `ctx.director` — the SAME instance `setup()` just
	// built (see the `EvalScenario.turns` doc comment) — so the scripted `trim`
	// call targets the real id the fixture created, the same way a model would
	// target the id `getTimeline` actually returned mid-run.
	turns: ({ director }) => {
		const slotId = director.getReel().slots[0]?.id;
		if (!slotId) {
			throw new Error(
				"mixed-timeline-tighten fixture expected one pre-seeded reel slot from setup(), found none.",
			);
		}
		return buildTightenTurns(slotId);
	},
	expect: {
		mustCallVerbs: ["getTimeline", "trim"],
		orderedVerbPrefix: ["getTimeline", "trim"],
		// Total timeline duration must SHRINK (the generative slot's 10s got
		// trimmed down) but the two untouched uploaded clips (8s + 6s, contiguous
		// with the slot starting at 14s) still bound it from below.
		durationBoundsSec: [16, 23],
	},
};

/** Build `tightenScenario`'s turns from a real reel-slot id — factored out so
 *  `evals.test.ts` can reuse the exact same script when it re-derives the id
 *  from a fresh `setup()` call for its own assertions. */
export function buildTightenTurns(slotId: string): Array<() => Response> {
	return [
		toolTurn(
			"Let me see the whole timeline before I touch anything.",
			"t1",
			"getTimeline",
			{},
		),
		toolTurn(
			"Trimming the drone shot down — it's the longest single element.",
			"t2",
			"trim",
			{ slotId, duration: 6 },
		),
		closeTurn(
			"Tightened the drone shot from 10s to 6s — should feel snappier.",
		),
	];
}

// ── (c) mixed timeline + vague ask — clarify-vs-act policy ──────────────────

/**
 * A modest, already-underway timeline (one uploaded clip, one generative
 * slot) — enough that "make it better" isn't a from-nothing request, but the
 * ask itself is a thin one-liner with no subject/vibe/duration pinned down.
 * Per `buildFrontierSystemPrompt`'s CLARIFY-BEFORE-BUILDING policy, the
 * correct move is ONE short round of questions in plain text, not a guess —
 * which structurally means a text-only, no-tool-call closing turn. This
 * fixture locks in the LOOP's side of that contract: a text-only turn must
 * touch nothing and end the run in exactly one model call.
 */
function setupVagueAskTimeline() {
	const fake = makeFakeEditor();
	const director = createDirectorApi(fake.editor, {
		executor: readyExecutor(),
	});

	insertClip(
		fake,
		{
			id: "el_broll",
			type: "video" as const,
			name: "market-broll.mp4",
			mediaId: "m_broll",
			startTime: 0,
			duration: 7,
			trimStart: 0,
			trimEnd: 0,
		},
		{ mode: "auto", trackType: "video" },
	);
	director.reserveSlot({
		prompt: "hero product shot",
		duration: 5,
		startTime: 7,
	});

	return { fake, director };
}

export const clarifyScenario: EvalScenario = {
	id: "vague-ask-clarify",
	description:
		'Mixed timeline + "make it better" — a clarify-worthy vague ask: the ' +
		"scripted turn is a text-only closing reply (no tool call), and the harness " +
		"asserts the loop honors that as a clean, single-call, zero-mutation stop.",
	userMessage: "make it better",
	setup: setupVagueAskTimeline,
	turns: () => [
		closeTurn(
			"Happy to tighten this up — what's the vibe you're after (punchier cuts, " +
				"more cinematic, added music), and roughly how long should the final cut run?",
		),
	],
	expect: {
		mustNotMutateTimeline: true,
	},
};

export const scenarios: EvalScenario[] = [
	teaserScenario,
	tightenScenario,
	clarifyScenario,
];

// ── negative fixture — proves the harness can actually fail ─────────────────

/**
 * Deliberately broken: the scripted "model" calls a verb that does not exist
 * in `toolCatalog()`. `executeTool` degrades this gracefully (an `ok:false`
 * step, not a thrown exception — see `agent.ts`'s `executeTool`), so nothing
 * here crashes the loop; the point is that `assertions.ts`'s
 * `assertKnownVerbs`/`assertNoUnhandledErrors` must FLAG it. Used by
 * `evals.test.ts`'s negative test to prove the assertion layer isn't vacuous.
 */
export const brokenVerbScenario: EvalScenario = {
	id: "negative-unknown-verb",
	description:
		"NEGATIVE fixture: the scripted model calls a verb name that isn't in the " +
		"catalog. Proves assertKnownVerbs/assertNoUnhandledErrors actually catch a violation.",
	userMessage: "wipe the whole project and start over",
	setup: setupEmptyProject,
	turns: () => [
		toolTurn("On it.", "t1", "deleteEverything", { confirm: true }),
		closeTurn("Done."),
	],
	expect: {},
};

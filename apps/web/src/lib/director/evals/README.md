# Director eval harness — deterministic tier (v0)

Pillar P8 of `docs/plans/2026-07-19-director-northstar.md`: this is how "our
Director is the best" stops being vibes. This directory holds the
**deterministic tier** only — fixture project states + scripted user briefs,
run through the REAL `runDirectorAgent` loop with a MOCKED model transport,
asserting loop machinery, verb dispatch, and timeline invariants. No live
model call, no network, no API key, fully repeatable in CI.

The **scored tier** (a real model, judged by a rubric, env-gated, producing a
tracked taste/capability number per brain+prompt version) is future work —
see the stub note at the bottom of this file. Nothing here calls a real model.

## Files

| File | What it does |
|---|---|
| `fixtures.ts` | 3 scenarios + 1 negative fixture: seeded `DirectorApi` state + a scripted sequence of model turns (SSE frames shaped like `/api/llm/agent`'s wire format). |
| `runner.ts` | Drives one fixture through the real `runDirectorAgent` frontier loop, recording every tool call, event, and before/after timeline+reel snapshot into an `EvalRun`. |
| `assertions.ts` | Pure `(run) => Violation[]` invariant checks: verb-in-catalog, required-args-present, no unhandled step errors, clean termination, no orphaned slot/timeline cross-references, plus scenario-declared expectations (duration bounds, must-call verbs, ordered prefix, no-mutation, no-approval-pause). |
| `evals.test.ts` | Wires the above into `bun test` so the tier runs in the normal battery. |

## Why this is safe to run in CI (no live model)

`runDirectorAgent`'s frontier brain has exactly one seam into the outside
world: a single `fetch("/api/llm/agent", …)` call inside `callAgentRelay`
(`agent.ts`). There's no constructor-injected model client — `global.fetch`
reassignment is the ONLY seam, and it's the one the entire existing Director
suite already uses (`agent-streaming.test.ts`, `agent-budget.test.ts`,
`agent-gemini.test.ts`, `mcp-meta-verbs.test.ts`, …). `runner.ts` follows the
exact same pattern: a plain `async (...) => Response` function assignment,
never `mock.module` (the process-global leak vector — see the
`bun-test-global-fetch-leak` incident this repo already hit once). Every test
in `evals.test.ts` restores `global.fetch` by hand in `afterEach`, because
`mock.restore()` does not undo a property assignment.

## Adding a scenario

1. In `fixtures.ts`, write a `setup()` that builds a `{ fake, director }` pair
   via `makeFakeEditor()` + `createDirectorApi()` — the same fixture pattern
   ~471 other Director tests use. Hand-place any pre-existing timeline content
   with `insertClip()` (bypasses Director verbs — simulates a human-built
   timeline) or real verb calls (`director.reserveSlot()` /
   `director.storyboard()` — simulates prior Director work).
2. Write `turns(ctx)` — one factory per model round-trip the loop will make,
   in order, using the `toolTurn()` / `closeTurn()` helpers. `ctx` is the SAME
   `{ fake, director }` `setup()` just built (not a fresh call) — read real
   ids off it when a turn needs to target something `setup()` created (see
   `tightenScenario` for the pattern). **Read `director-api.ts`/
   `tool-catalog.ts` for the verb's real arg shape before scripting a call —
   they are read-only from this directory, but that doesn't mean you can
   guess their contracts.**
3. Declare `expect: ScenarioExpectations` — the declarative invariants this
   run must satisfy (`mustCallVerbs`, `orderedVerbPrefix`,
   `durationBoundsSec`, `slotCountBounds`, `mustNotMutateTimeline`,
   `mustNotAwaitApproval`). Every scenario ALSO gets the generic sweep for
   free (`assertGenericInvariants` in `assertions.ts`) — catalog membership,
   required-arg presence, no unhandled step errors, clean termination, no
   orphaned elements — you never opt out of those.
4. Add it to the `scenarios` array (or leave it standalone, like
   `brokenVerbScenario`, if it's a negative/regression fixture rather than a
   "this must always pass" one) and add a `test(...)` in `evals.test.ts`.
5. Run `bun test src/lib/director/evals/evals.test.ts` — iterate on the exact
   turn scripting until it's green. Cost-gate note: any scenario that scripts
   a `generate`/`reroll`/`remix`/`compareTake`/`addVoiceover`/`addMusicBed`
   call should set a generous `budgetUsd` on its `storyboard`/`setBudget` call
   (see `teaserScenario`) so the loop's budget gate deterministically
   `proceed`s instead of pausing for approval or down-routing — the exact
   credit numbers depend on `lib/studio/cost.ts`'s registered-backend rates,
   which this harness intentionally doesn't pin.

### Known fake-editor.ts gap: `trim`/`move`/`split`/`reorder`/`remove`

`fake-editor.ts`'s `timeline` stub implements only the slot/take bookkeeping
surface ITS OWN suite needed — it has no `updateElementTrim`, `moveElement`,
`splitElements`, `updateElementStartTime`, or `deleteElements`. Calling
`trim`/`move`/`split`/`reorder`/`remove` against a bare `makeFakeEditor()`
fails with "`editor.timeline.updateElementTrim` is not a function" (or the
equivalent for the others). This is a pre-existing gap, not something this
harness introduced — `adapter-defaults.test.ts` hits the same hole and
patches `timeline.updateElementTrim` locally (going further: it reuses the
real `UpdateElementTrimCommand` against a patched `EditorCore.getInstance()`
singleton, because it's specifically testing that command's defaulting
logic). `fixtures.ts`'s `patchTrim()` does a lighter version scoped to this
directory — a direct element mutation wrapped in a real `Command` (so
undo/redo still works), no global singleton touched. If a future scenario
needs `move`/`split`/`reorder`/`remove`, add a sibling `patchX()` following
the same shape rather than reaching for the singleton-patch machinery unless
you're specifically testing that command's own semantics (which
`adapter-defaults.test.ts` already covers for `trim`).

Do **not** "fix" this by editing `fake-editor.ts` from this directory — it is
shared by ~40 other test files outside `evals/`'s ownership scope.

## The scored tier (future work — NOT built here)

P8 also calls for a scored tier: the same fixture scenarios (or a larger,
curated set) run against a REAL model (env-gated — never in the default `bun
test` battery), judged by a rubric (critic-as-judge + golden assertions),
producing a tracked taste/capability number per brain+prompt version. That
tier deliberately makes real API calls and costs real money per run, so it
needs its own gate (an env var like `DIRECTOR_EVAL_SCORED=1`), its own runner
(reusing `fixtures.ts`'s scenarios but swapping `runner.ts`'s scripted-fetch
mock for the real `/api/llm/agent` relay), and its own rubric/scoring module.
None of that exists yet — this v0 is deterministic-tier only, by design (see
the north-star doc's P8 section and the dispatch brief that scoped this
work). Building it is a separate, later task.

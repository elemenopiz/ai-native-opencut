# Story Engine — design (P3, the "make me a cut" pipeline)

> The composition layer for the north-star sentence: one somewhat-detailed instruction (+ at
> most one clarifying round) → a watchable first cut from the user's own footage.
> Builds on: getTimeline · transcripts (SEGMENT-level — see constraint) · beat grid ·
> auto-cut/filler engines · edit-critic (advisory, ADR-006) · preference model · Part C's
> one-question clarify policy. Editing-first per ADR-007: ZERO generation in v1.
> Status: ☑ designed 2026-07-20 · ☐ built · ☐ eval-scenario'd.

## The core architecture call: a staged pipeline, not a long agent run

A 30-tool-call ReAct run is how agentic editors fail: each step re-decides context, errors
compound, cost is unbounded, and nothing is inspectable. The story engine is instead a
**typed pipeline in `lib/director/story/`**, invoked by ONE verb (`draftCut`), with the model
called at exactly the points where judgment lives and deterministic code everywhere else:

```
brief ──▶ inventory ──▶ treatment ──▶ assembly plan ──▶ execution ──▶ self-check ──▶ present
(user +   (determin-    (MODEL #1)    (MODEL #2 when     (determin-    (MODEL #3,     (proposal
 1 Q max)  istic)                      needed; else       istic verbs)  critic, iff    + markers)
                                       deterministic)                   flag on)
```

Every arrow hands over a **typed, persistable artifact** (the staged-artifacts doctrine from
the brain-rethink): `StoryBrief`, `FootageInventory`, `Treatment`, `AssemblyPlan`,
`ExecutionReport`, `EditCritique`. v1 keeps them in-memory + attached to the result; the
Proposals pillar (P7) later makes each user-editable between stages.

## Stages

1. **Brief.** From the user's instruction + Part C's clarify policy (AT MOST one friendly
   question, defaults packed in). `StoryBrief = { goal, format/aspect, targetDurationSec,
   tone, mustInclude?, audience? }`. Reads `UserPreferenceModel` for defaults the user keeps
   choosing (aspect, pacing). v1 note: this is a lightweight inline brief; the P1 Creative
   Brief work later persists/versions it.
2. **Inventory (deterministic, no model).** Walk project media: per asset — duration, kind,
   transcript segments (speech), beat grid (music), cached `AssetUnderstanding` when present,
   filler/silence maps from the auto-cut engines. Output includes a `speechShare` metric that
   picks the assembly strategy.
3. **Treatment (model call #1, structured output).** Input: brief + compact inventory digest.
   Output: `Treatment = { logline, sections: [{ intent, targetSec, materialRefs:
   candidate asset/segment ids, order }] }`. This is the creative leap — story order, what to
   lead with (hook), what to drop. Grounded: materialRefs must resolve against the inventory
   (validate + one retry with coaching error, per the Vyra error-contract pattern).
4. **Assembly plan → execution.**
   - **Radio-cut-first path** (speechShare high): choose transcript segments per section
     (dedupe filler/false-starts via the filler engine), sequence them on the audio spine,
     then lay picture: the source clip's video rides its own speech; b-roll/cutaway slots
     are MARKED (not generated — v1 leaves gaps annotated "cutaway here" unless library
     clips match). Segment-level transcripts are SUFFICIENT here — cuts land on segment
     boundaries ± silence-map snapping. (True word-level in-sentence cuts wait on the
     word-alignment prerequisite — recorded constraint from 2026-07-20.)
   - **Beat-cut path** (music-dominant): allocate shots per section to beat-grid positions,
     shot changes on beats, trims via deterministic math (`cutOnBeat` macro when P5 lands;
     inline math until then).
   - Execution = existing verbs only (`addClip`, `trim`, `split`, `move`, `removeSilence`,
     transitions), through the command stack ⇒ the entire cut is ONE undoable batch.
5. **Self-check (model call #3, optional).** Iff `NEXT_PUBLIC_FEATURE_EDIT_CRITIC=true`:
   one `critiqueEdit` pass on the assembled cut. Its issues ride the result as advisory
   notes + (when P7 lands) timeline markers. **Fixes are NEVER auto-applied** (ADR-006) —
   they're listed as ready-to-run verb calls.
6. **Present.** One chat summary in the Part-C register ("Cut a 47s draft from 9 clips —
   led with the demo, trimmed 14s of filler. Two notes from review, want them?") + the
   undo-safe timeline + the critique. The whole run is one Director turn.

## Cost & latency envelope (v1, hard)

≤3 model calls per run (treatment, optional shot-matching assist, optional critique), zero
generation, zero new billing wiring (same posture as the critic — flag-gated feature, billing
is a later gated branch). Model calls ride the existing agent relay. Target wall-clock
< 90s for a ~20-clip library. Deterministic stages must never call a model.

## What v1 deliberately does NOT do

No generation (not even gap-filling — gaps get marked, ADR-007). No autonomous critique→fix
loop (ADR-006). No persisted/versioned brief (P1's job). No word-level mid-sentence cuts
(alignment prerequisite). No multicam/speaker switching (own roadmap row). No proposals UI
(P7) — v1's reversibility = the one-batch undo + conversation summary.

## Build partition (fleet, after F-local + poach-rebase land)

| Part | Owns | Notes |
|---|---|---|
| SE-1 | `lib/director/story/` types + inventory + tests | deterministic, disjoint, first |
| SE-2 | treatment prompt + parse (+ mocked-model tests) | after SE-1 types freeze |
| SE-3 | assembly (radio-cut + beat-cut) + execution + tests | the biggest; after SE-1 |
| SE-4 | `draftCut` verb registration + director-api impl + eval scenario (zero-gen fixture) | after SE-1–3; serialize on the verb cluster |

Eval harness gets a `draftCut` scenario: seeded speech-footage fixture + scripted treatment
→ assert timeline invariants (duration within brief tolerance, no gaps, cuts on segment
boundaries, one undo entry). That's the mission's "done" metric moving.

## Gates

None new for v1 (no billing, no flags flipped, no schema). The critique leg inherits the
critic's existing flag. First real-model quality pass (scored-tier eval) is a cost the user
approves when P8's scored tier lands.

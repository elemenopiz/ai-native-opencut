# Story Engine — `lib/director/story/`

The "make me a cut" pipeline (P3). Spec:
`docs/plans/2026-07-20-story-engine-design.md`. This directory is the typed
pipeline the design doc calls for — ONE verb (`draftCut`, SE-4) walks a
project's footage through six stages, handing a typed artifact across every
arrow, with the model called only where judgment lives:

```
brief ──▶ inventory ──▶ treatment ──▶ assembly plan ──▶ execution ──▶ self-check ──▶ present
(user +   (determin-    (MODEL #1)    (MODEL #2 when     (determin-    (MODEL #3,     (proposal
 1 Q max)  istic)                      needed; else       istic verbs)  critic, iff    + markers)
                                       deterministic)                   flag on)
```

## Stage ownership (build partition)

| Stage | Artifact | Owner | Status |
|---|---|---|---|
| 1. Brief | `StoryBrief` | SE-4 (`draftCut` resolves it from the instruction + `DirectorBrief` + preference defaults) | types frozen here (SE-1) |
| 2. Inventory | `FootageInventory` | **SE-1** — `inventory.ts`'s `buildFootageInventory` | ☑ built (this directory) |
| 3. Treatment | `Treatment` | SE-2 — model call #1, structured output, grounded on the inventory digest | types frozen here (SE-1) |
| 4. Assembly plan | `AssemblyPlan` | SE-3 — radio-cut or beat-cut, chosen from `FootageInventory.speechShare` | types frozen here (SE-1) |
| 4. Execution | `ExecutionReport` | SE-3 — applies the plan's `CraftOp`s through existing `DirectorApi` verbs, one undo batch | types frozen here (SE-1) |
| 5. Self-check | `EditCritique` (reused from `../edit-critic.ts`) | SE-4, gated on `NEXT_PUBLIC_FEATURE_EDIT_CRITIC`; fixes are ADVISORY only (ADR-006) | not built here |
| 6. Present | `StoryRunArtifacts.summary` | SE-4 | not built here |

All six artifacts (plus the `StoryRunArtifacts` envelope carrying them) are
defined in `types.ts` — frozen in SE-1 so SE-2/3/4 build against a stable
contract rather than each inventing their own shape.

## Files

| File | What it does |
|---|---|
| `types.ts` | The pipeline's typed artifacts: `StoryBrief`, `FootageInventory` (+ `FootageInventoryAsset`, `InventoryMediaAsset`), `Treatment` (+ `TreatmentSection`), `AssemblyPlan` (+ `MarkedGap`, `AssemblyStrategy`), `ExecutionReport`, and the `StoryRunArtifacts` envelope. Reuses `CraftOp` (from `../craft/types.ts`) and `EditCritique` (from `../edit-critic.ts`) rather than redefining them. |
| `inventory.ts` | `buildFootageInventory(...)` — the ONLY stage this directory implements so far. Pure, deterministic, no model calls: walks injected media + injected per-asset lookups (transcript/understanding/beat-grid/silence-map presence) into a `FootageInventory`, including the `speechShare` metric. |
| `types.test.ts` | Compile-time exercises for the artifact shapes (every field, every optional path). |
| `inventory.test.ts` | Determinism + the `speechShare` formula's edge cases + injected-seam isolation (no store/global reads). |

## Artifact flow (who reads what)

- `StoryBrief` + a compact digest of `FootageInventory` ground the Treatment
  model call (SE-2). `Treatment.sections[].materialRefs` must resolve against
  the inventory (SE-2 validates; one retry with a coaching error on a
  dangling ref).
- `FootageInventory.speechShare` picks `AssemblyPlan.strategy` (SE-3):
  speech-dominant ⇒ `"radio-cut"` (sequence transcript segments on the audio
  spine, snap to silence-map boundaries); music-dominant ⇒ `"beat-cut"`
  (allocate shots to beat-grid positions).
- `AssemblyPlan.ops` (`CraftOp[]`, real `DirectorApi` verbs only — `addClip`,
  `trim`, `split`, `move`, `removeSilence`, transitions) execute as ONE
  undoable batch into an `ExecutionReport`.
- The optional self-check (stage 5) judges the assembled cut and rides its
  issues on the run as advisory notes — never auto-applied.
- Stage 6 renders one chat-summary line from the full `StoryRunArtifacts`
  envelope.

## What this directory deliberately does NOT do (v1, per the design doc)

No generation, not even gap-filling (`AssemblyPlan.markedGaps` records the gap
instead — ADR-007). No autonomous critique→fix loop (ADR-006). No
persisted/versioned brief (P1's job). No word-level mid-sentence cuts
(word-alignment prerequisite not built). Nothing outside this directory
imports from it yet — the pipeline is dark code until SE-4 wires `draftCut`.

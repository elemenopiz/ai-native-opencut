# C27 — Undo/Redo Integrity Sweep

> Campaign log (crash-survival state). L1 orchestrator (opus) in worktree
> `agent-af9ddf63ca6562dae`, branch `campaign/undo-integrity` (based off
> `main@29a06429`). Sonnet workers execute in isolated worktrees; L1 merges into
> this branch. **Local-only mode (G2): never push, never merge to main.**

## Mission

The founder's BUG34 (asset delete didn't undo cleanly) was an INSTANCE of a class.
C25 fixed it with a reversible cross-store command
(`lib/commands/media/remove-media-asset.ts` @14228487 + its 391-line test — the
reference pattern). C27 proves or fixes the rest of the class across ALL Commands.

ID range: **BUG100–BUG109**. Territory (exclusive): `lib/commands/**` + their tests
+ read-mostly command-execution paths in `core/managers`. OFF-LIMITS: UI (C21b),
services/renderer (C17), services/storage (C28), media-store FOLDER fields (C33).

## The command infrastructure (reference)

- `base-command.ts`: `Command` abstract — `execute()` (abstract), `undo()` (throws by
  default), `redo()` (defaults to `execute()`). So a command that doesn't override
  `redo()` re-runs `execute()` on redo — correct ONLY if `execute()` re-snapshots
  current state rather than replaying stale captured state.
- `batch-command.ts`: `BatchCommand` runs children forward on execute/redo, reversed
  on undo.
- `core/managers/commands.ts`: `CommandManager` = the history/undo/redo stacks +
  **transactions** (`beginTransaction`/`commitTransaction` wrap N commands into ONE
  history entry via BatchCommand — the mechanism for closing the batch-delete hole)
  + ambient origin stack (agent vs user) + `undoTo`/`redoTo`.
- Dispatch: managers build a command then `editor.command.execute({ command })`,
  which calls `command.execute()` then pushes a `HistoryEntry`. A command that
  internally calls a manager method that ITSELF dispatches (e.g.
  `editor.timeline.deleteElements`) double-pushes → the C25 bug class. Correct
  pattern: build a child command and call `.execute()`/`.undo()` on it DIRECTLY.

## Property-test contract (per command)

For each command, seeded via store/EditorCore APIs (never UI):
1. **execute→undo** ⇒ state deep-equals pre-state (round-trip identity).
2. **execute→undo→redo→undo** ⇒ same as (1) (redo idempotent / re-snapshots).
3. **single history entry** ⇒ `getHistoryLength()===1` after one dispatch.
4. **cross-store side effects captured** ⇒ transcript / selection / effects /
   dependent-element state restored on undo (BUG34's cascade class).

Test idioms: `media/__tests__/remove-media-asset.test.ts` (fake-EditorCore wiring),
`timeline/element/__tests__/move-elements-group.test.ts` (proxy-barrel mock + dynamic
import for bun order-dependence). Reuse them — do NOT introduce a new harness.

## Command inventory (44 commands) & audit table

Verdict columns filled from worker property-tests. `redo` col: `own` = overrides
`redo()`; `exec` = inherits `redo()=execute()` (needs execute() to re-snapshot).

| # | Command | Family | redo | undo full? | redo idem? | cross-store? | 1 entry? |
|---|---------|--------|------|-----------|-----------|-------------|---------|
| 1 | DeleteElementsCommand | A elem | exec | | | | |
| 2 | DuplicateElementsCommand | A elem | exec | | | | |
| 3 | InsertElementCommand | A elem | exec | | | | |
| 4 | MoveElementCommand | A elem | exec | | | | |
| 5 | MoveElementsCommand (group) | A elem | exec | | | | |
| 6 | ResizeElementsCommand (group) | A elem | exec | | | | |
| 7 | SplitElementsCommand | A elem | exec | | | | |
| 8 | ToggleElementsMutedCommand | A elem | exec | | | | |
| 9 | ToggleElementsVisibilityCommand | A elem | exec | | | | |
| 10 | ToggleSourceAudioSeparationCommand | A elem | exec | | | | |
| 11 | UpdateElementCommand | A elem | exec | | | | |
| 12 | UpdateElementDurationCommand | A elem | exec | | | | |
| 13 | UpdateElementStartTimeCommand | A elem | exec | | | | |
| 14 | UpdateElementTrimCommand | A elem | exec | | | | |
| 15 | AddClipEffectCommand | B fx | exec | | | | |
| 16 | RemoveClipEffectCommand | B fx | exec | | | | |
| 17 | ReorderClipEffectsCommand | B fx | exec | | | | |
| 18 | ToggleClipEffectCommand | B fx | exec | | | | |
| 19 | UpdateClipEffectParamsCommand | B fx | exec | | | | |
| 20 | AddTransitionCommand | B fx | exec | | | | |
| 21 | UpsertKeyframeCommand | B kf | exec | | | | |
| 22 | RemoveKeyframeCommand | B kf | exec | | | | |
| 23 | RetimeKeyframeCommand | B kf | exec | | | | |
| 24 | SetKeyframeEasingCommand | B kf | exec | | | | |
| 25 | UpsertEffectParamKeyframeCommand | B kf | exec | | | | |
| 26 | RemoveEffectParamKeyframeCommand | B kf | exec | | | | |
| 27 | PasteKeyframesCommand | B kf | exec | | | | |
| 28 | AddTrackCommand | B trk | exec | | | | |
| 29 | RemoveTrackCommand | B trk | exec | | | | |
| 30 | ToggleTrackMuteCommand | B trk | exec | | | | |
| 31 | ToggleTrackVisibilityCommand | B trk | exec | | | | |
| 32 | PasteCommand (clipboard) | B trk | exec | | | | |
| 33 | TracksSnapshotCommand | B trk | exec | | | | |
| 34 | RemoveMediaAssetCommand | C media | **own** | ✓(C25) | ✓(C25) | ✓ transcript+sel | ✓ |
| 35 | AddMediaAssetCommand | C media | exec | | | | |
| 36 | CreateSceneCommand | C scene | exec | | | | |
| 37 | DeleteSceneCommand | C scene | exec | | | | |
| 38 | RenameSceneCommand | C scene | exec | | | | |
| 39 | ToggleBookmarkCommand | C scene | exec | | | | |
| 40 | MoveBookmarkCommand | C scene | exec | | | | |
| 41 | UpdateBookmarkCommand | C scene | exec | | | | |
| 42 | RemoveBookmarkCommand | C scene | exec | | | | |
| 43 | UpdateProjectSettingsCommand | C proj | exec | | | | |
| 44 | TranscriptSnapshotCommand | C txn | exec | | | | |

## Worker partition (by file cluster — no file overlap)

- **Worker A — timeline element core** (BUG100–102): `timeline/element/*.ts` (14
  commands #1–14) + owns test files `insert-element-defaults`, `move-elements-group`,
  `move-elements-ripple`, `resize-elements-group`, `split-elements-ripple`,
  `toggle-source-audio-separation`; new `undo-roundtrip-element.test.ts`.
- **Worker B — keyframes / effects / transitions / track / clipboard** (BUG103–105):
  `timeline/element/keyframes/*`, `timeline/element/effects/*`,
  `timeline/element/transitions/*`, `timeline/track/*`, `timeline/clipboard/*`,
  `timeline/tracks-snapshot.ts` (commands #15–33) + owns `keyframe-aware-commands`,
  `paste-keyframes-command` tests; new `undo-roundtrip-kf-fx.test.ts`.
- **Worker C — media / scene / project / transcript + composite-batch fix + cascade
  hunt** (BUG106–109): `media/*`, `scene/*`, `project/*`, `transcript.ts` (commands
  #34–44) + KNOWN HOLE #3 (batch/multi-asset delete = N entries) + cross-store
  cascade audit (transcript/selection/effects-on-deleted-elements/arrangement).

Shared read-only surfaces (`core/managers/commands.ts`, manager dispatch): read, do
NOT edit unless a fix strictly requires the seam — coordinate through L1.

## Verify plan

Per worker: `bun run typecheck` exit 0; `bun run lint` no-worse; new tests green;
`bun test src/lib/commands` green. L1 merges each into `campaign/undo-integrity`,
re-runs battery staggered, judges full-suite delta vs baseline **2175 pass / 5 skip /
12 fail** (== no new fails). Browser spot-check only if a fix demands it.

## Roster & status (record only what HAS happened)

| Worker | Family | Branch | Status |
|--------|--------|--------|--------|
| A | element core | task/c27-element | dispatched |
| B | kf/fx/track | task/c27-kf-fx | dispatched |
| C | media/scene/cascade | task/c27-media-cascade | dispatched |

## Bugs filed (BUG100–109)

_(none yet)_

## Merge / battery log

- baseline (main@29a06429): full suite 2175 pass / 5 skip / 12 fail; lint ~338e/225w.
- _(worker merges appended here)_

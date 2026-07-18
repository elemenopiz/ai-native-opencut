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
| 1 | DeleteElementsCommand | A elem | exec | ✓ | ✓ | n/a | ✓ |
| 2 | DuplicateElementsCommand | A elem | exec | ✓ | ✓ | ✓ selection | ✓ |
| 3 | InsertElementCommand | A elem | exec | ✓ | ✓ | ✓ proj settings⁵ | ✓ |
| 4 | MoveElementCommand | A elem | exec | ✓ | ✓ | n/a | ✓ |
| 5 | MoveElementsCommand (group) | A elem | exec | ✓ | ✓ | ✓ selection | ✓ |
| 6 | ResizeElementsCommand (group) | A elem | exec | ✓ | ✓ | n/a | ✓ |
| 7 | SplitElementsCommand | A elem | exec | ✓ | ✓ | ✓ selection | ✓ |
| 8 | ToggleElementsMutedCommand | A elem | exec | ✓ | ✓ | n/a | ✓ |
| 9 | ToggleElementsVisibilityCommand | A elem | exec | ✓ | ✓ | n/a | ✓ |
| 10 | ToggleSourceAudioSeparationCommand | A elem | exec | ✓ | ✓ | n/a | ✓ |
| 11 | UpdateElementCommand | A elem | exec | ✓ | ✓ | n/a | ✓ |
| 12 | UpdateElementDurationCommand | A elem | exec | ✓ | ✓ | n/a | ✓ |
| 13 | UpdateElementStartTimeCommand | A elem | exec | ✓ | ✓ | n/a | ✓ |
| 14 | UpdateElementTrimCommand | A elem | exec | ✓ | ✓ | n/a | ✓ |
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
| 34 | RemoveMediaAssetCommand | C media | **own** | ✓(C25) | ✓(C25) | ✓ transcript+sel¹ | ✓ |
| 35 | AddMediaAssetCommand | C media | exec | ✓ | ✓ (stable id) | n/a | ✓ |
| 36 | CreateSceneCommand | C scene | exec | ✓ | ✓² | n/a | ✓ |
| 37 | DeleteSceneCommand | C scene | exec | ✓ | ✓ | ✓ active-scene ptr | ✓ |
| 38 | RenameSceneCommand | C scene | exec | ✓ | ✓ | n/a | ✓ |
| 39 | ToggleBookmarkCommand | C scene | exec | ✓ | ✓ | n/a | ✓ |
| 40 | MoveBookmarkCommand | C scene | exec | ✓ | ✓ | n/a | ✓ |
| 41 | UpdateBookmarkCommand | C scene | exec | ✓ | ✓ | n/a | ✓ |
| 42 | RemoveBookmarkCommand | C scene | exec | ✓ | ✓ | n/a | ✓ |
| 43 | UpdateProjectSettingsCommand | C proj | exec | ✓ | ✓ | n/a | ✓ |
| 44 | TranscriptSnapshotCommand | C txn | exec³ | ✓ | ✓ | ✓ speaker-pos⁴ | ✓ |

¹ BUG106 (fixed): selection dropped forward on execute but never restored on
undo — now captures/restores `previousSelection` like every sibling
selection-mutating command.
² BUG107 (fixed): id was re-minted on every execute (including redo), so
execute→undo→redo produced a scene with a DIFFERENT id than `getSceneId()`
had returned — now generated once in the constructor.
³ Inherits `redo()=execute()` like the rest, but is structurally different:
`before`/`after` are caller-supplied FIXED snapshots (not re-derived from
current state), so redo trivially replays the same `afterState` regardless
of intervening state drift — verified directly.
⁴ BUG109 (fixed): `speakerPositions` restore was an additive per-id merge
that never cleared a position set after the snapshot — now a full
`useTranscriptStore.setState()` replace.

⁵ BUG100 (fixed, worker A): inserting the FIRST visual element seeds project
canvasSize/originalCanvasSize/fps off the asset via
`editor.project.updateSettings({..., pushHistory: false})` — un-commanded, so
Ctrl+Z removed the clip but left canvas size/fps changed. Now captured as a
directly-executed `UpdateProjectSettingsCommand` child, rebuilt every
execute(), undone in undo(). Test: `undo-roundtrip-element.test.ts` "BUG100:".

Worker C also built `RemoveMediaAssetsCommand` (`lib/commands/media/remove-media-assets.ts`,
not part of the original 44-command inventory) closing KNOWN HOLE #3 — see
BUG108 below for its wiring status.

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
| A | element core | task/c27-element | crashed pre-commit (stream watchdog); complete working tree reviewed + PORTED by L1 @ef3a101b (L1 fixed one main-track test fixture) |
| B | kf/fx/track | task/c27-kf-fx | in flight (effects family edited; parked on typecheck monitor ~129 tool uses; polling) |
| C | media/scene/cascade | task/c27-media-cascade | finished work but parked pre-commit; working tree reviewed + PORTED by L1 @f0179b70 |

## Bugs filed (BUG100–109)

Worker C (BUG106–109), verified in source, all in `lib/commands/**` (owned files):

- **BUG106** — `RemoveMediaAssetCommand.execute()` (`lib/commands/media/remove-media-asset.ts`)
  drops the deleted elements from the current selection but never captured a
  `previousSelection` to restore on undo — unlike every sibling command that
  mutates selection (`DuplicateElementsCommand`, `SplitElementsCommand`,
  `MoveElementsCommand`/`MoveElementsGroupCommand`, `PasteCommand`, all in
  `lib/commands/timeline/**`), which all capture/restore one. Repro: select
  clip A (from asset X) + unrelated clip B → delete asset X → selection is
  `[B]` (correct, stale ref dropped) → Ctrl+Z → selection stayed `[B]`
  instead of restoring to `[A, B]`. **FIXED**: added `previousSelection`
  capture (only when execute() actually touched selection) + restore in
  `undo()`. Test: `media/__tests__/remove-media-asset.test.ts` "BUG106:" cases
  (2 new, plus a negative case proving no spurious restore when nothing was
  selected).
- **BUG107** — `CreateSceneCommand.execute()` (`lib/commands/scene/create-scene.ts`)
  called `buildDefaultScene(...)`, which mints its own fresh UUID internally,
  on every execute — including `redo()` (inherited, `= execute()`). Repro:
  `execute()` → `getSceneId()` returns id X → `undo()` → `redo()` →
  `getSceneId()` still reports X but the scene actually created on redo has a
  DIFFERENT random id Y. Any caller that captured the id after the original
  execute() (e.g. to switch into the new scene) silently desyncs after an
  undo/redo cycle — same class as the campaign's redo-idempotency contract
  point 2 (execute→undo→redo must reproduce the SAME entity, not a new one).
  Currently latent (no live caller keeps the id across a redo — `createScene`
  in `ScenesManager` has no callers yet — but the property-test contract
  requires it regardless). **FIXED**: id now generated once in the
  constructor (same shape as `AddMediaAssetCommand.assetId`) and threaded
  into `buildDefaultScene`'s result on every execute. Test:
  `scene/__tests__/create-scene.test.ts` "BUG107:" case.
- **BUG108** (KNOWN HOLE #3) — batch/multi-asset delete produces N separate
  undo-stack entries. Today's only call site (`assets.tsx handleRemove` →
  `MediaManager.removeMediaAsset`) deletes one asset per
  `editor.command.execute()` call and the Assets panel has no multi-select
  delete UI, so this is currently LATENT (not live-reachable) rather than a
  reproducible today-bug — but any future caller that loops
  `editor.media.removeMediaAsset()` (a bulk-select UI, or a Director/agent
  batch-delete verb) reproduces it immediately. **PARTIALLY ADDRESSED**:
  built + unit-tested `RemoveMediaAssetsCommand` in
  `lib/commands/media/remove-media-assets.ts` (owned territory) — wraps N
  `RemoveMediaAssetCommand` children, driven directly
  (`.execute()`/`.undo()`, never through `editor.command.execute()`, mirroring
  `RemoveMediaAssetCommand`'s own nested-`DeleteElementsCommand` pattern), so
  ONE `editor.command.execute({ command: new RemoveMediaAssetsCommand(...) })`
  call yields exactly one history entry regardless of batch size. 5 tests in
  `media/__tests__/remove-media-assets.test.ts` (single-entry, full
  round-trip across tracks, redo, missing-asset-mid-batch, empty-batch).
  **NOT WIRED**: `MediaManager` (owned by another territory, read-only to
  Worker C) only exposes single-asset `removeMediaAsset`; there is no batch
  entry point and no UI multi-select today. FILING for whoever adds
  multi-select delete: wire it to `new RemoveMediaAssetsCommand(projectId,
  ids)` through a single `editor.command.execute()` call — do NOT loop
  `editor.media.removeMediaAsset()`. Severity: LOW (latent, no live repro),
  but a real trap for the next feature that touches this path.
- **BUG109** — `restoreTranscriptSnapshot` (`lib/commands/transcript.ts`,
  used by `TranscriptSnapshotCommand.execute()`/`undo()`) restored
  `speakerPositions` via `Object.entries(snap.speakerPositions).forEach(([id,
  pos]) => store.setSpeakerPosition(id, pos))` — an ADD/overwrite-only loop,
  because the store's only speaker-position setter
  (`useTranscriptStore.setSpeakerPosition`) merges one id at a time and there
  is no bulk replacement setter. Repro: snapshot `before` with no positions
  set → assign a position to speaker A → snapshot `after` → undo (restore
  `before`) → speaker A's position is NOT cleared, it's still there — undo
  left stale cross-store state behind, the exact BUG34 class this campaign
  targets. **FIXED**: replaced the per-id loop with
  `useTranscriptStore.setState({ speakerPositions: snap.speakerPositions })`
  — zustand's own store API, not a new store setter, so the fix stays inside
  the owned `transcript.ts` file. Test:
  `commands/__tests__/transcript-snapshot.test.ts` "restores speaker names,
  positions, and translations on undo" (red before the fix, green after).

- **BUG101** (filed by L1 from Worker C's cascade hunt — fix location is
  `hooks/actions/use-editor-actions.ts` `delete-selected` handler, OUTSIDE C27
  territory; route to the UI-owning campaign, likely C21b). Repro: select clip(s) → `delete-selected` action wraps
`editor.timeline.deleteElements(...)` + a conditional `TranscriptSnapshotCommand`
push in a `beginTransaction()`/`commitTransaction()` pair (good pattern,
prior art for BUG108's fix), but ALSO calls
`editor.selection.clearSelection()` directly inside that same transaction
window — un-commanded, so it's invisible to the transaction's `BatchCommand`
and never gets reversed. Ctrl+Z after a multi-select delete restores the
elements and the transcript but leaves the selection empty instead of
restoring the pre-delete selection.

## Merge / battery log

- baseline (main@29a06429): full suite 2175 pass / 5 skip / 12 fail; lint ~338e/225w.
- _(worker merges appended here)_

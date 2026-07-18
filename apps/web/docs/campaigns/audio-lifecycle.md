# C25 — Audio lifecycle hardening (campaign log)

Branch: `campaign/audio-lifecycle` (off main @6b4a1de2) · L1 worktree: `.claude/worktrees/agent-a69d212a05f9fc91a`
ID range: BUG50–BUG54 · Budget ~120 min · Started 2026-07-18

## Objective

The founder's dogfood find-set on the audio asset/recording lifecycle:

- **BUG34 (priority):** asset delete removes timeline clips; Ctrl+Z does not restore the
  audio. Fix = one reversible cross-store command.
- **Recording discard/retake:** the record flow force-saves every take; add a discard path.
- **BUG35 (cosmetic):** audio tiles in the Assets panel aren't square / don't match other
  asset tile shapes.

## Root-cause recon (done before dispatch)

**BUG34 mechanism (confirmed in code):**

- The only live delete path is `MediaManager.removeMediaAsset`
  (`src/core/managers/media-manager.ts:133`), called from the Assets view
  (`panels/assets/views/assets.tsx:204`). It is **not a command** — it revokes the asset's
  object URLs, aborts proxy gen, deletes storage row + embedding/transcript/understanding,
  filters the in-memory asset list, **then** calls `timeline.deleteElements`, which DOES
  push a `DeleteElementsCommand` onto the undo stack.
- Net effect: Ctrl+Z pops only the element-delete entry → clip shells reappear pointing at
  a dead mediaId with revoked URLs → no audio. Exactly the user's symptom.
- `RemoveMediaAssetCommand` (`src/lib/commands/media/remove-media-asset.ts`) already
  exists, is exported, and has **zero call sites**. It also has a latent double-history
  bug: its `execute()` calls `editor.timeline.deleteElements`, which would push a second
  nested history entry.
- **Class check: video/image deletes take the exact same path** (the handler is
  type-agnostic), so fixing the choke point fixes the whole class at once. No per-type
  work needed.

**Recording flow (post @371b1392 dock):** `RecordButton`
(`panels/timeline/record-button.tsx`) + `useAudioRecording`
(`hooks/use-audio-recording.ts`). Click = start; second click = stop → unconditionally
`addToTimeline` (asset save + timeline insert). No discard anywhere. A second surface,
`AudioRecordingPanel` (`panels/assets/views/audio-recording.tsx`, mounted via
`audio-combined.tsx`), also uses the hook.

**BUG35:** Assets grid audio branch renders `MediaTypePlaceholder` and takes the 16/9
fallback ratio in `MediaItem` (`assets.tsx` ~349, ~930); audio-tab tiles
(`audio-combined.tsx` / `voiceover.tsx`) have their own shapes. Needs a before/after
screenshot pass and a small consistent-shape fix.

## Plan & partition (by file cluster — no shared files between workers)

| Worker | Task | Owned files |
|---|---|---|
| A (sonnet) | BUG34 reversible cascade command + unit tests | `src/lib/commands/media/remove-media-asset.ts`, `src/lib/commands/media/index.ts`, `src/core/managers/media-manager.ts`, tests in `src/lib/commands/media/__tests__/` (new) or alongside existing command tests |
| B (sonnet) | Recording discard/retake | `src/hooks/use-audio-recording.ts`, `src/components/editor/panels/timeline/record-button.tsx`, `src/components/editor/panels/assets/views/audio-recording.tsx` (+ its tests) |
| C (sonnet) | BUG35 square/consistent audio tiles | `src/components/editor/panels/assets/views/audio-combined.tsx`, `views/voiceover.tsx`, `views/sounds.tsx` (if needed); audio-branch-only minimal touches in `views/assets.tsx` / `draggable-item.tsx` (flag for L0 — shared with C26's hunt territory) |

Design for A (decided at L1, worker implements):

- `MediaManager.removeMediaAsset` becomes the choke point that constructs and runs ONE
  `RemoveMediaAssetCommand` via `editor.command.execute` (same idiom as
  `timeline.deleteElements`). View code untouched.
- The command owns the full cascade. `execute()`: snapshot asset + affected elements;
  clearVideo; abort proxy + drop bg task; delete embedding/understanding (regenerable —
  accepted loss on undo) and transcript (note if restore is cheap, do it); remove asset
  from list via `setAssets`; remove dependent elements via a **fresh private
  `DeleteElementsCommand` child whose `execute()` is called directly** (never via
  `timeline.deleteElements` — that double-pushes history); selection cleanup (mirror the
  manager's current code); storage delete fire-and-forget.
- **Do NOT revoke object URLs in `execute()`** — undo must leave playable URLs (same
  tradeoff the existing unused command made; URLs are reclaimed on page unload).
- `undo()`: restore asset list FIRST, then child `DeleteElementsCommand.undo()` (elements
  restored against a live asset, positions/trims/properties intact via the child's own
  snapshot), re-save asset to storage, re-schedule auto-proxy (guarded, cheap).
- `redo()`: default re-execute; execute must build a FRESH child command each run.
- Unit tests: execute→undo round-trip restores assets + elements exactly (positions,
  trims, properties), redo removes again, multi-track/multi-element case, video-asset
  case (class fix), no duplicate history entries (history length 1 after delete).

Design for B: add `discardRecording()` to the hook (stop recorder, drop chunks, release
mic/AudioContext/timer, reset state, save nothing). While recording, `RecordButton` shows
a second small control: discard (X, aria-label "Discard recording") next to the
stop-and-save mic button; toast "Recording discarded". Retake = discard leaves you one
click from re-record (no extra modal). Mirror in `AudioRecordingPanel` if it has its own
stop/save UI.

## Verification plan

- Workers: typecheck + targeted tests green in their worktrees; commit to task branches.
- L1 (me): merge worker branches into `campaign/audio-lifecycle` (git -C, in my worktree
  only), run battery (typecheck/lint-no-worse vs 346e/225w, bun test vs ~52-fail
  order-dependence baseline, rerun red once), then **browser-verify on the merged tip**:
  - BUG34 DoD: add audio to timeline → delete asset from Assets → Ctrl+Z → asset AND
    clips fully restored, audio audibly plays. (Also spot-check video-asset delete undo.)
  - Recording: record → discard → nothing saved; record → stop → saved (unchanged).
  - BUG35: before (pre-merge) / after screenshots →
    `docs/campaigns/assets/audio-lifecycle/`.
- Gates: no server-side deletion endpoints in scope (client stores + IndexedDB storage
  service only); no migrations; no new deps. Anything crossing those → stop and report.

## Worker log (records the past only)

- 2026-07-18: Workers A/B/C dispatched (sonnet, isolated worktrees). GOTCHA logged:
  spawned worktrees inherit a STALE base branch (`worktree-agent-*` @ef4759c6, 225
  behind main) — future briefs must include "checkout -b task/<x> main" as step 1.
- Worker A (BUG34 command): ENDED without committing (died mid-typecheck; L0 relayed).
  Its uncommitted diff audited by L1: matches the decided design (single history entry,
  fresh child DeleteElementsCommand, no URL revocation, asset-first undo, transcript
  capture/restore, cancelProxyGeneration seam) + 8-test round-trip suite at the real
  seam. Zero drift between its stale base and main on all three files → patch ported
  verbatim onto `campaign/audio-lifecycle` by L1 (integration, not authorship).
  Tests: 11/11 new+cleanup pass; full commands+managers suites 120/120 pass. Biome:
  1 warning, pre-existing on main (verified via stash). GitNexus: impact(removeMediaAsset
  upstream) = LOW, 2 direct callers, 0 processes; detect_changes = low, only expected
  symbols. Typecheck: pending (host contention, 6 concurrent tsc fleet-wide).
- Worker B (recording discard): still running at last check; uncommitted diff in its
  worktree reviewed read-only by L1 — complete and correct (finalizedRef race guard,
  onstop detached on discard, discard button in RecordButton + AudioRecordingPanel,
  toast). NOTE: its worktree contains PRE-EXISTING upscale-branch contamination
  (untracked files from worktree reuse) — not B's work, must not be merged.
- Worker C (BUG35): produced ZERO edits in ~80 min → replaced per protocol with a
  surgical-brief v2 worker (exact 1-conditional change in MediaItem: audio previewRatio
  = 1; base-branch checkout step included). Original C could not be stopped (task
  ownership) but is harmless in its own worktree; its output will be discarded.
- L1 pre-fix browser repro (BUG34) on :3199 (campaign worktree dev server; recipe =
  symlink main checkout's `apps/web/node_modules` + copy `.env.local`): import
  tiny-tone.wav → drag to timeline (auto audio track) → context-menu Delete → ⌘Z →
  clip "tiny-tone.wav" restored on timeline, Assets panel EMPTY. Exactly the user's
  symptom. Evidence: `assets/audio-lifecycle/bug34-before-undo-clip-back-asset-gone.png`,
  `bug35-before-assets-grid.png` (audio tile 16:9).

## Findings / bugs filed (BUG50–54)

(none yet)

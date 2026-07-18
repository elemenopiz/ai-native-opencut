# C28 — Persistence & Recovery ("nothing a reload can destroy")

**L1 orchestrator (Fable), branch `campaign/persistence-recovery`.** Hardening-first:
the founder dogfoods on local builds; a refresh that eats work is a trust-killer.
Bug range **BUG125–BUG134**. Territory (exclusive): `services/storage/**`,
editor-provider load/save paths (`core/managers/save-manager.ts`,
`core/managers/project-manager.ts` save/load, `components/providers/editor-provider.tsx`,
`components/editor/save-status.tsx`), persistence/load-heal tests, hunt evidence.
OFF-LIMITS: media-store folder fields (C33), `lib/commands` (C27),
`services/renderer` (C17), assets-panel UI (C33).

---

## The autosave seam (documented FIRST, per charter §1)

**Where autosave actually triggers — the full chain:**

1. `SaveManager.start()` (`core/managers/save-manager.ts`) subscribes to
   `editor.scenes.subscribe` + `editor.timeline.subscribe`. Any scene/timeline
   mutation → `markDirty()`.
2. `markDirty()` → `queueSave()` → **`setTimeout(saveNow, 800ms)`** (the debounce).
   Coalesces bursts; a new edit resets the 800ms timer.
3. `saveNow()` guards: skips if already saving, if not dirty, if no active project,
   if `project.getIsLoading()`, or if migrating. Then `await
   project.saveCurrentProject()` and sets `_lastSavedAt = Date.now()`.
4. `saveCurrentProject()` (`project-manager.ts:220`) rebuilds the project from
   `scenes.getScenes()`, bumps `updatedAt`, `storageService.saveProject()` →
   `serializeProject()` → `IndexedDBAdapter.set()` (DB `video-editor-projects`).
5. Direct `markDirty()` callers (bypass timeline/scenes subscribe):
   `setTimelineViewState`, `setDirectorBrief`, `setProjectBible`, `updateThumbnail`.
6. Media assets persist on a SEPARATE immediate path: `storageService.saveMediaAsset`
   → OPFS blob + IndexedDB metadata (per-project DB `video-editor-media-<id>`). Not
   debounced, not through SaveManager.

**The in-memory-only window:** an edit is memory-only for **up to 800ms + save
latency**. `beforeunload` (registered twice — `editor-provider.tsx:146` +
`save-status.tsx:44`) only calls `preventDefault()` to *warn*; it does **NOT flush**
the pending debounced save. `prepareExit()` flushes but is only wired to thumbnail-on-exit,
not to reload/tab-close. No `visibilitychange`/`pagehide` flush exists.

---

## Confirmed code-level findings (from recon, pre-hunt)

| ID | Finding | Charter | Severity | Disposition |
|----|---------|---------|----------|-------------|
| **BUG125** | **Autosave lies on failure.** `saveCurrentProject()` swallows ALL errors (`catch → console.error`, no rethrow). `SaveManager.saveNow` then sets `_lastSavedAt = Date.now()` and clears `hasPendingSave` even when the write FAILED → `SaveStatus` shows "Saved just now" while data was dropped. Direct trust-killer. | §2 | HIGH | FIX in-territory (worker S) |
| **BUG126** | **Quota exhaustion silently dropped.** No `QuotaExceededError` handling anywhere in the storage layer. On quota, IndexedDB `set` rejects → swallowed (BUG125) → no human error, `_lastSavedAt` still advances. In-memory project stays alive (good) but user is never told saves are failing (bad — charter §4 requires a surfaced human error). | §4 | HIGH | FIX in-territory (worker S) |
| **BUG127** | **No flush on reload/tab-hide.** `beforeunload` only warns; edits in the 800ms debounce window are lost on reload with no flush attempt. `visibilitychange→hidden`/`pagehide` flush would close most of the window. | §1 | MED | FIX in-territory (worker S) |
| **BUG128** | **Duplicate-tab last-write-wins, silent.** No BroadcastChannel/storage-event coordination for projects. Same project in two tabs → whoever autosaves last clobbers the other; no warning, no merge. | §3 | MED | worker H documents actual behavior; cheap warn-only guard prototyped by S — if it grows past editor-provider, FILE. |
| **BUG129** | **Load-heal gaps (sibling corruption classes).** `deserializeProject` heals visual defaults (transform-brick pattern) but NOT: malformed element refs (missing/duplicate `id`), or orphaned `mediaId`s (element points at an asset absent from the project's media store → BUG59 black-preview class). Extend the heal. | §5 | MED | FIX in-territory (worker Hl) |

Range **BUG130–BUG134** reserved for hunt discoveries.

Dedup vs queue §2: BUG59 (black-preview on still-proxying insert) is a related but
distinct compositor-warmup class — orphaned-mediaId heal (BUG129) is the persistence
half. Not a duplicate.

---

## Partition (workers by file cluster — disjoint)

- **Worker H (hunt, browser-driven):** charter §1/§3/§6 empirical. Refresh mid-edit at
  various moments (incl. mid-drag, mid-generation-poll), autosave-window measurement,
  duplicate-tab behavior, project-switch soak (3+ projects ×10). Read-only + evidence
  docs/screenshots into `docs/campaigns/assets/persistence-recovery/`. Owns NO source.
- **Worker S (storage-seam fixes):** BUG125/126/127 (+ BUG128 warn-only prototype).
  Owns `core/managers/save-manager.ts`, `core/managers/project-manager.ts`
  (saveCurrentProject only), `components/editor/save-status.tsx`,
  `components/providers/editor-provider.tsx`. Tests alongside.
- **Worker Hl (heal coverage):** BUG129. Owns `services/storage/service.ts`
  (`deserializeProject`) + `services/storage/*.test.ts` +
  `lib/timeline/element-normalize.ts` heal helpers if needed. Tests for every heal class.

No two workers share a file. S and Hl both conceptually touch "load path" but at
different files (managers vs service). H is read-only.

## Verify plan

- Battery per worker: `bun run typecheck` (0), lint no-worse (~334e/224w), targeted
  `bun test` on touched files. Full-suite judged vs baseline 2175/5/12.
- Browser-verify (worker H + S fixes): refresh-mid-edit round-trip, forced-quota
  simulation surfaces a human error + keeps memory project, project-switch soak clean.
  Real Chrome channel, ≥1280px viewport, react-scan off, Meta not Control.

## Status log (records only what HAS happened)

- 2026-07-18: recon complete, autosave seam documented, plan committed, branch created.
  Dispatched workers H + S + Hl.
- 2026-07-18: **Worker Hl returned + MERGED** (`task/c28-load-heal` @b05230c5 → merge
  f1248064). BUG129 heal classes: implausible elements/tracks dropped (null/non-object/
  missing-id/unknown-type), scene-WIDE element-id dedup (cross-track — correct, ids are
  addressed scene-wide), non-array `tracks`/`elements` guarded, missing/empty `mediaId`
  pruned for video/image/upload-audio (library-audio via `sourceUrl` correctly exempt —
  verified against `types/timeline.ts` UploadAudioElement/LibraryAudioElement contract).
  **BUG130 FILED** (adopted from Hl): string `mediaId` that resolves to NO loaded asset
  can't be healed in pure `deserializeProject` (media loads async afterwards in
  `loadProject → media.loadProjectMedia`) — needs a media-aware pass at that seam;
  BUG59 black-preview persistence half. L1 verify on merged tip: storage+normalize
  suites 106/0.
- 2026-07-18: **Worker S returned + MERGED** (`task/c28-storage-seam` @d5ad67f0 → merge
  d078fa86). BUG125 FIXED: `saveCurrentProject` rethrows; `SaveManager.saveNow` advances
  `_lastSavedAt` ONLY on real success, keeps dirty flag + retry queued on failure, new
  `getSaveError()`; SaveStatus renders "Save failed" (destructive) instead of stale
  "Saved just now". BUG126 FIXED: `QuotaExceededError` detected (DOMException + defensive
  name check) → one human toast per failure episode (deduped, resets on success);
  in-memory project untouched on failure. BUG127 FIXED: `registerFlushOnHide` —
  `visibilitychange→hidden` + `pagehide` flush the pending debounced save (beforeunload
  warn kept). BUG128 FIXED (warn-only prototype): BroadcastChannel handshake per
  projectId toasts "open in another tab" in both tabs; no locking (last-save-wins
  documented, real coordination = follow-up if hunt demands it). Worker's GitNexus
  impact on saveCurrentProject/saveNow: HIGH (save-subsystem hub) — expected radius,
  all 3 callers reconciled. 9 new tests.
- 2026-07-18: **L1 integration fix** (disclosed, 1 site): `use-arrangement-handoff.ts`
  fire-and-forget `void saveCurrentProject()` escaped its try/catch → post-BUG125 a
  write failure there would be an unhandled rejection; now `.catch` → console.error.
- 2026-07-18: L1 battery on merged tip (d078fa86 + guard): managers + providers +
  storage suites **137/0**. Typecheck in flight (host heavily contended).
- 2026-07-18: **Worker H (hunt) returned + MERGED** (`task/c28-hunt` @f1e0679d →
  merge into campaign; docs+9 screenshots only, hunted the PRE-fix baseline
  main@29a06429). Matrix: **3 PASS** (1a saved-past-debounce, 1c mid-drag reverts
  cleanly/no corruption, **§4 project-switch soak — 2026-07-17 hardening HELD**, zero
  store bleed across 8 switches ×3 projects), **5 FAIL** all mapping to the S-worker
  fixes with measured repros (1b 800ms window via freeze-timer, 3 dup-tab clobber
  duration delta 31s→36s). ID COLLISION resolved: H's generation-orphan find was filed
  "BUG130" which collided with Hl's BUG130 → renumbered **BUG132**. H also filed
  **BUG131** (SaveStatus stale "Saved" during the pending-but-not-failed debounce
  window — distinct from BUG125's failure-path lie). BUG127 severity caveat adopted:
  real browsers DO show the native leave-site dialog (CDP navigate bypasses it) — loss
  path is click-through / dialog-suppressing context / crash.
- 2026-07-18: **RED→GREEN browser verification on the campaign tip** (dev server
  `:3253`, real Chrome via Playwright, IndexedDB read as ground truth):
  - **BUG127 FIXED:** R1 frozen-timer pending edit → reload → GONE (baseline FAIL
    reproduced). R2 identical dirty+frozen state, real navigation fired `pagehide` →
    `registerFlushOnHide` → `flush()` → edit **survived reload** (`C28-R2-HIDE-FLUSH`
    present after re-hydration). Red→green proven.
  - **BUG125 FIXED:** injected `QuotaExceededError` into the save path — `lastSavedAt`
    did NOT advance, `getSaveError().name === "QuotaExceededError"`, edit stayed dirty
    (retry queued). A good save clears the error + advances the stamp. Truthful.
  - **BUG126 FIXED:** same injection surfaced the "storage is full" toast in the DOM
    and `getActiveOrNull()` stayed non-null (in-memory project alive).
  - Note: raw IDB spot-reads were flaky in-harness (new connection/version races), so
    the authoritative signal used was reload-then-rehydrate (the load path is ground
    truth) + the SaveManager getters. Screenshot capture blocked late by a stray
    file-chooser modal; JSON assertions are the load-bearing evidence.
- 2026-07-18: **Final battery on campaign tip (d078fa86-family + H-merge + docs):**
  typecheck **exit 0**; lint **331e/224w** (≤ ~334/224 bar — no worse, slightly
  better); touched suites (managers + providers + storage + normalize) **137/0**.

---

## Charter matrix (scenario × behavior × verdict — honest)

| Charter § | Scenario | Behavior found | Verdict |
|-----------|----------|----------------|---------|
| §1 | Refresh ≥800ms after edit | Persists exactly | **PASS** |
| §1 | Refresh inside 800ms debounce (baseline) | Edit silently lost | **FAIL→FIXED (BUG127)** — pagehide/visibilitychange flush; browser red→green |
| §1 | Reload mid-drag | Reverts to last-saved, no corruption | **PASS** |
| §1 | Reload during in-flight generation poll | Slot orphaned (no jobId persisted, no mount reconcile) | **FAIL→FILED (BUG132)** — cross-store, generation-slot territory; out of C28 scope |
| §2 | "Saved" indicator on save FAILURE | Showed "Saved just now" over a dropped write | **FAIL→FIXED (BUG125)** — rethrow + getSaveError + "Save failed"; browser-verified |
| §2 | "Saved" indicator during pending window | Stale prior timestamp, no "unsaved" affordance | **FAIL→FILED (BUG131)** — successful-path timing gap; small UI follow-up |
| §3 | Duplicate tab, concurrent saves | Silent last-write-wins, no warning | **FAIL→FIXED-warn (BUG128)** — BroadcastChannel cross-tab warn (prototype; no lock/merge) |
| §4 | Storage-quota exhaustion | No handling, silent drop | **FAIL→FIXED (BUG126)** — QuotaExceededError → one human toast, memory project alive; browser-verified |
| §5 | Load-heal sibling corruption | Only visual-defaults healed | **FAIL→FIXED (BUG129)** — malformed elements/tracks dropped, id dedup, missing-mediaId pruned; 106/0 |
| §5 | Orphaned string mediaId (no asset) | Dangling invisible element | **FAIL→FILED (BUG130)** — needs media-aware pass at loadProject seam (pure fn can't reach media list) |
| §6 | Project-switch soak ×8 / 3 projects | Zero store bleed, zero crash | **PASS** — 2026-07-17 hardening held |

**Fixed in-territory:** BUG125, BUG126, BUG127, BUG128 (warn), BUG129.
**Filed for owners:** BUG130 (loadProject media-aware heal), BUG131 (SaveStatus pending
affordance), BUG132 (generation-slot reload reconciliation — jobId persistence).

## Bugs filed (BUG125–BUG132; BUG133–134 unused)

- BUG125 FIXED · BUG126 FIXED · BUG127 FIXED · BUG128 FIXED(warn-only prototype) ·
  BUG129 FIXED (all verified locally).
- BUG130 FILED (Hl) — string `mediaId` with no loaded asset; media-aware heal at
  `loadProject → media.loadProjectMedia` seam; BUG59 persistence half.
- BUG131 FILED (H) — `SaveStatus` stale during pending (successful-path) debounce
  window; needs a dirty/"unsaved" affordance.
- BUG132 FILED (H) — reload orphans in-flight timeline generative-slot generations
  (`use-slot-generation.ts` never persists `jobId`; no mount reconciliation like the
  Assets-panel grid's `loadHistory`). Medium; generation-slot + stores territory.

## Territory RELEASED: `services/storage/**`, editor-provider load/save paths,
persistence/load-heal tests, hunt evidence — all free for the next campaign.

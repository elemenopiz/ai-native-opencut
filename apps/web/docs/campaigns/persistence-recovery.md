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
  Dispatching workers H + S + Hl.

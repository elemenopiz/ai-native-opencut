# C26 · Dogfood hunt: Assets & media management — campaign log

- **Branch:** `campaign/dogfood-assets` (worktree `.claude/worktrees/agent-ab7c2f5ce7c47db47`, base `main@6b4a1de2`)
- **ID range:** BUG55–BUG69 (allocated by L0; dedupe against queue §2 before filing)
- **Budget:** ~120 min. Status tables below record only what HAS happened.

## Objective

Drive the Assets & media-management surface like a paying stranger (real media, real flows,
no E2E shortcuts except seeding) and systematize the founder's ad-hoc "I found so many
things" dogfood pass. Every FAIL → fixed-forward (small, non-audio, browser-verified) or
filed BUG55–69 with a minimal deterministic repro + severity + file/line suspicion.

## Territory

- **Hunt (read/drive):** whole assets/media surface.
- **Fix-forward (exclusive):** `apps/web/src/components/editor/panels/assets/**` NON-audio
  views + upload plumbing UI (`assets.tsx`, `drag-overlay.tsx`, `draggable-item.tsx`,
  `index.tsx`, `tabbar.tsx`, non-audio views).
- **OFF-LIMITS (file, don't fix):** media-store delete/undo commands + audio views/recording
  (C25) · `lib/media/audio*`, `lib/export/**`, scene-exporter (C24) ·
  `canvas-renderer.ts` (CRITICAL) · money/auth/migrations (gated).

## Known/dedupe list (do NOT re-file)

BUG30 drag-overlay copy (fixed) · BUG18 first-load console.error (known) · BUG19/BUG27
EmptyEditorGuide hides right panel (known; dismiss guide before hunting) · BUG28 timeline
empty state (known) · BUG34 audio delete/undo + BUG35 square audio tiles (C25) · BUG16 HDR
export, BUG17 audio-only export (C24/known) · BUG14 heavy-import main-thread stall
(known architectural) · BUG12/BUG15 401 redirect (fixed) · F9 asset folders (feature, C33)
· recording discard/lifecycle (C25 — hunt only the ENTRY POINTS of the record button).

## Plan — worker partition (by scenario cluster; hunters read-only, fixer owns files)

| Worker | Cluster | Port | Branch |
|---|---|---|---|
| W-UP (sonnet, hunter) | Multi-file/mixed upload, upload-during-upload, duplicates (findDuplicateAssets UX), bad/corrupt file, error copy + recovery, re-upload after delete | 3301 | `task/c26-hunt-upload` |
| W-PROXY (sonnet, hunter) | Thumbnails/proxy states, failed proxies, HEVC/portrait/VFR fixtures (real Chrome), big-file behavior (mint large fixture), drag during proxy generation | 3302 | `task/c26-hunt-proxy` |
| W-DRAG (sonnet, hunter) | Drag-to-timeline from every view, drag-overlay states, per-asset context menu incl. new Download @b8e354a2, rename, non-audio delete, record-button entry points | 3303 | `task/c26-hunt-drag` |
| W-FIX (sonnet, fixer — spawned after hunters return) | Accumulated small in-territory finds | 3304 | `task/c26-fixes` |

Hunters commit findings (`docs/campaigns/assets/dogfood-assets/<worker>/FINDINGS.md` +
screenshots) to their task branch; L1 merges evidence + fixes into the campaign branch,
runs the battery (typecheck 0 / lint no-worse than 346e/225w / tests judged vs the ~52-fail
order-dependence baseline), and browser-verifies every fix.

## Hunt matrix (filled as results land — PASS/FAIL/PARTIAL/NOT-RUN)

| # | Surface × scenario | Owner | Result | Evidence |
|---|---|---|---|---|
| M1 | Multi-file upload (many at once) | W-UP | | |
| M2 | Mixed-type batch upload (video+image+audio+junk) | W-UP | | |
| M3 | Upload during another upload | W-UP | | |
| M4 | Same file uploaded twice (dupe UX) | W-UP | | |
| M5 | Unsupported file type → error copy + recovery | W-UP | | |
| M6 | Corrupt/truncated media file → error copy + recovery | W-UP | | |
| M7 | Delete (non-audio) → re-upload same file | W-UP | | |
| M8 | Rename asset (incl. edge names) | W-DRAG | | |
| M9 | Thumbnails while proxy generating | W-PROXY | | |
| M10 | Failed proxy state + recovery | W-PROXY | | |
| M11 | HEVC fixture ingest/preview (real Chrome) | W-PROXY | | |
| M12 | Portrait 1080x1920 fixture tile/preview | W-PROXY | | |
| M13 | Big file (≥500MB-class) upload/preview | W-PROXY | | |
| M14 | Drag-to-timeline from grid view | W-DRAG | | |
| M15 | Drag-to-timeline from other views (search/filtered/etc.) | W-DRAG | | |
| M16 | Drag DURING proxy generation | W-PROXY | | |
| M17 | Drag-overlay states (empty vs drag-active) | W-DRAG | | |
| M18 | Context menu: full item sweep per asset type | W-DRAG | | |
| M19 | Context menu: per-asset Download @b8e354a2 (video/image/audio/generated) | W-DRAG | | |
| M20 | Record-button entry points (toolbar + assets panel; entry only) | W-DRAG | | |

## Worker log (append-only, past-tense only)

- 2026-07-18: Campaign branch created off `main@6b4a1de2`; plan committed. No workers
  dispatched yet at commit time.

## Findings ledger (BUG55–69 allocations)

(none yet)

## Close-out

(pending)

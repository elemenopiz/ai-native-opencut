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
| M1 | Multi-file upload (many at once) | W-UP | PARTIAL (host loadavg ~18, 1 FPS HUD — contention artifact, matches known import-stall; re-verify on quiet host only) | w-up/FINDINGS.md, m1 shot |
| M2 | Mixed-type batch upload (video+image+audio+junk) | W-UP | PASS (junk .txt skipped w/ clear toast) | w-up/m2 shot |
| M3 | Upload during another upload | W-UP | PASS (6/6 across overlapping batches) | w-up/m3 shot |
| M4 | Same file uploaded twice (dupe UX) | W-UP | FAIL → BUG56 | w-up/m4 shot |
| M5 | Unsupported file type → error copy + recovery | W-UP | PASS (clear toast, panel recovers) | w-up/m5 shots |
| M6 | Corrupt/truncated media file → error copy + recovery | W-UP | PARTIAL → BUG55 (error shown but phantom asset added) | w-up/m6 shot |
| M7 | Delete (non-audio) → re-upload same file | W-UP | PASS | w-up/m7 shots ×4 |
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
- 2026-07-18: W-UP, W-PROXY, W-DRAG dispatched (sonnet, isolated worktrees, background;
  ports 3301/3302/3303; ~60 min budget each). W-FIX held until hunter findings land.
- 2026-07-18: L1 desk review of Download @b8e354a2 (`lib/media-download.ts`): two edge
  suspicions for cross-check — (a) `HAS_EXT` regex treats a rename like "clip.v2" as
  already-extensioned → file saved without a real media extension; (b) synchronous
  `URL.revokeObjectURL` immediately after `a.click()` is a known race on very large
  files in some engines (Chrome tolerant). Neither confirmed in-browser yet.
- 2026-07-18: W-UP returned (branch `task/c26-hunt-upload` @d818beae, read-only as
  briefed); evidence merged to campaign @78105ee5. Matrix M2/M3/M5/M7 PASS, M4 FAIL,
  M6 PARTIAL, M1 PARTIAL/inconclusive (host contention — quiet-host re-verify only).
  L1 verified BUG55's code path in `processing.ts` directly. BUG55+BUG56 allocated,
  queue §2 rows added on this branch.
- 2026-07-18: W-FIX dispatched (BUG55 skip-on-unreadable + BUG56 dupe toast; owns
  processing.ts + assets.tsx; port 3304; branch task/c26-fixes off campaign tip).
- 2026-07-18: L0 stall ruling executed. W-PROXY dead at 2h20m/zero commits — but its
  worktree held UNCOMMITTED work: full hunt script + real-Chrome config + 15 screenshots
  (M10–M16 series) + TBD findings skeleton; ported to campaign @230fb441. W-DRAG had
  committed its 1089-line hunt suite @8d686b82 (incl. proven native-drag + Radix-menu
  techniques) but parked mid-suite with an empty findings dir and a clean tree — nothing
  to port. Both REPLACED (never resumed): W-PROXY2 (scoped down to M9–M12 + optional M16;
  M13/extras NOT-RUN; branch task/c26-hunt-proxy2 off campaign tip) and W-DRAG2 (full
  drag/menu matrix; branch task/c26-hunt-drag2 off @8d686b82). Both briefs require a
  proof-of-life commit within ~15 min. M19 briefs now include the two L1 desk-review
  Download suspicions to test explicitly.

## Findings ledger (BUG55–69 allocations)

- **BUG55 (P2, = W-UP-F1):** corrupt/unreadable video is toasted as unreadable but STILL
  pushed into the library as a phantom video asset (no duration/dims/thumb) —
  `lib/media/processing.ts` `processMediaAssets()` `decision === "unsupported"` arm
  (~L327) doesn't skip; falls through to the unconditional `processedAssets.push`
  (~L378). L1 verified the code path directly. Repro + evidence: w-up/FINDINGS.md.
  → fix-forward (W-FIX): skip-on-no-readable-track (the `!probe.parseable ||
  !probe.videoCodec` case only; keep known-codec-undecodable behavior unchanged).
- **BUG56 (P3, = W-UP-F2):** zero duplicate detection on the manual upload path —
  `findDuplicateAssets` (director-api.ts:1446) is Director-briefing-only; `processFiles`
  (assets.tsx) + `AddMediaAssetCommand` mint blind duplicates, no toast/badge/prompt.
  Repro + evidence: w-up/FINDINGS.md. → fix-forward (W-FIX): informational dupe toast in
  `processFiles` (name+size match against existing assets); NO touch to
  AddMediaAssetCommand (media-store commands = C25 territory).

## Close-out

(pending)

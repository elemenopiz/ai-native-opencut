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
| M8 | Rename asset (incl. edge names) | W-DRAG2 | DEFERRED(quiet-host) — 2 sub-tests attempted, page.goto timeouts under fleet contention | w-drag/FINDINGS.md |
| M9 | Thumbnails while proxy generating | W-PROXY | PASS (cross-confirmed via M16/M11) → BUG57 rider | w-proxy/FINDINGS.md |
| M10 | Failed proxy state + recovery | W-PROXY(+2) | PARTIAL → BUG58; full lifecycle re-run = W-PROXY2 | w-proxy/m10 shot |
| M11 | HEVC fixture ingest/preview (real Chrome) | W-PROXY | PASS ×2 clean (passthrough hev1 + proxy trigger correct) | w-proxy/m11 shots ×5 |
| M12 | Portrait 1080x1920 fixture tile/preview | W-PROXY | PASS (dims correct; object-cover crop; list-view toggle not reached) | w-proxy/m12 shots |
| M13 | Big file (≥500MB-class) upload/preview | W-PROXY | PASS ×2 (394MB/70min in 21–59s, no freeze/crash) | w-proxy/m13 shots |
| M14 | Drag-to-timeline from grid view | W-DRAG2 | DEFERRED(quiet-host) | |
| M15 | Drag-to-timeline from other views (search/filtered/etc.) | W-DRAG2 | DEFERRED(quiet-host) | |
| M16 | Drag DURING proxy generation | W-PROXY | PASS structural (insert succeeds) → BUG59 rider (black preview right after; root cause unconfirmed) | w-proxy/m16 shots |
| M21 | (extra) VFR-ish clip ingest | W-PROXY | PASS — positive: averaged fps (12) measured, nominal 30 ignored | w-proxy/FINDINGS.md F4 |
| M22 | (extra) Thumbnail persistence after reload | W-PROXY2 | DEFERRED(quiet-host) — NOT-RUN twice, env-starved both attempts (addendum: check uptime <4 before retry) | w-proxy2/FINDINGS-ADDENDUM.md |
| M23 | M10-full: failed-proxy lifecycle to completion | W-PROXY2 | DEFERRED(quiet-host) — dev server served `/` then went server-wide unresponsive (3 curl probes, zero log activity) | w-proxy2/FINDINGS-ADDENDUM.md |
| M17 | Drag-overlay states (empty vs drag-active) | W-DRAG2 | DEFERRED(quiet-host) — regression-check only | |
| M18 | Context menu: full item sweep per asset type | W-DRAG2 | DEFERRED(quiet-host) — note: W-UP's M7 delete-via-menu PASS partially covers | |
| M19 | Context menu: per-asset Download @b8e354a2 | W-DRAG2 | DEFERRED(quiet-host) — static read: L1 suspicion (a) "rename then download" is structurally impossible via the menu (menu edits `label`, Download uses `name`; no rename path); possible UX gap that "Edit label" silently never affects the download filename — UNVERIFIED, needs a browser run | w-drag/FINDINGS.md "Code read" |
| M20 | Record-button entry points (toolbar + assets panel; entry only) | W-DRAG2 | DEFERRED(quiet-host) | |

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
- 2026-07-18: L0 correction — original W-PROXY was STARVED, not dead (host: 5+ dev
  servers, ~130MB free RAM, 30-min cold compiles): it completed a full report
  @bc3fc723. Merged @ce1466aa (add/add conflict on FINDINGS.md resolved theirs — full
  report supersedes ported skeleton). Matrix M9/M11/M12/M13/M16 PASS, M10 PARTIAL.
  BUG57–BUG60 allocated (F4 = positive, logged only). W-PROXY2 re-scoped mid-flight via
  message: ONLY M10 full-run + reload-persistence extra; proof-of-life @8508d0a1.
  HOST RULE adopted (all future briefs): max ONE dev server per campaign; note load
  average beside any timing claim.
- 2026-07-18: W-DRAG2 proof-of-life @c498aede (setup log + matrix skeleton NOT-RUN).
- 2026-07-18: W-FIX parked itself mid-run ("waiting for notifications" failure mode)
  with ZERO commits but a complete-looking working tree. Per doctrine NOT resumed. L1
  reviewed the full diff in its worktree: BUG55 skip mirrors the existing junk-type
  skip idiom (continue-before-accounting is pre-existing, consistent); BUG56 signature
  helper + within-batch dedupe correct; regression test flipped from asserting the
  phantom asset to asserting length 0. Unit validation in the fixer worktree: 27/27
  pass across the 3 test files. Files adopted into the campaign worktree; typecheck
  running; browser acceptance (4 scenarios, script c26-fix.verify.ts) delegated to
  W-FIX2 alongside the BUG58 mini-fix.

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
- **BUG57 (P2, = W-PROXY-F1):** no per-tile indicator while a proxy generates — only the
  asset-agnostic "N task running" chip; `MediaPreview()` (assets.tsx ~L865–944) renders
  purely off `thumbnailUrl`/`type`, never reads `isProxyGenerating(assetId)`
  (`core/managers/media-manager.ts` ~L419). Confirmed with state capture at screenshot
  instant. Evidence: w-proxy/m11-01 vs m11-02, m16-01.
- **BUG58 (P2, = W-PROXY-F2):** SIBLING of BUG55, different path — corrupt file whose
  faststart header probes CLEAN (good width/height/duration/fps) gets NO thumbnail and NO
  error at all: `getVideoInfo()` + `generateThumbnail()` share one try/catch whose catch
  is `console.warn` only (processing.ts video branch); metadata fields populate before the
  decode fails, so the asset looks valid minus thumbnail. Deterministic ffmpeg+dd repro in
  w-proxy/FINDINGS.md. Proxy-attempt lifecycle on the corrupt asset = W-PROXY2 follow-up.
- **BUG59 (P3, = W-PROXY-F3, root cause UNCONFIRMED):** preview canvas center pixel reads
  solid black immediately after inserting a still-proxying clip (insert itself succeeds,
  timeline strip renders). No control run against a non-proxying clip yet — may be generic
  compositor warm-up, not proxy-specific. Control experiment specified in FINDINGS.
- **BUG60 (P3, = W-PROXY-F5, pattern only):** 8–25 `net::ERR_ABORTED` failures against a
  single `blob:` URL per run during ingest/preview (M11/M13/M16 captures) — something
  re-requests an already-created object URL repeatedly; nothing visibly breaks. For
  whoever next touches `services/video-cache/` / preview media-element lifecycle.
- **(positive, no row) W-PROXY-F4:** VFR clip correctly measured to averaged fps (12) vs
  nominal container 30 — recorded so nobody re-derives it as a mystery.

## Close-out (2026-07-18, final)

**Branch:** `campaign/dogfood-assets`, tip = the commit carrying this close-out (see git
log; fixes landed @7b671e15, acceptance evidence @83523995). NOT merged to main, NOT
pushed — L0 integration gate. **Territory RELEASED** (queue §7 + in-flight table updated).

**Haul:** 6 bugs in-range (BUG55–60, BUG61–69 unused), all deduped against queue §2:
- **BUG55 (P2) FIXED — verified locally:** corrupt/unreadable video no longer imports as a
  phantom asset. 5/5 browser acceptance in real Chrome (w-fix/VERIFY-RESULTS.md + 6 shots).
- **BUG56 (P3) FIXED — verified locally:** duplicate uploads now get an informational
  toast (cross-batch + within-batch), import never blocked, no false positives.
- **BUG57 (P2) filed:** no per-tile proxy-generating indicator (state-capture proven).
- **BUG58 (P2) filed:** BUG55's sibling — clean-probing corrupt file → no thumbnail, no
  error at all (console.warn-only catch). Small-fix recipe in the queue row.
- **BUG59 (P3) filed:** black preview right after inserting a still-proxying clip (root
  cause unconfirmed; control experiment specified).
- **BUG60 (P3) filed:** repeated aborted blob: URL requests during ingest (pattern only).
- Positive: VFR ingest measures averaged fps correctly (logged, no row).

**Battery on campaign tip** (vs baselines): typecheck exit 0 · lint 339e/225w vs baseline
346e/225w (**better**) · targeted unit tests 34/34 · full `bun test` 1740 pass / 54 fail /
39 errors, failing files all within the documented C8 order-dependence set
(proxy-encoder-controller, health route, add-to-editor, …), stable across two runs, zero
fails in campaign-touched modules → **no-worse**. Browser acceptance 5/5 PASS at load 3.46.

**Honesty ledger (run/not-run):** upload cluster M1–M7 run (M1 PARTIAL, contention);
proxy cluster M9–M16+VFR run (M10 PARTIAL); drag/context-menu cluster M8/M14–M20 and
M22/M23 **DEFERRED(quiet-host)** — two workers were starved by fleet host contention
(~14 dev/tsc processes; even `GET /` timed out), zero scenarios fabricated. These rows
fold into the next C21-series wave-closer hunt on a quiet host.

**Per-worker log:** W-UP full report (M1–M7, 2 findings) · W-PROXY full report after a
2h52m starved run (M9–M16, 5 findings) · W-PROXY2 respawn → re-scoped → both gap rows
honestly NOT-RUN (env) · W-DRAG committed its 1089-line proven hunt suite then parked;
W-DRAG2 respawn infra-blocked, matrix NOT-RUN + one static-read note (label-vs-name) ·
W-FIX wrote both fixes + tests + verify script, parked with zero commits; diff
L1-reviewed and adopted, acceptance run by L1 5/5.

**For the next wave:** (1) the deferred drag/context-menu matrix — the committed
w-drag.hunt.e2e.ts suite is ready to run as-is on a quiet host; (2) BUG58 small fix;
(3) BUG57 tile indicator (needs a reactive seam from media-manager proxy state);
(4) BUG59 control experiment; (5) label-vs-name Download UX question (M19 note);
(6) fleet-ops: dev-server starvation is the dominant hunt killer — enforce the HOST RULE
(one server per campaign) and check `uptime` <4 before browser work.

# W-UP — Upload cluster hunt (campaign C26, dogfood: Assets & media management)

Branch: `task/c26-hunt-upload` (worker W-UP, read-only on product source).
Driven via real installed Chrome (`channel: "chrome"`) against a manually-started
dev server (`NEXT_PUBLIC_E2E=1 PORT=3301 bun run dev`), using the E2E bridge
(`window.__BYORN_E2E__`) to read the media store and a real hidden
`<input type="file">` (`setInputFiles`) to drive genuine uploads — the actual
`processMediaAssets` -> mediabunny probe/decode/normalize/thumbnail pipeline, not
a stub.

Hunt scripts (throwaway, not wired into CI):
- `apps/web/e2e/hunt/c26-up.hunt.ts` — the 7-scenario matrix run.
- `apps/web/e2e/hunt/c26-up-m1-retest.hunt.ts` — isolated M1 follow-up (inconclusive,
  see M1 notes below; environment died mid-run).

Scratch fixtures generated under `apps/web/e2e/hunt/scratch-fixtures/` (not
committed — regenerate from the notes in the hunt script's header comment /
this doc if needed) from the shared `e2e/fixtures/w2/*` originals plus one
genuinely truncated/corrupt file and one junk text file.

## Environment note (read this before the matrix)

This machine was running many parallel Claude Code worktree sessions during
the hunt (`uptime` load average peaked at ~18 on the 15-min average; several
other worktrees' `next dev --turbopack` + `tsc --noEmit` processes were live
throughout). Turbopack's first-compile-per-route cost on this branch is also
unusually high (single-route compiles up to 90s+ cold, one `/api/mcp/bridge`
poll rendered for 2.3–2.6 minutes). The in-app perf HUD directly evidences
this: M1's screenshot shows **1 FPS** at capture time, vs. 40–59 FPS on later
scenarios once the shared host quieted down. Where a result may be an artifact
of this contention rather than a genuine product defect, it's called out
explicitly rather than filed as a new finding.

## Matrix summary

| Row | Verdict | Evidence |
|-----|---------|----------|
| M1 — Multi-file upload (8 files) | **PARTIAL / inconclusive** | Only 1–2 of 8 assets landed inside a 90s window on this run; in-app perf HUD showed 1 FPS at that moment (host contention, see above and M1 detail). A dedicated retest to see if the batch eventually completes could not get the page to even reach `ready` within 140s on the second attempt (server was further degraded). Not re-filed as a new bug — matches the campaign's already-known "heavy-import main-thread stall (architectural)" item. |
| M2 — Mixed-type batch (video+image+audio+.txt in one picker selection) | **PASS** | 3/3 real files landed, junk `.txt` cleanly skipped with `toast.error("Unsupported file type: m2-junk.txt")`; Import button not disabled afterward (panel not wedged). Screenshot: `m2-mixed-batch-after.png`. |
| M3 — Upload during another upload (2nd batch fired while 1st still processing) | **PASS** | All 6 files from both overlapping batches (4 video + 2 image) landed with no loss and no crash. Screenshot: `m3-during-upload-after.png`. |
| M4 — Duplicate upload (same exact file twice) | **FAIL** (UX gap, see W-UP-F2) | Two uploads of the byte-identical file produced two fully independent, visually indistinguishable library assets. No warning toast, no merge/skip prompt. Screenshot: `m4-duplicate-after.png`. |
| M5 — Unsupported file type alone (.txt renamed .xyz; a .zip) | **PASS** | Both rejected individually with a clear `Unsupported file type: <name>` toast; panel recovered immediately (a real file uploaded right after landed normally). Screenshots: `m5-unsupported-xyz-toast.png`, `m5-unsupported-zip-toast.png`. |
| M6 — Corrupt media (tiny_640x360_h264.mp4 truncated to ~20KB, kept .mp4 ext) | **PARTIAL** (see W-UP-F1) | App correctly detects the file is unreadable and shows `"Couldn't read a video track from m6-corrupt.mp4. The file may be audio-only or in an unsupported format."` — but then **still adds a phantom video asset to the library anyway** (no duration/dimensions/thumbnail). Screenshot: `m6-corrupt-after.png`. |
| M7 — Delete non-audio asset via context menu, then re-upload same file | **PASS** | Radix context menu opened via a real pointer-sequence right-click, "Delete" removed the asset cleanly, and re-uploading the identical file afterward produced a single clean new asset (no ghost/duplicate, no stale reference). Screenshots: `m7-before-delete.png`, `m7-context-menu-open.png`, `m7-after-delete.png`, `m7-after-reupload.png`. |

Raw machine-readable results: `matrix-raw-results.json` (from the hunt script's
own verdict computation — cross-checked by hand against the console log
before writing this table; two verdicts were adjusted here relative to the
script's own naive computation, see notes under each finding above).

## Findings

### W-UP-F1 — Corrupt/unreadable video is still added to the library despite an explicit "couldn't read a video track" error

- **Severity:** P2
- **Where:** `apps/web/src/lib/media/processing.ts`, `processMediaAssets()`,
  the video branch around lines 315–390. The `decision === "unsupported"`
  arm (line 327) fires `toast.error(...)` but does **not** `continue` past
  the rest of the per-file loop body. Execution falls through to the
  `getVideoInfo({ videoFile: assetFile })` call (line 343), which also fails
  for this file (caught silently by the inner `catch` — only `console.warn`,
  no user-facing signal), and then the asset is unconditionally pushed onto
  `processedAssets` at line 378 with `type: "video"` but `duration`,
  `width`, `height`, `fps` all left `undefined`.
- **Repro (deterministic):**
  1. `head -c 20000 tiny_640x360_h264.mp4 > corrupt.mp4` (truncate a real
     H.264 fixture to ~20KB, keep the `.mp4` extension).
  2. Upload `corrupt.mp4` via the Assets panel Import button (or drag-drop).
  3. Observe the toast: *"Couldn't read a video track from corrupt.mp4. The
     file may be audio-only or in an unsupported format."*
  4. Observe the Assets grid: a new "video" tile for `corrupt.mp4` appears
     anyway — generic placeholder thumbnail, no duration badge — sitting
     indistinguishably next to working assets.
- **Expected:** Either (a) don't add the asset to the library at all when the
  probe/decode step can't read a video track, or (b) if it's kept for manual
  recovery, visually/functionally flag it as broken so a user doesn't drag it
  onto the timeline expecting it to play, then hit a second, more confusing
  failure downstream (blank preview, failed export, etc.).
- **Actual:** Silently added as if the import had fully succeeded, with the
  error toast as the only (easily-missed, auto-dismissing) signal that
  anything was wrong.
- **Evidence:**
  - Script log: `M6 assets added 1 [{"id":"4fdc45aa-0f01-4087-b685-c3717cfc63ec","name":"m6-corrupt.mp4","type":"video"}]` — contrast with a healthy asset's shape, e.g. M4's `{"id":"2075b64d...","name":"m4-dup.mp4","type":"video","duration":2,"width":640,"height":360}`. The corrupt one is missing `duration`/`width`/`height` entirely.
  - Toast captured: `["Couldn't read a video track from m6-corrupt.mp4. The file may be audio-only or in an unsupported format."]`
  - `page.on("pageerror")` fired zero times (no hard crash — this is a silent-inconsistency bug, not a crash).
  - Screenshot: `m6-corrupt-after.png` (generic video placeholder tile, no duration chip, sitting in the grid as if healthy).

### W-UP-F2 — Duplicate upload is silent: no detection, warning, or merge prompt in the manual upload path

- **Severity:** P3
- **Where:**
  - `apps/web/src/lib/commands/media/add-media-asset.ts` —
    `AddMediaAssetCommand.execute()` always mints a fresh `generateUUID()` and
    unconditionally appends to `editor.media.setAssets(...)`; there is no
    dedup/lookup step of any kind.
  - `apps/web/src/components/editor/panels/assets/views/assets.tsx`'s
    `processFiles()` (the Assets-panel upload handler) has no pre-check
    either — it just loops `processMediaAssets` results into
    `editor.media.addMediaAsset(...)`.
  - The only near-duplicate detection in the codebase,
    `findDuplicateAssets` (`apps/web/src/lib/director/director-api.ts:1446`),
    is exposed exclusively as a **Director (AI agent) tool** — gated to the
    `"briefing"` phase in `apps/web/src/lib/director/phase-scope.ts:164` and
    invoked only via the tool-catalog (`apps/web/src/lib/director/tool-catalog.ts:546`).
    It is never called from the manual upload flow a real user drives when
    dragging/importing files, so its existence doesn't help the case this
    matrix row is actually probing.
- **Repro:** Import the same file (byte-identical) twice via the Import
  button (or hidden file input) in the same project.
- **Expected:** Some signal that this file already exists — a warning toast,
  a "this looks like a duplicate of X, import anyway?" prompt, or at minimum
  visual grouping in the grid. (Reasonable editors differ on whether outright
  blocking dupes is correct, but silence isn't a considered choice here — it's
  just the absence of any check.)
- **Actual:** Two fully independent assets with identical name, thumbnail,
  and duration, with zero toast and no visual distinction — a user has no way
  to tell from the library grid alone that they now have two copies of the
  same footage.
- **Evidence:**
  - Script log: `M4 assets added for 2x identical upload 2 [{"id":"2075b64d-acb0-42e2-9fb8-6bbf2989b1c1","name":"m4-dup.mp4",...},{"id":"68219249-bedc-4367-a8a6-a793ce343439","name":"m4-dup.mp4",...}]`, `toasts (any duplicate warning?) []`.
  - Screenshot: `m4-duplicate-after.png` — two identical "m4-dup.mp4" tiles side by side.

## M1 detail (why it's PARTIAL/inconclusive, not filed as a new bug)

First run of the full matrix (dev server cold): M1 got 0/8 within the wait
window while several API routes (`/api/studio/backends`, `/api/mcp/bridge`)
were still cold-compiling (single requests measured 57s–2.6min in the dev
server log purely on Turbopack compile time, unrelated to the upload path).
Second full run (routes warm): M1 still only reached 1/8 (2 by the time the
screenshot fired ~1s later) inside a 90s window; the in-editor perf HUD in
that screenshot reads **1 FPS**, i.e., the whole page was starved of main-
thread time by the contended host, not stuck in the product code specifically.
A dedicated isolated retest (`c26-up-m1-retest.hunt.ts`) with a 4-minute poll
window was attempted to see whether the batch eventually catches up, but the
host had degraded further by that point — the page didn't even reach
`window.__BYORN_E2E__.ready` within 140s, and a plain `curl` to `/` timed out
at 20s shortly after. Given the campaign's own known-issues list already
carries "heavy-import main-thread stall (architectural, known)", and this
run's evidence (1 FPS HUD reading, cascading unrelated route compiles) points
at host contention rather than a fresh regression, this row is left
**PARTIAL/inconclusive** rather than filed as a new finding. If re-run on a
quiet host, re-verify whether all 8 files eventually land (just slowly) or
whether some are genuinely dropped — that distinction still matters and
wasn't resolved here.

## Console/network noise observed on every scenario (not filed — pre-existing/expected)

- `GET http://localhost:8420/health :: net::ERR_CONNECTION_REFUSED` (repeated) —
  a local background-service health poll with no service running in this
  environment; already a known finding from a prior campaign ("8420
  health-poll leak").
- `GET http://localhost:3000/api/auth/get-session :: net::ERR_CONNECTION_REFUSED` —
  no auth server running on :3000 in this standalone dev-server setup;
  expected for this harness, not a product bug.
- `401 http://localhost:3301/api/studio/sets` — expected for an anonymous/
  unauthenticated session (matches known "studio auth gating" state: some
  routes are anonymous-accessible, `/api/studio/sets` correctly 401s).
- First-load `console.error` "Failed to load project ... not found" — the
  documented known first-anon-load error; not re-filed.

## Screenshots in this directory

- `m1-multi-file-after.png`
- `m2-mixed-batch-after.png`
- `m3-during-upload-after.png`
- `m4-duplicate-after.png`
- `m5-unsupported-xyz-toast.png`
- `m5-unsupported-zip-toast.png`
- `m6-corrupt-after.png`
- `m7-before-delete.png`
- `m7-context-menu-open.png`
- `m7-after-delete.png`
- `m7-after-reupload.png`
- `matrix-raw-results.json` — raw per-row verdict/evidence strings emitted by the hunt script.

# W-PROXY — Assets panel PREVIEW/PROXY/THUMBNAIL cluster hunt

Campaign C26 (dogfood hunt). Worker: W-PROXY. Branch: `task/c26-hunt-proxy`
(base `main` @ `6b4a1de2`). Read-only on product source — this doc +
screenshots + throwaway hunt scripts under `apps/web/e2e/hunt/` are the only
deliverables.

Driven via real Chrome (`channel: "chrome"`) against a manually-started
`NEXT_PUBLIC_E2E=1 PORT=3302` dev server, using
`apps/web/playwright.hunt-w2-proxy.config.ts` +
`apps/web/e2e/hunt/w-proxy-hunt.e2e.ts`. Real uploads via the actual
`Import` button -> native file chooser (not the E2E bridge), so the genuine
`processMediaAssets` ingest / proxy pipeline runs exactly as it would for a
paying user. Fixtures: shared `e2e/fixtures/w2/*.mp4` + throwaway
`e2e/fixtures/w2-scratch/*.mp4` minted with ffmpeg for this hunt (corrupt-
but-probeable truncated MP4s, a 400MB+ big file, a VFR-ish clip).

## Environment note (IMPORTANT — read before the matrix)

This Mac ran **5+ concurrent `next dev --turbopack` servers** across
different agent worktrees for the duration of this hunt (host contention),
with system free RAM down to ~130MB and load average 7-20. Effects observed:

- The first cold Turbopack compile of `/editor/[project_id]` took **30+
  minutes** (vs. a normal few seconds) before the route responded at all.
- Even after warm-up, page hydration (`window.__BYORN_E2E__.ready`) and
  `page.evaluate()` round-trips intermittently took minutes instead of
  milliseconds, and the browser page occasionally became fully unresponsive
  ("Target page, context or browser has been closed") mid-test.
- Two full hunt-suite passes were run (~35 min and ~46 min wall time each).
  Several scenarios (M9, full M10, full M12, full M16, EXTRA-reload) did not
  reach their scripted end-state within even generous (4-5 min) per-test
  timeouts, purely due to this contention — NOT because of anything the
  product did. Where a scenario didn't fully complete, this doc says so
  explicitly and cites what partial evidence *was* captured (console logs +
  screenshots up to the point of the stall), plus cross-confirmation from
  sibling scenarios that exercise the identical code path.
- This does not affect the validity of any finding below — every finding is
  about runtime UI/behavior observed via screenshot or captured state, not
  about timing under contention.

## Matrix results

| Row | Scenario | Result | Notes |
|-----|----------|--------|-------|
| M9  | Thumbnails while proxy generating | **PASS (cross-confirmed)** | Direct M9 run blocked by env twice; identical mechanism confirmed via M16/M11 runs — see F1 |
| M10 | Failed proxy (corrupt-but-probeable, big-res) | **PARTIAL — real finding (F2)** | Corrupt file ingests with correct probe metadata but silently gets no thumbnail; full proxy-attempt lifecycle not observed (env) |
| M11 | HDR HEVC 10-bit — assets-side tile/preview/metadata | **PASS (clean, 2 full runs)** | Full screenshot set; no crash; passthrough+proxy-generate confirmed |
| M12 | Portrait 1080x1920 — tile aspect/crop/hover/metadata | **PASS (partial data + cross-confirmed)** | Dims confirmed, grid tile + hover screenshots captured; list-view toggle not reached |
| M13 | Big file (400MB+) import | **PASS (clean, 2 full runs)** | No freeze/crash; imported a 394MB/70min file in 21-59s |
| M16 | Drag/insert onto timeline while proxy generating | **PASS (structural) + P3 observation (F3)** | Insert succeeds during generation; preview showed solid black pixel right after insert |
| EXTRA | VFR-ish clip ingest | **PASS — positive finding (F4)** | Correctly measures averaged fps (12) instead of trusting nominal container fps (30) |
| EXTRA | Thumbnail persistence after reload | **NOT-RUN** | Blocked by environment before reaching the reload step in both attempts |

## Findings

### W-PROXY-F1 — No per-tile indicator while a proxy is generating (P2)

**Repro (deterministic):** Import any video that triggers auto-proxy
generation (either >1920px wide or >1080px tall, e.g.
`portrait_1080x1920_h264.mp4`; or ANY resolution HEVC/passthrough codec,
e.g. `hdr_hevc_1280x720_10bit.mp4`). Watch the Assets panel tile for that
asset from the moment it's created through proxy completion.

**Expected:** Some visual cue on the tile itself (spinner, progress ring,
badge) while its proxy is generating, since generation can take multiple
seconds and the user has no other way to know background work is happening
*for this specific asset*.

**Actual:** The tile shows its final ingest-time thumbnail immediately and
never changes appearance during proxy generation. The only signal anywhere
in the UI is a generic, asset-agnostic "N task running" chip in the
bottom-right status bar (see screenshots) — it doesn't name the asset, and
with multiple assets proxying at once there is no way to tell which is
which. Confirmed with `editor.media.isProxyGenerating(assetId) === true`
captured at the same instant as the screenshot, so this isn't a timing
fluke — the tile genuinely never reflects that state.

**Screenshots:** `m11-01-tile-after-import.png` vs. `m11-02-mid-proxy-gen.png`
(HDR HEVC, pixel-identical tile, `isProxyGenerating` confirmed true for the
second) and `m16-01-before-insert-generating.png` (portrait H.264, same
confirmation).

**Suspected code:** `apps/web/src/components/editor/panels/assets/views/assets.tsx`
`MediaPreview()` (~line 865-944) renders purely off `item.thumbnailUrl` /
`item.type` — no read of proxy state at all. `apps/web/src/core/managers/media-manager.ts`
tracks generation via `proxyGenerators` / `isProxyGenerating()` (~line 419)
and a **project-wide** `useBackgroundTasksStore` task (~line 546-563,
`runAutoProxyGeneration`), but nothing wires that per-asset boolean back
into the tile component.

---

### W-PROXY-F2 — Corrupt/truncated video ingests silently with no thumbnail and no error (P2)

**Repro (deterministic):**
```
ffmpeg -f lavfi -i testsrc=size=2560x1440:rate=30 -t 2 -c:v libx264 \
  -pix_fmt yuv420p -movflags +faststart big_res_2560x1440_h264.mp4
# truncate to 55% of its bytes (keeps the faststart moov header, guts the mdat)
dd if=big_res_2560x1440_h264.mp4 of=corrupt.mp4 bs=1 count=<55%-of-filesize>
```
Import `corrupt.mp4` via the real Import button.

**Expected:** Either the import is rejected with a clear error, or the
asset is flagged as degraded/needs-attention with a retry affordance.

**Actual:** The asset is created successfully with fully correct probe
metadata (`width: 2560, height: 1440, duration: 2, fps: 30` — all read
correctly from the intact faststart header) but **no thumbnail is ever
generated** — the tile permanently shows the generic gray "Video" clock-icon
placeholder (see `m10-01-after-import.png`), identical in appearance to a
thumbnail that simply hasn't loaded yet. No toast, no error badge, no retry
button. A user has zero signal that this asset is damaged; they'd only
discover it when the clip fails (or plays back corrupted/black) after
dragging it onto the timeline or exporting.

**Suspected code:** `apps/web/src/lib/media/processing.ts`, the video branch
of `processMediaAssets` (~lines 342-367): `getVideoInfo()` and
`generateThumbnail()` are awaited inside **one shared try/catch** whose
catch (line 365-367) is just `console.warn("Video processing failed",
error)`. Because `getVideoInfo()` resolves first (reads only container
metadata) and assigns `width`/`height`/`duration`/`fps` before
`generateThumbnail()` is even called, a decode failure in the latter still
leaves those fields populated — so the asset looks fully valid by every
field except the missing thumbnail, and the failure is swallowed with no
user-facing signal at all.

**Not fully confirmed (env-blocked):** Whether `needsProxy()` (true here,
since 2560>1920) actually attempts and fails proxy generation on this same
corrupted data, and whether the resulting asset is genuinely still
insertable/usable on the timeline. `isProxyGenerating()` polling on this
asset repeatedly hit the environment's page-hang issue before an answer
could be captured. Flagging as an open follow-up rather than asserting a
result I don't have.

---

### W-PROXY-F3 — Preview shows solid black immediately after inserting a still-generating clip (P3, unconfirmed root cause)

**Observation:** In the M16 scenario (portrait H.264, `isProxyGenerating`
confirmed `true` at time of insert), inserting the clip onto the timeline
via the same `insertElement` seam a real drag-drop uses succeeds structurally
— correct element created, correct multi-color thumbnail strip rendered in
the timeline track (see `m16-02-after-insert-during-generation.png`) — but
reading back the preview canvas's center pixel immediately after insert
returned solid black (`rgba(0,0,0,255)`) rather than the clip's first frame,
even with the playhead at `00:00` where the clip starts.

**Caveat:** I did not capture a control screenshot of a normal (non-proxy-
generating) insert for direct comparison within this hunt's time budget, so
I can't confirm this is specific to the proxy-generation race vs. a general
"compositor hasn't warmed up yet for a freshly-inserted clip" lag that would
happen regardless of proxy state. Flagging as P3/needs-follow-up rather than
asserting a proxy-specific bug.

**Suggested follow-up:** repeat the exact `m16` script against a clip that
does *not* need a proxy (e.g. `tiny_640x360_h264.mp4`) and diff the
immediately-post-insert preview pixel.

---

### W-PROXY-F4 — VFR-ish content correctly measured to an averaged fps, not the nominal container rate (P3, positive — no action needed)

**Observation:** Minted a clip with genuinely variable inter-frame
intervals (`ffmpeg ... -vf select=... -vsync vfr`, container declares
`r_frame_rate=30/1` but actual `avg_frame_rate≈12.4/1`). On import, the app
reported `asset.fps: 12` — i.e. it measured the real average rate rather
than trusting the container's nominal 30fps. This is good, correct
behavior and is called out here only so nobody re-derives it as a mystery
later when debugging duration/fps mismatches on real phone-shot VFR
footage. No file/fix needed.

---

### W-PROXY-F5 — Repeated aborted `blob:` requests during ingest/preview (P3, pattern only, not chased)

**Observation:** Across M11, M13, and M16 console/network captures, the
same pattern recurs: 8-25 `net::ERR_ABORTED` failures against a single
`blob:http://localhost:3302/<uuid>` URL within one test run. It didn't
visibly break anything in these scenarios (thumbnails and previews still
rendered correctly afterward), but the volume suggests something (a
`<video>`/`<img>` element, or the preview compositor) is repeatedly
re-requesting/re-attaching the same already-created object URL rather than
reusing it once loaded. Not chased to a root cause given the time budget —
flagging the pattern for whoever next touches `services/video-cache/` or
the preview canvas's media-element lifecycle.

---

## Matrix detail / evidence log

**M9** — Direct scenario (fresh portrait H.264 import, poll for the mid-
generation tile) failed to reach the app's ready state within 150s/300s
budgets in both full-suite attempts (environment). However M16's script
(identical fixture, identical `isProxyGenerating` check) succeeded across
both attempts and captured the exact same "is there a tile-level indicator"
question with a definitive `isProxyGenerating === true` + screenshot pair —
see F1. Treating M9 as answered via that cross-confirmation.

**M10** — See F2. Ingest succeeds with correct metadata, no thumbnail, no
error surfaced. Proxy-attempt lifecycle and post-corruption timeline
insertability not confirmed (env-blocked); the asset losing its thumbnail
silently is itself the actionable finding regardless.

**M11** — Clean full pass, twice. `hdr_hevc_1280x720_10bit.mp4` imports as
`{width:1280, height:720, duration:3, fps:30, passthrough:{codec:"hev1.2.4.L93.90"}}`.
`needsProxy()` correctly triggers (passthrough codec, not resolution) and
`isProxyGenerating` was observed `true`. Tile shows a correct color-bar
thumbnail before, during, and after generation (F1). Inserted onto the
timeline and played back without incident. Hovering the tile produced no
scrub-preview or extra overlay beyond a small "+" affordance in the corner
(confirms there's no hover-preview-scrub feature in this codebase — matches
a repo-wide grep for `onMouseEnter`/hover-preview in the assets panel
turning up nothing). No export-color re-litigation — out of scope per
brief.

**M12** — Portrait asset confirmed `{width:1080, height:1920, duration:4,
fps:30}`. Grid tile screenshot (`m12-01-grid-tile.png`) shows the portrait
video cropped via `object-cover` to fill the (roughly square) grid cell —
expected/standard behavior, matches `assets.tsx`'s `className="rounded
object-cover"`. Hover screenshot (`m12-03-tile-hover.png`) shows the same
small "+" affordance as M11, no scrub preview. List-view toggle step was
not reached before the test's overall timeout in either run (environment) —
NOT-RUN for that specific sub-check.

**M13** — Minted a **394.2MB / ~70-minute** H.264 file (640x360,
`-stream_loop`-concatenated from the shared tiny fixture via `-c copy`, no
ffmpeg on this box lacking — `which ffmpeg` → `/opt/homebrew/bin/ffmpeg`).
Imported cleanly in **20.9s** (first run) and **58.9s** (second run, under
worse host contention) wall time from click to asset-ready — no freeze, no
crash, no lost asset. `sawAnyProgressUi` was true in one run and false in
the other (likely just missed the window given the 1s poll granularity, not
a real absence — a "Compiling..." Next.js dev chip was visible throughout,
unrelated to the app's own UI). Duration badge on the resulting tile
correctly read "70:02". This is a clean, unambiguous PASS: no worse-than-
known behavior, well within acceptable bounds for a file this size.

**M16** — Portrait H.264 asset imported, confirmed `isProxyGenerating ===
true`, then `editor.timeline.insertElement()` (the same seam a real
drag-drop uses) called while still generating: `{"ok":true,"elementId":...}`
— no exception, no broken clip. Timeline shows the correct color thumbnail
strip. See F3 for the one caveat (preview pixel black immediately post-
insert). Confirming the clip *remains* usable after the proxy finishes
generating was not captured cleanly in either full run due to environment
stalls on the trailing `isProxyGenerating` poll — but nothing in either run
suggested the clip became unusable; the timeline element persisted intact
in every screenshot taken.

**EXTRA (VFR)** — See F4. Import succeeded, `fps: 12` correctly reflects
the averaged rate of the genuinely-variable-frame-interval fixture. Reload-
persistence half of this scenario (do thumbnails survive a page refresh, or
regenerate) was NOT-RUN — both attempts hit the environment's page-ready
stall before reaching the `page.reload()` step.

## Screenshots (this directory)

`extra-01-vfr-tile.png`, `m10-01-after-import.png`, `m11-01-tile-after-import.png`,
`m11-02-mid-proxy-gen.png`, `m11-03-after-proxy.png`,
`m11-04-on-timeline-preview.png`, `m11-05-tile-hover.png`,
`m12-01-grid-tile.png`, `m12-03-tile-hover.png`, `m13-00-before-import.png`,
`m13-02-during-import-t4.png`, `m13-99-final-state.png`,
`m16-01-before-insert-generating.png`,
`m16-02-after-insert-during-generation.png` (this last one has a stray
component-name debug overlay baked in from the dev environment — a known,
ignorable artifact per the campaign brief, not a product bug).

## Hunt scripts

- `apps/web/playwright.hunt-w2-proxy.config.ts` — throwaway config, reuses
  the manually-started `NEXT_PUBLIC_E2E=1 PORT=3302` dev server,
  `channel: "chrome"`. Not wired into CI.
- `apps/web/e2e/hunt/w-proxy-hunt.e2e.ts` — the 7 scenarios above.
- Scratch fixtures minted into `apps/web/e2e/fixtures/w2-scratch/` and
  committed here since they're the repro inputs for F2/F4:
  `corrupt_bigres_truncated.mp4` (2560x1440, truncated at 55% — F2 repro),
  `big_res_2560x1440_h264.mp4` (its intact source, for reference),
  `vfr_ish_640x360.mp4` (F4 repro). **`big_loop_400mb.mp4` (the M13 400MB
  fixture) was deliberately NOT committed** — a 400MB binary has no place in
  git history. Regenerate it with:
  `ffmpeg -stream_loop 2100 -i e2e/fixtures/w2/tiny_640x360_h264.mp4 -c copy big_loop_400mb.mp4`
  (instant — no re-encode, just remuxes ~4200s of the tiny fixture; -c copy
  keeps this to a couple seconds of wall time).

## Out of scope / explicitly not re-filed

HDR-export color loss (architectural, filed elsewhere), heavy-import
main-thread stall 10-30s (known/architectural — M13's own import was
*faster* than that ceiling in both runs, so no delta to report), audio tile
shape + audio delete/undo (sibling campaign), drag-overlay copy (fixed),
EmptyEditorGuide, timeline empty state, first-load console.error, asset
folders absence, `localhost:8420/health` connection-refused spam (known,
filed), first-anon-load 401s on `/api/studio/sets` (known/expected for an
anonymous session).

Noted-but-not-investigated aside (not this campaign's scope): several
console errors showed `net::ERR_CONNECTION_REFUSED` against
`http://localhost:3000/api/auth/get-session` even though this hunt's dev
server ran on port 3302 — looks like a hardcoded/env-mismatched port
reference somewhere in the auth client. Flagging for whoever owns
auth/studio-gating, not chased further here.

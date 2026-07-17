# P1 worker-compositor default-ON re-verify — GO/NO-GO evidence (2026-07-17)

Branch: task/p1-flag-verify (off 1f9e9164)
Worktree: .claude/worktrees/agent-acbc2fad46c570048

## (a) Bench re-run — INCONCLUSIVE (environmental)

Adapted apps/web/docs/perf/fix-e-worker-compositor/bench.js into scratchpad
(playwright path + FIXTURE_DIR only functional changes required by the task;
additionally had to fix real bugs to get ANY completed run — see below).

Fixtures re-minted via ffmpeg into scratchpad/fixtures/:
- fixture-1080p30-h264.mp4 (1920x1080, h264, 30fps, 20s, aac)
- fixture-4k-hevc.mp4 (3840x2160, hevc/hvc1, 30fps, 24s, aac)
- fixture-audio-3min.wav (pcm_s16le, 180s)

4 bench attempts, all producing rafPerSec < 55 (the validity bar) or crashing:
1. Unmodified bench (paths fixed only): rafPerSec 31, completed, no crash.
2. + single osascript Chrome-activate before rAF probe: rafPerSec 24, then
   CRASHED mid-COLD-playback ("Target page, context or browser has been
   closed").
3. + periodic osascript re-activate every 400ms through the 10s playback
   windows: first invocation failed at page.goto (ERR_ABORTED, stray Chrome
   process from run 2's crash); after cleanup, rafPerSec 1, then CRASHED
   again mid-COLD-playback. Root cause: execFileSync spawning osascript
   every 400ms blocked Node's event loop badly enough to desync the
   Playwright CDP connection.
4. Reverted the osascript-spam; root-caused the throttling to Chromium's
   "Calculate Native Window Occlusion" feature (macOS-specific — treats a
   window covered/backgrounded at the OS compositor level as if the tab
   itself were backgrounded, throttling rAF, independent of Chrome's own
   `--disable-backgrounding-*` flags which only cover Chrome's own
   heuristics). Added `--disable-features=CalculateNativeWinOcclusion` +
   `--window-position=0,0` to the launch args; reduced osascript activation
   to one-shot only. This run COMPLETED without crashing: rafPerSec 43 (still
   under the 55 bar) and a warm-playback fps of 1.65 with avgDecodeMs ~5090ms
   — decode times two orders of magnitude beyond anything in the prior noisy
   baseline.

At that point: `uptime` showed load averages 18-20 (with 9 concurrent
`tsc --noEmit` processes running across other agent worktree sessions on the
same shared host, plus a Zoom Transcode helper process at 200%+ CPU).
This is genuine host-level CPU contention external to the bench/build/flag
under test — no Chrome launch flag or script change fixes a starved CPU.

Per the task's STOP-AND-REPORT clause ("the bench can't produce a valid
(unthrottled) run after 2 retries") — this was retry #3 post-original, with a
real architectural fix applied, and it still fell short of the 55fps rAF bar
for reasons demonstrably external to the code under test. Further retries
were not attempted; running more headed-Chrome benchmarks on an already
load-20 shared host also degrades every other concurrent agent session.

**Numbers table (informational only — NOT valid GO/NO-GO evidence):**

| run | mode | rafPerSec | valid (>=55)? | warm fps | warm avgDecodeMs | notes |
|---|---|---|---|---|---|---|
| prior n1 | off | 31 | no | 14.7 | 15.9 | pre-existing, in repo |
| prior n2 | off | 61 | yes | 5.2 | 165.5 | pre-existing, in repo |
| prior n3 | off | 61 | yes | 9.4 | 126.8 | pre-existing, in repo |
| prior n1 | on | 57 | yes | 24.0 (worker) | 12.1 | pre-existing, in repo |
| prior n2 | on | 61 | yes | 9.0 (worker) | 48.3 | pre-existing, in repo |
| prior n3 | on | 61 | yes | 1.7 (worker) | 993.3 | pre-existing, in repo |
| rerun attempt 1 | off | 31 | no | 9.4 | 126.8 | this session |
| rerun attempt 4 (fixed launch flags) | off | 43 | no | 1.65 | 5090.3 | this session, load avg 18-20 |

Even the PRIOR "valid" (rafPerSec>=55) on-mode runs show wildly inconsistent
warm fps (24 / 9 / 1.7) on the SAME build/flag — the underlying noise problem
this re-verify was commissioned to resolve is not a rAF-throttling artifact
alone; it reproduces under contention regardless of rAF validity. The bench
methodology (10s cold + 10s warm, real headed Chrome, real HTTP fixture
server) is sound, but this shared host cannot currently produce a clean
signal. **Recommend re-running bench.js (adapted copy + launch-flag fix, both
in this branch's evidence dir) in a quiet window** (verify via `uptime` <
~4-6 depending on core count, and no concurrent worktree builds) before
using bench numbers as GO/NO-GO evidence.

## (b) e2e suite, flag ON — PASS

Build: `NEXT_PUBLIC_WORKER_COMPOSITOR=1 bun run build:e2e` (clean, exit 0;
first attempt stalled 23min at load-avg ~18-20 with 2 sibling worktree builds
running — killed and re-run once load dropped, completed normally).

`bun run test:e2e` against that build: **11 passed, 0 failed, 9 skipped**
(1.2m, 20 tests total). Skips are environmental, not flag-related:
4 auth-flow specs self-skip when the local auth backend (Upstash Redis) is
unreachable (ECONNREFUSED visible in webServer logs), 4 fixtures-w2-hunt
specs + 1 golden-path-export spec belong to the real-export configs
(`playwright.fixtures-w2.config.ts` / `playwright.real-export.config.ts`),
not this suite's stub build. Zero failures → per the brief, no flag-off
comparison run needed.

NOTE the significance of this pass given (c) below: the e2e suite drives the
editor through timeline/generate/export logic but never asserts on the
PIXELS of the preview canvas — which is exactly where the flag-ON path is
broken. Green e2e + black preview is the expected combination for this bug.

## (c) Golden-path browser drive, flag ON — FAIL (BLACK PREVIEW, root-caused)

Drive script: `golden-path.js` (this dir). Real headed Chrome, 1600x1000
viewport (MobileGate needs >=1400px), localStorage flag + flag-ON build.
Step results (gp-verdict.json):

- editor ready, worker compositor mounted (`__byornPerfWorker` present): PASS
- import real 1080p30 h264 via the real file-input UI: PASS (ingested,
  duration 20.0s, thumbnails minted)
- place on timeline: UI drag AND dblclick were intercepted by a media-card
  overlay div (Radix pointer-events gotcha) — placed via E2E-bridge
  `insertElement` fallback (noted; placement itself is not the finding here)
- play via spacebar: PASS — playhead advanced 0 → 14.3s in ~13s wall,
  worker stats: +241 framesRendered, renderErrors 0
- **preview canvas visibly painted: FAIL** — screenshots `gp-2-playing.png`
  (mid/end playback) and `gp-3-after-trim.png` (paused at 00:03) both show a
  COMPLETELY BLACK preview area while timeline thumbnails and media-panel
  thumbnails render fine
- trim via real edge-drag: NOT VERIFIED (drive-script selector didn't match
  the clip's resize handles; inconclusive, not a product finding)
- preview kept "rendering" after trim step: PASS per worker stats
  (framesRendered 248 → 327) — but see below: those frames are painted onto
  a canvas the user cannot see.

### Root cause of the black preview (diagnosed, NOT fixed — evidence-only task)

Empirical probe (`overlay-probe.js` → `overlay-probe-result.json`): read
pixels of both stacked canvases independently, paused at t=2s with a video
clip on the timeline:

- canvas[0] — the worker's transferred canvas (`cls "block border"`,
  1920x1080): 576/576 sampled pixels REAL VIDEO CONTENT (colorful testsrc2)
- canvas[1] — the main-thread overlay canvas
  (`cls "pointer-events-none absolute inset-0 block"`, 1920x1080):
  576/576 sampled pixels OPAQUE BLACK

The overlay canvas is stacked on top of the worker canvas
(worker-preview-canvas.tsx:365-371) and is supposed to be transparent except
for text/image/sticker elements (worker-preview-canvas.tsx:279-284 passes
`background: { type: "color", color: "transparent" }`). But the overlay is
painted via `CanvasRenderer.renderToCanvas`
(worker-preview-canvas.tsx:321-326), and `renderToCanvas` → `render()` →
`this.clear()` — and `clear()` unconditionally fills the renderer's internal
canvas OPAQUE BLACK before painting nodes
(`src/services/renderer/canvas-renderer.ts:121-124`, called at :133), then
`renderToCanvas` blits that entire internal canvas over the target
(`canvas-renderer.ts:160`). The scene's "transparent" background is never
honored; every overlay frame is an opaque black 1920x1080 rectangle that
fully hides the video beneath. In flag-OFF mode the same clear() is correct
(single canvas, black letterbox intended) — the bug only manifests in the
two-layer worker mode.

Consequences:
- ANY project (even zero text/image/sticker elements) shows a black preview
  the moment the overlay's rAF loop paints frame 0.
- All prior flag-ON bench numbers measured a compositor whose output was
  invisible to the user; nothing in the bench or e2e suite asserts preview
  pixels, so this was never caught.
- The fix is presumably small (clear to transparent / skip the black fill
  for the overlay renderer instance) but is OUT OF SCOPE for this
  evidence-only task per the brief ("do not attempt fixes").

Screenshots: gp-1-editor-empty.png, gp-2-playing.png, gp-3-after-trim.png,
overlay-probe.png; per-canvas pixel counts: overlay-probe-result.json.

## (d) Feature-parity audit — flag-OFF (`PreviewCanvas`) vs flag-ON (`WorkerPreviewCanvas`)

Files read in full: `apps/web/src/components/editor/panels/preview/index.tsx`
(625 lines, contains both `PreviewPanel` and inline `PreviewCanvas` +
`RenderTreeController`), `worker-preview-canvas.tsx` (386 lines),
`context-menu.tsx`, `guide-picker.tsx`, `layout-guide-overlay.tsx`,
`bookmark-note-overlay.tsx`, `toolbar.tsx`, `compositor-controller.ts`,
`compositor-types.ts`, `scopes/index.tsx`, `sample-canvas.ts`,
`use-editor-actions.ts`, `renderer-manager.ts`.

1. **Zoom / pan (wheel-zoom, pan-tool drag, "zoom to fit") — dead controls**
   PreviewCanvas reads `zoom`/`pan`/`panMode` from `usePreviewStore`
   (index.tsx:307), wires wheel-zoom (index.tsx:436-460) and pan pointer
   handlers (index.tsx:462-496), applies them as a canvas transform
   (index.tsx:369-375, 581-585) and publishes `fitScale` (index.tsx:425-430).
   `WorkerPreviewCanvas` reads none of this — `displaySize`
   (worker-preview-canvas.tsx:134-157) has no zoom factor, no wheel/pan
   handlers exist, `setFitScale` is never called. The toolbar's
   `PreviewZoomControls` (toolbar.tsx:196-246) is mounted unconditionally
   (index.tsx:206-209 — `PreviewToolbar` renders regardless of
   `workerCompositorEnabled`), so its zoom%, "Zoom to fit", and pan-tool
   toggle become no-ops with a stale/default zoom% readout while the worker
   path is active. Documented as a known limitation: worker-preview-canvas.tsx:24-26.

2. **`PreviewInteractionOverlay` (click-select, drag/resize/rotate, mask
   handles) — entirely absent**
   PreviewCanvas: index.tsx:610-613. WorkerPreviewCanvas's JSX return
   (worker-preview-canvas.tsx:342-385) has no equivalent. Documented:
   worker-preview-canvas.tsx:24-26 ("interaction overlay... read/write the
   main-thread node tree synchronously, which the worker split doesn't
   support yet").

3. **Right-click context menu (`PreviewContextMenu`) — entirely absent**
   PreviewCanvas wraps the canvas in `<ContextMenu>`/`<ContextMenuTrigger>`
   (index.tsx:576-622) rendering 6 actions (context-menu.tsx:24-54): Full
   screen, Save snapshot (`editor.renderer.saveSnapshot()`), Show bookmarks,
   Show performance stats, Show grid, Show TikTok guide.
   WorkerPreviewCanvas is a plain `<div>` (worker-preview-canvas.tsx:342-385)
   — none of the 6 are reachable via right-click in worker mode.
   `PreviewPanel` also never passes `onToggleFullscreen` to
   `WorkerPreviewCanvas` at all (index.tsx:189 vs. 191-194; the component's
   own prop type at worker-preview-canvas.tsx:82-92 doesn't declare it) —
   though the toolbar's own fullscreen button (unconditional, index.tsx:206-
   209) still works in both modes, so fullscreen itself isn't fully broken,
   only its context-menu entry point. `overlays.bookmarks`/`overlays.perfHud`
   visibility toggling (`setOverlayVisibility`, context-menu.tsx:33-43) has
   NO other control surface anywhere in the app — unreachable while in
   worker mode.

4. **`BookmarkNoteOverlay` — never rendered in worker mode**
   PreviewCanvas: `{overlays.bookmarks && <BookmarkNoteOverlay />}`
   (index.tsx:614). WorkerPreviewCanvas never imports/renders it — bookmark
   notes are invisible in worker mode regardless of the flag's state.

5. **`LayoutGuideOverlay` (rule-of-thirds / TikTok safe-zone) — dead visual**
   PreviewCanvas: `<LayoutGuideOverlay />` (index.tsx:609).
   WorkerPreviewCanvas never renders it. Unlike #3/#4, the *control* to
   toggle a guide is still reachable in worker mode (the toolbar's
   `GuidePickerButton`/`GuidePicker`, index.tsx:183-185, is mounted
   unconditionally and writes `activeGuideId` directly to the store) — but
   toggling it produces no visible guide, since nothing reads that state on
   the worker-mode render path.

6. **Playback-quality downscale-while-playing — not ported**
   PreviewCanvas: `renderSize` shrinks the canvas backing store based on
   `playbackQuality` while playing (index.tsx:377-405,
   `getPlaybackRenderScale`). WorkerPreviewCanvas always composites at native
   project resolution (`width={nativeWidth} height={nativeHeight}`,
   worker-preview-canvas.tsx:352-354) — no such scaling exists. Explicitly
   documented as a prototype limitation (worker-preview-canvas.tsx:20-23),
   and specifically why bench.js forces `playbackQuality: "full"` in BOTH
   modes for a fair comparison (bench.js:46-52 in the original;
   corresponding lines in the adapted copy).

7. **Proxy-then-settle sharpening — not ported**
   Main-thread `RenderTreeController` computes `settled`
   (index.tsx:75-111, `useIsPlaybackSettled`) and passes
   `useProxy: (proxyEditing ?? true) && !settled` (index.tsx:267) so a
   paused/idle frame rebuilds onto the full-res original after
   `PLAYBACK_SETTLE_DELAY_MS` (250ms, index.tsx:62). WorkerPreviewCanvas's
   `updateScene` call always passes
   `useProxy: activeProject.settings.proxyEditing ?? true` with no
   settled-gating (worker-preview-canvas.tsx:263-271) — paused frames in
   worker mode stay on the softer proxy indefinitely instead of sharpening.

8. **`previewBackingStoreLongEdge` / upscaled-proxy protection — not ported**
   Main thread computes `usePreviewBackingStoreLongEdge`
   (index.tsx:124-153) and passes it into `buildScene`
   (index.tsx:268-272) so a zoomed-in/high-DPR preview never shows an
   upscaled (blurry) proxy. WorkerPreviewCanvas's `updateScene` call never
   passes this (worker-preview-canvas.tsx:263-271). Lower practical severity
   today since worker mode also lacks zoom (#1), but becomes live the moment
   #1 is fixed.

9. **Scopes panel / auto color-correction pixel sampling — VERIFIED WORKING
   (readback), with a fidelity gap**
   Both paths publish the canvas element into `usePreviewCanvasStore`
   (index.tsx:500-505; worker-preview-canvas.tsx:295-300), which
   `ScopesPanel` reads and calls `drawImage()`/`getImageData` on
   (scopes/index.tsx:83-90, `sample-canvas.ts`). In worker mode that canvas
   has been transferred via `canvas.transferControlToOffscreen()`
   (compositor-controller.ts:82). EMPIRICALLY VERIFIED (overlay-probe.js,
   Chrome 2026-07): the transferred placeholder canvas IS readable as a
   `drawImage` source from the main thread and returns the worker's latest
   committed frame — scopes/auto-correct do not break. Remaining fidelity
   gap: in worker mode they sample ONLY the worker canvas (video/effect
   layers) — text/image/sticker elements live on the separate overlay canvas
   and are invisible to scopes, whereas flag-OFF scopes sample the full
   composite.

10. **Custom/text mask rasterization on video/color elements — unaudited
    risk, not a confirmed break**
    `splitTracksForWorkerCompositor` (compositor-types.ts:44-61) splits by
    ELEMENT TYPE only (`text`/`image`/`sticker` → main-thread overlay,
    compositor-types.ts:28-32). A video/color element carrying a custom or
    text MASK is not filtered out of the worker's scene, and mask
    rasterization (custom-mask.ts/text-mask.ts) uses `document.createElement`
    — unavailable in a Worker global scope. Flagged as untested:
    worker-preview-canvas.tsx:27-30. The bench fixture project never
    exercises masks, so this has never been hit by existing bench evidence
    either.

**Not a gap (verified):** freeze-frame (`use-editor-actions.ts:388-460`
comment block, lines 392-399) and "Save snapshot"
(`renderer-manager.ts:27-51`) both build their OWN render tree on demand
from `editor.timeline`/`editor.media` directly — neither depends on
`editor.renderer.getRenderTree()` (the tree only `RenderTreeController`
keeps populated, and it's unmounted in worker mode per index.tsx:204). Both
work identically in either mode; "Save snapshot" is simply unreachable via
the context menu in worker mode per gap #3 above (its underlying logic is
fine).

## GO/NO-GO recommendation: **NO-GO** (hard)

The flag-ON path ships a black preview to every user: the main-thread
overlay canvas paints opaque black over the worker's (correct) video output
on every frame — root-caused to `CanvasRenderer.clear()`'s unconditional
black fill (canvas-renderer.ts:121-124) being blitted wholesale onto the
"transparent" overlay. This alone is disqualifying regardless of perf
numbers, and it invalidates the premise of the prior flag-ON bench data
(fps measured on an invisible canvas).

Secondary blockers, any one of which would independently argue against a
default flip today (parity audit, all with file:line above):
- zoom/pan/fit controls become silent no-ops (gap 1)
- selection/drag/resize interaction overlay absent (gap 2)
- right-click menu absent; bookmarks/perf-HUD toggles unreachable (gap 3)
- bookmark + layout-guide overlays never render (gaps 4, 5)
- playback-quality downscale + proxy-settle sharpening not ported
  (gaps 6, 7) — i.e. flag-ON would also LOSE two shipped perf/quality
  features the flag-OFF path has

Bench numbers: could not produce a valid (rAF>=55) run under this host's
load (18-20 loadavg from concurrent agent sessions); see (a). Not needed
for the decision — (c) is decisive.

Suggested path to a future GO:
1. Fix the overlay clear (transparent clear for the overlay renderer, or
   skip the blit when the overlay scene is empty), re-drive the golden path
   visually.
2. Port or consciously de-scope gaps 1-7.
3. Re-run bench.js (adapted copy in this dir, incl. the
   `--disable-features=CalculateNativeWinOcclusion` fix) on a quiet host,
   3+3, all runs rAF>=55.

## Files in this evidence dir

- `EVIDENCE.md` — this doc
- `bench-adapted.js` — bench copy actually run (paths fixed + occlusion
  launch-flag fix + one-shot focus nudge; committed original untouched)
- `result-base-off-attempt4.json` — the one completed-but-INVALID bench run
  that wrote a JSON (rafPerSec 43; attempt 1's JSON, rafPerSec 31, was
  overwritten by attempt 4 — its numbers survive in the table above)
- `bench-attempt2.log`, `bench-attempt3.log`, `bench-attempt4.log` — raw
  stdout of the crashed/invalid attempts
- `golden-path.js`, `gp-verdict.json`, `gp-1-editor-empty.png`,
  `gp-2-playing.png`, `gp-3-after-trim.png` — golden-path drive
- `overlay-probe.js`, `overlay-probe-result.json`, `overlay-probe.png` —
  per-canvas black-preview diagnosis

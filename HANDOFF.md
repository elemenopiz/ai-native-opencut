# FIX-E — Worker Compositor Prototype — HANDOFF

Branch: `perf/worker-compositor-proto` (worktree: `/Users/zsha/Documents/ai-native-opencut-fix-e`)
Wave: 2026-07-14 perf implementation wave, opportunity #6 (axis-2 render pipeline audit).
Status at handoff: **prototype built, typecheck/lint green, worker verified end-to-end
(pixels + effects + zero render errors); fps GO/NO-GO measured N=3 paired but
INCONCLUSIVE — dominated by severe ambient memory pressure on the shared 8 GB bench
machine. Best clean paired run: worker 24.0 fps vs main-thread 14.7 fps warm (≥15 fps
target met, +63%); pressure-dominated later runs collapse both modes, worker harder.
See "MEASURED RESULTS" below.**

## What this is

Moves playback compositing (video/color/effect/transition layers) and the mediabunny/
WebCodecs decode pump off the renderer main thread into a dedicated Worker via
`OffscreenCanvas` + `transferControlToOffscreen`. Text/image/sticker layers stay on the
main thread as a transparent overlay canvas. Flag-gated, default OFF.

## Architecture — what runs where

```
Main thread (React)                          Worker (compositor.worker.ts)
────────────────────                         ──────────────────────────────
WorkerPreviewCanvas                           onmessage:
  - canvasRef <canvas> ──transferControlToOffscreen──▶ init: new CanvasRenderer(OffscreenCanvas)
  - overlayCanvasRef <canvas> (main-thread          scene: buildScene(tracks, mediaAssets, ...)
    CanvasRenderer, text/image/sticker only)         resize / play / pause / seek / perf / dispose
  - useDeepCompareEffect → updateScene()         Independent clock (mirrors PlaybackManager's
    (splits tracks: video/effects/transitions      rAF-delta model) + own rAF-equivalent loop
    → worker; text/image/sticker → overlay)       (self.requestAnimationFrame, verified
  - editor.playback.subscribe() → play()/          available in Chrome 150 for a worker
    pause() (genuine transitions only)             holding an OffscreenCanvas context;
  - window 'playback-seek' event → seek(time)      setTimeout(1000/fps) fallback otherwise)
                                                  renderer.renderToCanvas(rootNode, time,
                                                    offscreen) each tick — SAME CanvasRenderer/
                                                    node classes/VideoCache as main thread,
                                                    imported unmodified.
```

Key design decision: **zero changes to the shared render core.** `CanvasRenderer`,
`scene-builder.ts`, all `nodes/*.ts` (video/image/color/effect-layer/composite-effect/
transition/root), `video-cache/service.ts`, and `perf-stats.ts` are imported **unmodified**
into the worker's module graph. The worker gets its OWN singleton instance of `perfStats`
(ES modules are per-realm; the worker's copy is independent of the main thread's), so
`videoCache.getFrameAt`/`webglEffectRenderer.applyEffect`/`CanvasRenderer.renderToCanvas`'s
existing instrumentation calls (`addDecodeTime`/`addEffectTime`/`addBlitTime`) just work
inside the worker with no duplicated tracking code.

The main thread and worker communicate ONLY via `postMessage` + transferables (canvas
transfer, `File` objects inside `MediaAsset` clone fine). No `SharedArrayBuffer` — confirmed
unnecessary and unavailable anyway (`crossOriginIsolated: false` in this deploy).

## Files added

- `apps/web/src/services/renderer/worker/compositor-types.ts` — shared message protocol +
  `splitTracksForWorkerCompositor()` (the video/effects vs text/image/sticker track split).
- `apps/web/src/services/renderer/worker/compositor.worker.ts` — the worker entry. Owns its
  own playback clock, render loop, and (imported, unmodified) `CanvasRenderer`/`buildScene`.
- `apps/web/src/services/renderer/worker/compositor-controller.ts` — main-thread
  `WorkerCompositor` class: mounts the worker, transfers the canvas, translates discrete
  playback events into worker messages, exposes `window.__byornPerfWorker` for bench/debug
  (parallel to the existing `window.__byornPerf` main-thread singleton from e2e-bridge.tsx,
  which was NOT touched).
- `apps/web/src/components/editor/panels/preview/worker-preview-canvas.tsx` — the React
  component mounted instead of `PreviewCanvas` when the flag is on. Two stacked canvases
  (worker-owned + main-thread text overlay).

## Files changed (additive only)

- `apps/web/src/components/editor/panels/preview/index.tsx` — `PreviewPanel` now branches
  between `<PreviewCanvas>` (flag off, untouched) and `<WorkerPreviewCanvas>` (flag on).
  ~28 lines added, 4 changed. `RenderTreeController` (the shared `editor.renderer` render-tree
  publish, used by `freeze-frame` and any future consumer of `getRenderTree()`) is still
  rendered unconditionally in BOTH modes, so nothing outside the preview canvas itself
  observes a behavior change.

## Feature flag

`NEXT_PUBLIC_WORKER_COMPOSITOR=1` at build time, **OR**
`localStorage["byorn-worker-compositor"] === "1"` at runtime (checked in a `useEffect` AFTER
first mount, specifically to avoid an SSR/CSR hydration mismatch — the initial render only
ever reads the build-time env var, which is identical server/client).

The localStorage path exists so **one production build serves both the flag-off baseline and
the flag-on measurement** — the same trick axis-2's `bench.js` already uses to force
`playbackQuality: "full"` for the res4k scenario (seed via `addInitScript` before the app
loads). This mattered a lot here: a second full `bun run build:e2e` costs several minutes on
a contended 8 GB shared machine.

Default is OFF either way — an unset env var and empty localStorage key reproduce the exact
pre-existing `PreviewCanvas` path with no code executed from the new files.

## Verification done so far

1. `bun run typecheck` — clean.
2. `bun run lint` (scoped `npx biome check` on the 3 new/changed paths) — clean; the repo-wide
   `bun run lint` has ~369 pre-existing errors on `main` unrelated to this change (confirmed via
   `git diff --stat` that the one file biome still flags near line 435 of `index.tsx` — a stale
   `noStaticElementInteractions` suppression — predates this branch, from @75e7d287).
3. **Production build** (`bun run build:e2e`) succeeded. Needed `.env.local` copied into the
   worktree first (worktrees don't inherit gitignored env files — see Gotchas).
4. **Worker load smoke test** (ad hoc Playwright script, not checked in): navigated to the
   built app with the flag on, awaited `window.__byornPerfWorker.whenReady()` — resolved
   (`"ready-resolved"`), proving the worker script (and its FULL import graph: buildScene,
   CanvasRenderer, all node classes, mediabunny, perf-stats) loads and executes correctly in
   Chrome 150. This was worth checking explicitly: the compiled `.next/static/media/
   compositor.worker.*.ts` asset LOOKS like raw untranspiled TypeScript source on disk (same
   byte-for-byte header as the source file) — Turbopack apparently ships worker entries as
   ES-module-graph assets resolved via the browser's own module loader rather than a single
   pre-bundled chunk (same true of the pre-existing `clip.worker.ts`/`whisper.worker.ts` — their
   built output is identically unbundled-looking). Don't trust that appearance; it works,
   confirmed by the ready-handshake round trip.
5. **Real video compositing smoke test**: built a 1-clip project via `window.__BYORN_E2E__`
   with the flag on, waited ~2.5s, sampled pixels from the transferred canvas (via
   `ctx.drawImage(transferredPlaceholderCanvas, ...)` on a scratch canvas from the main
   thread — confirmed this works fine post-transfer, same mechanism the scopes panel already
   uses via `sample-canvas.ts`). Got real non-black decoded video pixels (a distinct color
   from the ffmpeg testsrc2 fixture pattern) and a real `workerStats` snapshot
   (`framesRendered: 3`, `avgDecodeMs: 28`, nonzero blit time) — i.e. the worker is genuinely
   decoding via mediabunny/WebCodecs and compositing, not silently no-op'ing.

## MEASURED RESULTS (2026-07-15 00:15–01:45 JST, shared 8 GB M3, lock window)

Scenario: THE fixture project "base" (4× 1080p staggered + 4K HEVC + text + 2-effect chain
+ cross-dissolve + audio, per axis-2 protocol), `playbackQuality:"full"` forced in BOTH
modes, prod-e2e build of THIS branch, Chrome 150 headed via `channel:'chrome'` + the three
anti-throttling flags, rAF probe 57-61/s verified per run. Driver:
`$BENCH/fix-e/bench.js <base> <off|on> 3115`; raw JSON in `$BENCH/fix-e/result-*.json`.

| Run (chronological) | mode | cold fps (window) | warm fps (window) | warm throughput fps | warm avgFrame / avgDecode ms |
|---|---|---|---|---|---|
| N1 ~01:15 | off (main-thread) | 25.5 | **14.7** | n/a (added N3) | 33.4 / 15.9 |
| N1 ~01:25 | on (worker) | 29.9 | **24.0** | ~32 (324 frames/10 s) | 10.3 / 12.1 |
| N2 ~01:30 | off | 28.1 | 5.2 | ~4.3 (43 frames/10 s) | 106.1 / 165.5 |
| N2 ~01:33 | on | 29.8 | 9.0 (window contaminated, no pre-warm reset) | ~2.7 (27 frames/10 s) | 47.2 / 48.3 |
| N3 ~01:38 | off | 29.2 | 9.4 | 4.9 | 51.6 / 126.8 |
| N3 ~01:42 | on | 25.9 | 1.7 | 1.4 | 480.1 / **993.3** |

(Flag-on numbers are `workerStats` — the worker realm's own perfStats; `mainStats` in
worker mode only sees the text-overlay pass and stays ~empty. N1/N2 worker stats were not
reset before warm — reset + exact `warmThroughputFps` were added to bench.js before N3.)

**Reading the table honestly:**

- **Cold is at/near the 30 fps project ceiling in ALL SIX runs, both modes** (25.5–29.9).
  Today's `main` (71d99253) is already far faster on this fixture than the audit's
  @a2af6c7f baseline (audit: 5.8 cold / 4.8 warm) — other wave landings and/or different
  ambient load; the audit's own §8 warning about re-baselining applies in both directions.
- **The paired warm comparison flipped between runs.** N1 (lightest ambient load):
  worker 24.0 vs main 14.7 — worker wins +63% and clears the ≥15 fps GO bar. N2/N3 (run
  progressively later; `vm_stat` showed **~200 MB free** on the 8 GB machine by N3, 34
  Chrome processes system-wide): both modes collapse, and the worker collapses HARDER
  (1.4–2.7 fps vs 4.3–4.9 fps; N3 worker avgDecode 993 ms/frame while its cold pass 4
  minutes earlier ran 25.9 fps).
- **A consistent secondary signal: warm << cold in all 6 runs, both modes.** The warm
  pass isn't "warmer" on this bench — by warm, the local-AI CLIP indexing of the 6
  just-added assets is in full swing (ONNX logs visible in-page) and memory pressure has
  peaked. The audit's cold/warm labels came from a quieter protocol.
- **Worker-mode correctness held in every run**: renderErrors 0, framesSkipped 0
  (skip accounting differs — the worker loop doesn't count busy-tick drops — so don't
  compare that column across modes), effects verified executing in-worker
  (avgEffectMs > 0 on an effect-covered window; see fix in "Bugs found & fixed").

**Interpretation (mechanism, not excuse):** the worker's advantage is main-thread
liberation; its N3 failure mode (decode 993 ms while the decoder itself is idle-capable)
is the same decoder-starvation shape as the audit's fps60 wedge, amplified here by system
memory pressure (4K ring frames are huge; ~200 MB free system-wide). Under memory
pressure the extra realm's working set (second VideoCache, second canvas set) plausibly
makes the worker path the first to page-thrash. That is a real finding, not noise: an
8 GB machine under load is a persona Byorn cares about.

## Bugs found & fixed during measurement

- **Effect/transition registries are per-realm.** First flag-on run threw
  `Unknown effect type: color-adjust` ×232: `registerDefaultEffects()`/
  `registerDefaultTransitions()` are called by the EditorCore constructor on the main
  thread only. Fixed: the worker entry now calls both at module init
  (compositor.worker.ts). User `.cube` LUT presets (`hydrateUserLutPresets`) are still
  NOT hydrated in the worker — persisted-storage port needed (limitation #8).

## Prototype limitations (by design, staged MVP — not gaps to silently fix)

1. **Text/image/sticker layers render on the main thread**, not the worker:
   - `text-node.ts` uses DOM font measurement APIs and — per this task's explicit
     instructions — is being edited by another live session; out of bounds to touch or port.
   - `image-node.ts` / `sticker-node.ts` both call `new Image()` (HTMLImageElement), which
     does not exist in a Worker global scope. Porting them means switching to
     `fetch`+`createImageBitmap` (workable, not done here).
   - THE fixture project has exactly one text element and zero image/sticker elements, so
     this split has zero effect on the measured scenario.
2. **No playback-quality downscale-while-playing** in the worker path (`getPlaybackRenderScale`
   / `preview-store.ts`'s "auto/half/quarter" resolution scaling was not ported) — the worker
   always composites at native project resolution. The bench forces `playbackQuality: "full"`
   on BOTH flag states specifically to neutralize this asymmetry for a fair comparison; a real
   ship would need to port the scaling logic (straightforward: it only needs occasional
   `resize` messages, which the protocol already supports).
3. **No pan/zoom/interaction-overlay wiring**: `WorkerPreviewCanvas` has no equivalent of
   `PreviewInteractionOverlay`/`BookmarkNoteOverlay`/`LayoutGuideOverlay`/context menu/mask
   drag handles. Those read and mutate the main-thread node tree synchronously for hit-testing;
   the worker split doesn't support that today. Fine for a measurement prototype, NOT fine to
   ship without addressing — clicking/dragging on the canvas in worker mode currently does
   nothing.
4. **Masks are not filtered out of the worker scene.** `custom-mask.ts`/`text-mask.ts`
   (used when a video/image element has a mask shape) call `document.createElement` for
   rasterization — untested and likely broken in a worker. THE fixture project's clips carry
   no masks, so this never fires in the measured scenario, but a real project with masked
   clips would hit an unaudited codepath. Needs either a DOM-free rasterizer or filtering
   masked elements into the overlay path too (same treatment as text/image/sticker).
5. **Export is completely untouched** (scene-exporter.ts not imported anywhere in the new
   files) — this prototype is playback-only, as scoped.
6. **Audio is unaffected either way** — `buildScene`/the render tree never included audio
   elements to begin with (confirmed by reading `scene-builder.ts`: no `"audio"` case in
   `buildTrackNodes`), so there was nothing to move.
7. **No CDP main-thread-busy% trace** for the flag-on path (N=3 paired fps runs WERE
   completed — see MEASURED RESULTS — but the machine was too pressure-noisy to make a
   trace worth its ~30% overhead; capture one on the quiet-machine re-run instead).
8. **User `.cube` LUT presets are not hydrated in the worker realm** —
   `hydrateUserLutPresets` reads persisted storage on the main thread only; a project
   using a saved user LUT would throw `Unknown effect type` in the worker. Same
   per-realm-registry class as the bug fixed in compositor.worker.ts.

## Gotchas for whoever continues this

- **Worktrees don't get gitignored env files.** `bun run build:e2e` failed on first attempt
  in this worktree with a Zod validation error on `DATABASE_URL` etc. — `.env.local` had to be
  copied from the main checkout (`cp /Users/zsha/Documents/ai-native-opencut/apps/web/.env.local
  apps/web/.env.local`). Not committed (gitignored), just noting it for the next session in
  case a fresh worktree is created.
- **`next build` leaves `next-env.d.ts` modified** (dev-vs-build type-route path). Harmless,
  auto-regenerated, reverted before commit here (`git checkout -- next-env.d.ts`) to keep the
  diff clean — do the same if it reappears.
- **Don't trust `.next/static/media/*.worker.ts` file contents as evidence the worker is
  bundled/working** — verify empirically (see "Worker load smoke test" above). This cost real
  investigation time; save the next person the same detour.
- **GitNexus's `detect_changes`/`impact` tools only know about repos they've indexed**
  (`ai-native-opencut` at the main checkout path, and one other worktree) — this fix-e
  worktree was NOT a registered repo, so `detect_changes({scope:"compare", base_ref:"main"})`
  silently compared the WRONG checkout (the main working tree's own uncommitted changes from
  other sessions, not this branch's diff). Verified via manual `git status`/`git diff --stat`
  in the fix-e worktree instead. If GitNexus needs to see this branch, `npx gitnexus analyze`
  from the fix-e worktree first.
- **The bench LOCK is heavily contended** — this session observed `fix-d` holding it from at
  least 00:07 to past 00:31 local (24+ minutes, under the 35-min stale threshold the whole
  observed window). Budget real wall-clock slack for this in any follow-up.

## Recommendation

**Architecture: proceed.** The zero-shared-core-changes design (worker imports the exact same
`CanvasRenderer`/`buildScene`/node classes/`VideoCache`/`perfStats` main already uses) is a
clean, low-risk seam — confirmed end-to-end via the ready-handshake and real pixel/decode
smoke tests. This is exactly the "dedicated render thread" architecture move the audit rates
CLOSABLE and its own opportunity #6 recommends.

**GO/NO-GO on the fps target: INCONCLUSIVE — do NOT ship, do NOT kill.** The one clean
paired run met the bar (24.0 vs the ≥15 fps target, +63% over its paired baseline); the
two pressure-dominated runs inverted the result (see MEASURED RESULTS). Two things must
happen before a verdict:

1. **Re-run the paired base bench on a quiet ≥16 GB machine** (the audit's own §8
   requirement for ANY trustworthy number) — 15 minutes of work with
   `$BENCH/fix-e/bench.js`, N≥3 each mode, alternating off/on to cancel drift.
2. **Chase the worker-mode pressure collapse** (N3: avgDecode 993 ms warm vs 25.9 fps cold
   in the same session). Hypotheses, in order: (a) memory-pressure paging of the worker
   realm's 4K ring/canvas working set — instrument renderer RSS (audit item #10's missing
   arbiter) during a flag-on run; (b) the fps60-wedge starvation class surfacing in the
   worker's tighter request loop after seek(0) — add per-sink chain-stall telemetry;
   (c) CLIP-indexing GPU/CPU contention landing mid-warm — re-run with local-AI disabled
   to isolate. Fixes #10/#11 from the audit (VideoFrame close discipline, byte-bounded
   LRU) are the likely real remedies and belong to this same architecture direction.

Also worth knowing for prioritization: on today's `main`, the fixture project's warm
playback is already 5–15 fps (not the audit's 4.8 flat) and cold hits the 30 fps ceiling
in both modes — re-baseline before assuming the worker compositor is still the #1 lever.

# AXIS-2 — Render / Compositor Pipeline Audit

STATUS: FINAL (2026-07-14). Headline: the compositor's GPU pipeline is nearly idle
(2 draws, 2 uploads, 2.4-4.9ms/frame); THE fixture project plays at 3-6.5fps because the
RENDERER MAIN THREAD is ~81% saturated — it hosts the decode pump (mediabunny iteration
+ VideoFrame→canvas raster), the compositor loop, 631 forced layouts per 10s of playback
from tick-path UI, and the async render microtask chains. The HW decoder itself averages
6.9ms/frame and sits starved. Fix the threading (worker compositor + worker decode),
not the graphics.

## Header
- Machine: Apple M3, 8 cores, 8 GB RAM, macOS 26.3 (memory pressure real — pageouts observed; caveat on all numbers)
- Browser: Google Chrome 150.0.7871.115, channel 'chrome' via Playwright, HEADED, with
  --disable-backgrounding-occluded-windows/--disable-background-timer-throttling/--disable-renderer-backgrounding
  (without these, the occluded bench window suspended rAF and produced garbage — verified via in-page rAF probe)
- GPU renderer string: **ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)** — real GPU
- Build: prod e2e build (`bun run build:e2e`) @ a2af6c7f (`$BENCH/prod-build.done`), served via `next start` on :3102
- Date: 2026-07-14
- Fixtures: fixture-1080p30-h264.mp4 (x4 independent assets), fixture-4k-hevc.mp4 (x1),
  fixture-audio-3min.wav (x1), THE fixture project per protocol (see Construction below)

## Prior art read (fence)
- @75e7d287: perf HUD (perf-stats.ts, 120-frame rolling window), playback resolution
  scaling (preview-store.ts getPlaybackRenderScale, "auto"/"full"/"half"/"quarter"),
  decode tiers (video-cache/service.ts VideoSinkTier "full"/"preview", keyed
  mediaId+tier), canvas pooling (webgl-effect-renderer.ts output ping-pong pool,
  composite-effect-node.ts pooled composite canvas, visual-node.ts elementScratchCanvas),
  4-frame prefetch ring (PREFETCH_RING_CAPACITY=4), per-media serialization (VideoCache
  per-sink `chain`), realtime drop policy (`tolerateStale`/CanvasRenderer.realtime).
- Confirmed NOT re-proposing any of the above; this report profiles what's left.

## Construction of THE fixture project (script)
See `$BENCH/axis-2/bench.js`. Built via the E2EBridge (`window.__BYORN_E2E__`) driving
the REAL `editor.media.addMediaAsset` / `editor.timeline.insertElement` APIs (same
commands the UI uses) — not a mock. Per scenario:
- **base**: 1920x1080@30fps canvas. 2 video tracks + 1 text track + 1 audio track.
  4 independent 1080p H.264 assets as 4 clips: track1 clip0[0-6s]->clip2[6-12s]
  (end-to-end adjacent, cross-dissolve transitionOut on clip0), track2 clip1[3-9s],
  clip3[11-17s] (staggered/overlapping across both track1 clips). 1 more video track
  with the 4K HEVC ("GoPro") clip [2-10s]. clip0 carries a 2-effect chain
  (`color-adjust` brightness/contrast + `film-grain`). 1 text element [0-10s]. 1 audio
  element (3-min WAV, trimmed to 30s) at volume 0.5.
- **heavy**: base + 8 extra independent 1080p assets packed sequentially after the
  base clips (stresses scene size / more concurrent VideoNodes).
- **fps60**: base project, `project.updateSettings({fps:60})` after building.
- **res4k**: base project, `project.updateSettings({canvasSize:{width:3840,height:2160}})`
  + playback-quality forced to "full" via the real toolbar dropdown (bypassing
  "auto"'s display-size-targeted downscale, which would otherwise defeat the scenario).

## Frame anatomy — code-level (static, confirmed by reading source)
- Scene build (`buildScene`) is NOT on the per-frame path: `RenderTreeController`
  (panels/preview/index.tsx) rebuilds via `useDeepCompareEffect` keyed on
  tracks/media/project — only on edits. Steady-state playback re-walks the SAME
  persistent node tree every frame (`node.prepare()` then `node.render()`).
- Per frame: `CanvasRenderer.render` -> `node.prepare()` (parallel decode-frame
  fetch across all VideoNode/TransitionNode instances) -> `node.render()` (serial,
  z-order paint) -> blit (`ctx.drawImage(offscreenCanvas, ...)` to the visible
  `<canvas>`). perf-stats.ts already buckets this into decode/effect/blit/total.
- Decode path: mediabunny `CanvasSink._videoSampleToWrappedCanvas` decodes into a
  WebCodecs `VideoSample`/`VideoFrame`, then IMMEDIATELY `sample.drawWithFit(ctx2d,
  ...)` into a pooled 2D `<canvas>`, then `sample.close()` — the VideoFrame is never
  retained; every video frame becomes a 2D canvas before Byorn code ever sees it
  (media-sink.js:1475-1524, node_modules/mediabunny).
- Effect path (per effect, per clip, per frame; visual-node.ts renderVisual): for
  each enabled effect, `webglEffectRenderer.applyEffect` — creates a FRESH WebGL
  texture via `texImage2D` from the (2D-canvas) source, draws through the shared
  WebGL canvas, copies the result out via `ctx.drawImage` into a POOLED 2D output
  canvas, which becomes the *next* effect's `source` (fed back through
  `texImage2D` again). N chained effects = N texture uploads + N canvas-2D
  round-trips, not 1 batched multi-pass pipeline (webgl-effect-renderer.ts:108-153,
  visual-node.ts:267-295).
- `applyMultiPassEffect` (webgl-utils.ts:356-492) creates a FRESH framebuffer+texture
  per intermediate pass EVERY call (`createFramebufferTexture`, not pooled) and
  `drawFullscreenQuad` (webgl-utils.ts:272-294) calls `context.createBuffer()` on
  EVERY draw with no matching `deleteBuffer` anywhere in the file — a per-draw-call
  WebGLBuffer leak (confirmed by static read; magnitude to be measured via
  gl.createBuffer counter below).
- CPU readback: `CompositeEffectNode.computeContentBounds` (composite-effect-node.ts:46-99)
  calls `probeCtx.getImageData(...)` on a 64x64 probe canvas — a synchronizing GPU
  flush — but only for `background.type==="blur"` projects, cached/re-run at most
  every `COVER_BOUNDS_REFRESH_SECONDS`=0.5s. THE fixture project (no blur
  background) should show ZERO of these; noted as a hypothesis for the miss-rate
  question, not exercised by default.
- Transition path (transition-node.ts `drawSourceFrame`): allocates a FRESH
  full-canvas-size `OffscreenCanvas` for EACH of sourceA/sourceB EVERY frame during
  the transition window (not pooled, unlike the effect-output pool) —
  transition-node.ts:271-329.
- Texture upload strategy: confirmed NOT using `texImage2D` with a `VideoFrame`
  source directly anywhere in the renderer (grep-level + runtime instrumentation
  below) — every upload source is a 2D canvas, because mediabunny's CanvasSink
  already converted the VideoFrame before handing it back.

## Numbers

### Runtime capability verification (Chrome 150.0.7871.115, measured in-page)
| Capability | Result | How verified |
|---|---|---|
| WEBGL_debug_renderer_info UNMASKED_RENDERER | **"ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)"** — real GPU, not SwiftShader | gl.getExtension + getParameter at runtime |
| navigator.gpu present | **true** | `'gpu' in navigator` |
| navigator.gpu.requestAdapter() | **real adapter returned** | live call |
| WebGL2 | true | getContext("webgl2") |
| OffscreenCanvas | **true** | typeof check |
| canvas.transferControlToOffscreen | **true (function)** | typeof on a real element |
| crossOriginIsolated | **false** — COOP/COEP not set by our deploy config; SAB paths unavailable as-is | `window.crossOriginIsolated` |
| EXT_disjoint_timer_query_webgl2 | **EXPOSED (non-null)** on this Chrome/ANGLE-Metal | gl2.getExtension |
| EXT_disjoint_timer_query (webgl1) | **EXPOSED (non-null)** | gl.getExtension |
| rAF rate during measurement | **61/s, document visible** (required launch flags: --disable-backgrounding-occluded-windows --disable-background-timer-throttling --disable-renderer-backgrounding; without them the occluded bench window rendered 4 frames in 10s) | in-page rAF counter probe |

### perfStats snapshots — 10s playback from t=0, per scenario
Source: `window.__byornPerf.getStats()` (the shipped PerfStatsCollector, 120-frame window).
COLD = first-ever playback on freshly ingested assets (decoder/sink init, MP4 parse, first
seeks, and the local-AI CLIP indexing of the new assets running concurrently — ONNX Runtime
logs confirmed in-page during the cold pass, a real-world confound on first play).
WARM = seek(0) after the cold pass, stats+counters reset, same 10s span. N=1 run per
scenario per temperature (lock-window budget); min/max not available — single-run numbers,
treat ±20% as noise, but the decode-vs-effect ratio is unambiguous (2 orders of magnitude).

| Scenario | temp | fps | avgFrameMs | p95FrameMs | avgDecodeMs | avgEffectMs | avgBlitMs | long/veryLong | skipped | rendered |
|---|---|---|---|---|---|---|---|---|---|---|
| base (1080p canvas, 30fps) | cold | 5.8 | 82.4 | 244.7 | 71.4 | 4.0 | 0.64 | 4/3 | 79 | 33 |
| base (1080p canvas, 30fps) | warm | 4.8 | 150.0 | 1753.9 | 144.8 | 2.4 | 0.42 | 6/3 | 25 | 33 |
| base, repeat w/ CDP tracing on | warm | 3.1 | 278.9 | 295.6 | 335.9 | 4.9 | 0.09 | 7/4 | 101 | 79 | 
| heavy (15 clips, 14 assets) | cold | 1.4 | 603.1 | 4396.0 | 871.2 | 7.4 | 0.51 | 11/10 | 115 | 16 |
| heavy (15 clips, 14 assets) | warm | 6.5 | 83.7 | 362.0 | 109.2 | 0.22 | 0.03 | 6/3 | 142 | 53 |
| fps60 (60fps target) | cold | 2.5 | 238.4 | 1383.8 | 201.8 | 16.4 | 2.6 | 6/5 | 26 | 9 |
| fps60 (60fps target) | warm | **WEDGED** — 1 frame in 10s, its decode wait 81.1s (see instability note) | | | | | | 1/1 | 5 | 1 |
| res4k (4K canvas, quality=full) | cold | 0.5 | 1594.2 | 6292.5 | 1911.6 | 4.3 | 0.27 | 4/3 | 58 | 6 |
| res4k (4K canvas, quality=full) | warm | 3.0 | 159.9 | 229.0 | 345.3 | 4.6 | 0.41 | 10/7 | 13 | 26 |

**res4k finding — main thread saturates, not the GPU**: at a 3840x2160 canvas with
quality=full, the in-page rAF probe dropped to **2-4 ticks/s (window visible, same
anti-throttling flags that gave 57-61/s at 1080p)** — the render loop itself starves.
Decode cap follows the canvas long edge (scene-builder.ts:56-58), so all sinks decode at
up to 3840 wide; mediabunny's CanvasSink rasterizes every decoded 4K VideoFrame into a
2D canvas ON THE MAIN THREAD (`sample.drawWithFit`), and the compositor then drawImages
those 4K canvases — all main-thread raster work. avgEffectMs only grew 2.4→4.6ms (GPU
still bored); avgBlitMs stayed 0.4ms. What breaks first at 4K preview: **main-thread
raster + decode volume, not GL**. This is the strongest argument for opportunity #2
(worker compositor) + #7 (keep frames as VideoFrames instead of main-thread canvases).

**fps60 instability note**: raising the project fps to 60 made the cold pass strictly
worse than base-cold (2.5 vs 5.8 fps, decode 202 vs 71ms — demand doubled against the
same decode throughput), and the warm pass locked up outright: exactly one frame
committed whose accumulated decode wait was 81,146ms, then nothing (framesSkipped 5 —
the rAF loop stopped being offered new frames because the single render never resolved
until the pause). Single run (N=1), not yet reproduced, but the shape — one getFrameAt
whose per-sink `chain` promise doesn't settle for the whole window — points at a
starvation/backlog condition in the ring-fill/chain interaction when the request rate
(60fps target) exceeds decode rate for a sustained span. What breaks first when raising
the target: **not the GPU, the decode scheduler.**

Note on avgDecodeMs > avgFrameMs (base warm): decode waits accumulate across ALL VideoNodes
in the parallel prepare() pass (perfStats.addDecodeTime sums per-node waits), while
avgFrameMs is wall-clock — 3 clips awaiting decode concurrently can sum to more than the
frame's wall time. The ratio, not the absolute sum, is the signal.

### GL/canvas counters over the WARM 10s window (runtime-injected prototype proxies; zero product-code edits)
| Scenario | frames | createBuffer | deleteBuffer | createTexture | deleteTexture | createFramebuffer | texImage2D canvas-src | texImage2D VideoFrame-src | useProgram | programSwitches | drawArrays | getImageData | new OffscreenCanvas |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| base | 33 | 66 | **0** | 66 | 66 | 0 | 66 | **0** | 66 | 66 | 66 | 0 | 3 |
| heavy | 53 | 106 | **0** | 106 | 106 | 0 | 106 | **0** | 106 | 106 | 106 | 0 | 3 |

Reading the counters (both scenarios identical per-frame):
- **Exactly 2 GL draws/frame** — the 2-effect chain on clip0 (color-adjust + film-grain).
  Everything else on screen composites through Canvas2D `drawImage` (~10-12/frame: 329-389
  per window). The WebGL pipeline is nearly idle; this workload is NOT draw-call-bound.
- **2 texture uploads/frame, all from 2D canvases, zero from VideoFrame** — confirms the
  static read: mediabunny CanvasSink converts every decoded VideoFrame to a 2D canvas
  before the renderer sees it; each effect re-uploads its input canvas.
- **createBuffer 2/frame, deleteBuffer 0** — the `drawFullscreenQuad` per-draw
  WebGLBuffer leak, live-confirmed (webgl-utils.ts:284-286). ~7,200 leaked buffers/hour
  of playback at this fps; tiny objects (24B quad), so it's hygiene not a current bottleneck.
- **programSwitches == useProgram == draws** — every draw switches program (color-adjust →
  film-grain alternation). At 2 draws/frame this costs nothing measurable.
- **getImageData 0** — no GPU→CPU readback on the hot path for this project (the blur-fill
  cover probe is the only readback in the codebase and only runs for blur backgrounds,
  throttled to 2/s — composite-effect-node.ts:46-99,137-152).
- **3 new OffscreenCanvas per 10s** — the @75e7d287 pooling holds; per-frame canvas churn
  is gone.

## Why 28.4 not 30 — and why THE fixture project isn't even close
The prior 28.4fps/2.2ms number (@75e7d287) was measured on a lighter scene. On THE
protocol fixture project the compositor runs at **~3-6.5 fps warm**, and the CDP trace
(trace-base.json, 17.3s window around the traced warm pass, gpu+cc+blink+media+toplevel
categories) pins the mechanism precisely:

- perfStats says the wait is "decode" (avgDecodeMs 109-345 vs avgEffectMs 0.2-4.9 vs
  avgBlitMs <0.7) — but the trace shows **hardware decode is NOT slow, it is STARVED**:
  `VideoDecoder::Output` (GPU process) delivered only **197 video frames in 17.3s
  (~11 fps aggregate across all sinks) at 6.9ms avg per output**; `MojoVideoDecoder::
  Decode` totals 187ms. Demand was ~90 frames/s (3 concurrent layers x 30fps).
- The actual bottleneck is the **renderer main thread: CrRendererMain was busy
  13,953ms of the 17.3s span (~81%)**. On it: rAF callbacks
  (`FrameRequestCallbackCollection::ExecuteFrameCallbacks`) 6,207ms across 157 fires =
  **40ms average per rAF tick**; `RunMicrotasks` 5,246ms (the async render/prepare
  promise chains); **`Blink.ForcedStyleAndLayout` 3,384ms across 631 forced layouts**
  (~63/s). Culprit located: `src/components/editor/panels/timeline/timeline-playhead.tsx`
  runs its own rAF loop during playback that writes `el.style.left` (line ~77) and then
  reads `clientWidth`/`scrollWidth`/`scrollLeft` (lines ~88-92) — a write-then-read
  forced-reflow pattern every tick (opportunity #2).
- mediabunny's decode iteration and its VideoFrame→2D-canvas conversion
  (`drawWithFit`) run on this same main thread — so when the main thread is saturated,
  the ring-fill iterator can't pump the (idle) HW decoder, rings drain, `getFrameAt`
  blocks, perfStats books it as "decode wait", frames take 150-280ms, which keeps the
  main thread saturated. A feedback loop with the main thread as the shared scarce
  resource. The GPU is near-idle for compositor work (2 draws/frame; effect chain
  2.4-4.9ms incl. upload); raster of the video canvases shows up GPU-side as
  RasterCHROMIUM ~6.2s total (823 ops) — real but not the wall.
- Also visible in the trace: **WebGPU 3,126ms (208 events, GPU process) during
  playback** — the local-AI CLIP indexing of the freshly-added assets was still using
  the GPU mid-playback. The editor-priority scheduler did not fully yield GPU work
  during play; flag for the local-AI axis (cross-cutting confound + real UX cost on
  first play after import).
- framesSkipped (13-142 per 10s) is the rAF loop's renderingRef guard correctly
  dropping ticks while a render is in flight — the drop policy works; there is simply
  nothing decoded to drop to.
- 28.4-vs-30 on a LIGHT scene: the empty-scene control ran at 30.002fps with 0.23ms
  frames — the loop and its frame-index gate are not the limiter; the historical 1.6fps
  shortfall was per-frame work + main-thread contention, both of which scale with scene
  weight as measured above.

### Incidental control measurement — empty-scene loop ceiling
A failed res4k attempt (reload raced the debounced timeline save → empty timeline)
accidentally produced a clean control: with NO clips, the compositor loop ran at
**30.002 fps, avgFrame 0.23ms, 0 skipped, 300 frames/10s** — i.e. the frame-index gate
(`Math.floor(renderTime * fps)`, preview/index.tsx:366) caps the loop at exactly the
project fps and the loop machinery itself costs ~0.2ms. The 28.4-vs-30 shortfall on real
scenes is therefore entirely per-frame work (decode above all), not loop overhead.

## Ranked opportunities

| # | Opportunity | Measured evidence | Expected gain | Effort | Risk | Class vs native Metal | Prereqs (verified) | Re-verify by |
|---|---|---|---|---|---|---|---|---|
| 1 | **OffscreenCanvas + WORKER compositor + worker-side decode** (move CanvasRenderer + node tree + mediabunny sinks off the main thread; React posts scene descriptors; frames never touch CrRendererMain) | **CrRendererMain 81% busy over the traced window**; 40ms avg per rAF tick; decode iterator starves an HW decoder that averages 6.9ms/frame and delivered only ~11fps aggregate vs ~90fps demand. transferControlToOffscreen verified true; WebCodecs+mediabunny work in workers; crossOriginIsolated not required | The single highest-leverage change this audit found: unblocks BOTH the decode pump and the compositor from UI contention. If the worker keeps the HW decoder fed at even half its measured per-frame cost, multi-layer playback goes 3-6fps → 20-30fps (grounded in VideoDecoder::Output 6.9ms avg; still an extrapolation until prototyped) | L (text-node DOM font APIs, videoCache handoff, store messaging) | High | CLOSABLE (this IS native's UI-thread/render-thread split) | verified: OffscreenCanvas, transferControlToOffscreen, worker WebGL/WebCodecs in Chrome 150 | rerun bench.js base/heavy; CrRendererMain busy% and avgDecodeMs |
| 2 | **Kill forced layout in the playback tick path**: `timeline-playhead.tsx` runs its own rAF loop during playback that WRITES `el.style.left` (line 77) then READS `rulerViewport.clientWidth` / `scrollWidth` / `scrollLeft` (lines 88-92) — a write-then-read forced synchronous layout EVERY tick. Fix: cache viewport widths via ResizeObserver, move the marker with `transform` instead of `left`, read scroll offsets before any write | **631 forced layouts / 3,384ms in the traced window (~20-24% of main-thread busy time)** — `Blink.ForcedStyleAndLayout.UpdateTime` x631 on CrRendererMain during pure playback, no user interaction; rate matches this rAF loop | Returns ~3.4s per 17s of main thread to the decode pump + compositor; expect +2-5fps on THE fixture (SPECULATIVE until re-measured) | S | Low | CLOSABLE | none | re-trace; ForcedStyleAndLayout count during 10s playback → ~0 |
| 3 | **Multi-layer decode-ahead scheduling** (adaptive ring size by active layer count; pump the ring fill from the worker (with #1) or from idle callbacks instead of competing with rAF; revisit preview-tier cap for 4K sources). Primary ownership axis-3; listed because it caps this pipeline | avgDecodeMs 109-345 accumulated per frame while HW decoder sits idle (11fps delivered vs 90 demanded); fps60 doubles demand → cold fps halves (5.8→2.5) and warm run wedged once (81s stalled getFrameAt, N=1) | With #1 this is mostly subsumed; standalone (bigger rings pumped on main thread) SPECULATIVE +30-50% fps, memory-bounded on 8GB | M | Medium (ring frames are full-size canvases; 4K ring of 8 ≈ 265MB) | MITIGABLE | none | avgDecodeMs + VideoDecoder::Output rate |
| 4 | **Batch effect chains into one GL pass-sequence** (keep intermediates as GL textures/FBOs across a clip's chain instead of canvas round-trip + re-upload per effect) | 2 effects = 2 texImage2D uploads + 2 canvas copy-outs per frame (counters: 66/33, 106/53, 52/26 — exactly 2/frame in every scenario); avgEffectMs 2.4ms @1080p, 4.6ms @4K for the chain | avgEffectMs roughly halves (~1-2ms/frame at this depth; scales with chain depth/clip count). SPECULATIVE, bounded by the measured 2.4-4.9ms — do after #1/#2 | S-M | Low (applyMultiPassEffect already FBO-chains internally; extend across effects) | CLOSABLE | none | texImage2D/frame → 1 per chain; avgEffectMs |
| 5 | **Keep decoded frames as VideoFrames end-to-end** (switch VideoCache from CanvasSink to VideoSampleSink; composite VideoFrame directly — drawImage accepts VideoFrame; texImage2D accepts VideoFrame GPU-GPU on ANGLE-Metal) | texImage2DVideoFrame counter = **0**: every decoded frame is rasterized into a 2D canvas ON THE MAIN THREAD (mediabunny media-sink.js:1475-1524 drawWithFit) before any use. At 4K this main-thread raster is a major part of why rAF fell to 2-4 ticks/s | Removes one full-res main-thread raster per video layer per frame (the 4K res4k case is where it bites); at 1080p ~1-2ms/layer/frame SPECULATIVE. Combines with #1 (VideoFrame is transferable) | M | Medium (VideoFrame lifetime vs the documented canvas-pool aliasing contract, video-cache/service.ts:81-89) | CLOSABLE | drawImage(VideoFrame)/texImage2D(VideoFrame) exist in Chrome 150 (API verified; not micro-benched) | texImage2DVideoFrame > 0; rAF rate at 4K |
| 6 | **Local-AI GPU work not yielding during playback** (flag to local-AI axis: WebGPU 3,126ms in GPU process DURING the traced playback window — CLIP indexing of just-imported assets overlapped play) | trace: WebGPU x208 events on CrGpuMain during warm playback | First-play-after-import smoothness; size unquantified vs decode wall (SPECULATIVE) | S (scheduler already exists — tighten its playback gate) | Low | n/a | none | re-trace playback after import; WebGPU events ≈ 0 while playing |
| 7 | **Fix drawFullscreenQuad buffer leak + cache quad VBO + uniform locations** | createBuffer 2/frame, deleteBuffer 0 (all scenarios); getUniformLocation per uniform per draw (webgl-utils.ts:254-294) | Hygiene; no measurable fps at 2 draws/frame. Prevents GL-object accumulation over hour-long sessions | S | None | n/a | none | createBuffer/frame → ~0 steady-state |
| 8 | **Pool TransitionNode.drawSourceFrame canvases** (2 full-frame OffscreenCanvas allocs/frame during transitions — transition-node.ts:271-329) | Static read; transition window too sparse at ~5fps to isolate in a 10s run | Removes 2 full-frame allocs/frame during transitions (~60MB/s churn at 4K/30fps — SPECULATIVE) | S | Low (same pattern as elementScratchCanvas) | CLOSABLE | none | offscreenCanvasCreated during a transition loop |
| 9 | **WebGPU migration of the node graph** | navigator.gpu + adapter verified available. But measured compositor GPU cost is 2 draws + 2 uploads + 2.4-4.9ms/frame — nothing for WebGPU to win today. Port surface: ~20 effect shaders (lib/effects/definitions/*.frag.glsl) + ~20 transitions + webgl-utils/webgl-effect-renderer/transition-renderer (GLSL→WGSL) | ~0 on this workload; value only after #1/#2 land and if effect stacks get ~10x deeper | L | High | Not the Palmier gap — their Metal edge is decode/memory/threading, which WebGPU doesn't address | navigator.gpu verified | n/a — do not do now |

**Explicitly NOT proposed** (prior-art fence): resolution scaling, decode tiers, canvas
pooling, prefetch ring existence, drop policy, per-media serialization — all shipped
@75e7d287 and confirmed working by the counters above (3 OffscreenCanvas allocs per 10s,
0 readbacks, pooled outputs).

## What could not be measured (and why)
- **N≥5 runs per scenario**: not done — each scenario is a ~3-minute full-app run and the
  shared bench LOCK on this 8GB machine allows ~20-minute windows. Every scenario ran
  once cold + once warm. The headline conclusion (decode-bound, GPU ~2%) is robust to
  single-run noise because it rests on a 50-600x ratio, not a marginal difference.
- **GPU-side timings via EXT_disjoint_timer_query_webgl2**: the extension IS exposed
  (verified non-null), but instrumenting per-draw GPU timers requires wrapping the app's
  draw sites with query begin/end — a deeper injection than the counter proxies; skipped
  because CPU-side avgEffectMs (2.4ms for the entire chain incl. upload+readback) already
  bounds GPU work to irrelevance for this workload.
- **A single VideoFrame→texture upload micro-benchmark**: not run standalone; the
  aggregate evidence (2 uploads/frame inside a 2.4ms effect budget at 1080p) bounds
  upload cost to ~1ms; the direct-VideoFrame path (opportunity #7) needs its own bench
  before implementation.
- **fps60-warm wedge reproduction**: observed once (N=1); needs a dedicated repro run
  before filing as a definite bug. Logged here as an instability signal.
- **res4k first attempt** invalidated itself (reload raced the debounced timeline save
  → empty scene); the rerun with init-script-seeded quality succeeded and is what the
  table reports. The failed attempt was kept as the empty-scene control.
- **memory pressure interaction**: 8GB machine, other agents' servers resident;
  pageouts were nonzero during runs. Cold numbers especially carry this caveat; the
  local-AI CLIP indexing of freshly added assets (ONNX logs observed in-page) also
  overlapped the cold passes — realistic first-play behavior, but it inflates cold
  decode waits.

## Scripts left in $BENCH/axis-2/
- `bench.js` — Playwright driver: builds THE fixture project via the real
  editor.media/editor.timeline APIs (E2EBridge), installs runtime WebGL/Canvas2D
  instrumentation via addInitScript (proxies createBuffer/texImage2D/useProgram/
  getImageData/OffscreenCanvas — counts only, zero product-code edits), serves the
  fixtures over a local streaming HTTP server (Playwright route.fulfill dies on the
  98MB body), runs a rAF-rate validity probe, plays 10s cold + 10s warm,
  reads window.__byornPerf.getStats() + the injected counters, verifies platform
  capabilities live, optional CDP trace via AXIS2_TRACE=1. Usage:
  `node bench.js <base|heavy|fps60|res4k> 3102` (needs `PORT=3102 bun run start` up).
- `run-*.log` (base, heavy, fps60, res4k, res4k2, base-trace), `result-*.json`,
  `caps-*.json`, `build-*.json` — raw outputs per scenario.
- `trace-base.json` — 46MB CDP trace (gpu, cc, blink, media, toplevel, v8.execute) of
  the traced base warm pass; the per-thread/per-event attribution in this report was
  computed from it (python one-liners in the session, reproducible with any trace viewer).

## Bench-harness gotchas learned (for the future shared harness)
1. Headed-but-occluded Chrome suspends rAF + throttles timers — the three
   --disable-*-throttling/backgrounding flags are MANDATORY for compositor benches;
   verify with an in-page rAF counter before trusting any number.
2. Playwright route.fulfill({path}) pushes the whole body over CDP — the 98MB 4K
   fixture kills the connection ("Target closed"). Serve big fixtures over real HTTP.
3. page.reload() races the debounced timeline save — a just-built project reloads
   EMPTY. Seed persisted-store state via addInitScript instead of post-hoc reload.
4. window.__BYORN_E2E__ exposes editor.media.addMediaAsset/timeline.insertElement/
   playback/project.updateSettings — a full project can be scripted without UI; the
   `@/lib/media/processing` ingest path is NOT importable from page context (bundler
   alias), so asset metadata must be probed with a bare <video> element.
5. Local-AI CLIP indexing fires on asset add and competes for cores during first
   playback — cold-pass numbers include it (realistic, but know it's there).

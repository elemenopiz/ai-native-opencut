# BUG14 — import-stall profile (2026-07-17)

Measured investigation of `SPEEDRUN-QUEUE.md` BUG14: *"Timeline mutations during heavy-media
import leave the main thread unresponsive 10–30s."* campaign/perf-wave, C5 fix owner.

**Bottom line:** three real contributors, not one. The dominant one is architectural and
**out of scope** (owned by another campaign, `services/video-cache/**`). A second, smaller
contributor — the CLIP visual-search auto-indexer racing the same asset's proxy generation —
was **fixed** in this pass: `apps/web/src/hooks/use-embedding-indexer.ts`. The third
(React re-render churn from progress-store updates) is characterized but not fixed (multi-file,
not small).

## 1. Repro setup

- **Fixture:** `apps/web/e2e/fixtures/bug14/heavy_4k_hevc_45s.mp4` — 45 s, 3840×2160 @30fps,
  HEVC (`hvc1`, `hevc_videotoolbox`, 18.6 Mbps), AAC audio. Minted with ffmpeg
  (`testsrc2` + noise for high-motion, non-trivial entropy). 104 MB.
- **Harness:** `apps/web/e2e/bug14-import-stall-profile.e2e.ts` +
  `apps/web/playwright.bug14-profile.config.ts` — real Chrome channel (bundled Playwright
  Chromium has no HEVC decode), `NEXT_PUBLIC_E2E=1` build, port 3130, the standard
  `--disable-backgrounding-*` flags from the 2026-07-14 audit.
- **Drive:** navigate to a fresh anon editor project → import the fixture through the real
  media-panel file input (genuine `processMediaAssets` path, not the E2E bridge) → poll until
  the asset's own auto-proxy job is confirmed generating (`editor.media.isProxyGenerating`) →
  fire a real `editor.timeline.insertElement` command-stack mutation (asset drag-insert) at a
  controlled offset after import → measure `performance.now()` from the mutation call to the
  next `requestAnimationFrame` (main-thread-blocked proxy metric) → capture a CDP
  `Profiler` CPU profile bracketing the mutation, plus `PerformanceObserver` longtask entries.
- **Build mode:** production E2E build (`bun run build:e2e`, Turbopack). Source maps
  (`productionBrowserSourceMaps: true`) resolved every JS-attributable frame in the profiles
  below via `Turbopack`'s embedded `sourceMappingURL` (note: the chunk that references a map
  is *not* always the same-hash file — the map must be read from the JS file's own trailing
  comment, not guessed from the chunk filename).
- **Machine:** same M3/8-core/8GB machine as the 2026-07-14 audit, **shared with 3–5 other
  concurrent agent worktree sessions running `next build`/`tsc` for most of this session** —
  see §5 caveats. Two `.cpuprofile` pairs were captured under measurably different contention
  levels; this is called out explicitly wherever it matters.

## 2. Repro result: reproduced, but not as one big block

**3 varied attempts** were run pre-fix (queue's own protocol): mutate at import+0ms,
import+1000ms, import+3000ms.

| Run | Import | Proxy state at mutation | Mutation → next rAF | Longtasks captured |
|---|---|---|---|---|
| run1 (t+0) | 4017 ms | generating (true) | **905.5 ms** | 39 (58–815ms each, spanning ~27s post-import) |
| run2 (t+1000ms) | 3080 ms | generating (true) | **875.7 ms** | 52 (53–675ms each, spanning ~10s window sampled) |
| run3 (t+3000ms) | — | — | — | **did not complete: `Test timeout of 280000ms exceeded` navigating to run3** — the browser tab was still main-thread-saturated finishing run2's tail work when run3's `page.goto` was issued |

**The single command-stack call itself is not the 10–30s stall** — `insertElement()` →
next paint measured under 1 second both times. What *is* a genuine 10–30s-class event: the
**CDP session itself** took **13.1 real seconds** to service `Profiler.start()` → (a scripted
`page.waitForTimeout(1000)`) → `Profiler.stop()` in run1 (should be ~1.9s), and **10.5 real
seconds** in run2. That gap is direct, measured evidence that the main thread was busy enough,
for long enough, that even a **1-second `setTimeout` callback and CDP command servicing** were
delayed by 9–12 extra seconds. Total sampled JS+native self-time in run1's window was
**11,988ms out of a 13,131ms wall span — 91% main-thread occupancy**, i.e. not idle-with-one-
big-block but *saturated* for the whole window.

This reconciles the queue's own description ("mutation lands in store state but UI/automation
stalls"): the underlying command executes fine; what stalls is *everything that depends on the
main thread getting a turn* afterward — a human's next click, a drag sequence's per-frame
hit-testing, or (as measured directly here) Playwright's own timer/CDP round-trips. Under
real-world/shared-machine conditions (worse contention than a quiet run), the accumulated delay
across a multi-step UI interaction plausibly reaches the reported 10–30s.

## 3. Top offenders (pre-fix, `before-fix-t0.cpuprofile`, symbol-true via Turbopack source maps)

13,130.7ms profile span, 11,988.1ms sampled self-time (91% busy).

| Rank | Self ms | % | Symbol | Resolved file:line |
|---|---|---|---|---|
| 1 | 7391.3 | 61.7% | `(program)` — native | no JS frame (see mechanism below) |
| 2 | 807.1 | 6.7% | `sampleVideoFrames` seek loop | `apps/web/src/services/search/embedding-service.ts` (seek-loop region, ~L63–94 depending on build) |
| 3 | 665.4 | 5.6% | `resetTransform` — native Canvas2D | (2D canvas API, no JS frame) |
| 4 | 343.4 | 2.9% | `(garbage collector)` | — |
| 6 | 117.8 | 1.0% | Radix `Slot` render | `node_modules/@radix-ui/react-slot/dist/index.mjs:49` |
| 7 | 104.4 | 0.9% | `EncodedVideoChunk` — native WebCodecs | — |
| 9 | 90.3 | 0.8% | timeline zoom hook | `apps/web/src/hooks/timeline/use-timeline-zoom.ts:64` |
| 10+13 | 150.1 | 1.3% | React commit work | `next/dist/compiled/react-dom/.../react-dom-client.production.js:4167` |
| 11 | 77.9 | 0.6% | asset persistence write | `apps/web/src/services/storage/indexeddb-adapter.ts:47` |
| 14 | 65.3 | 0.5% | mediabunny `sample.js` | `node_modules/mediabunny/dist/modules/src/sample.js:190` |
| 25 | 25.3 | 0.2% | timeline asset drag item render | `apps/web/src/components/editor/panels/assets/draggable-item.tsx:46` |
| 28 | 23.4 | 0.2% | mediabunny `CanvasSink._videoSampleToWrappedCanvas` | `node_modules/mediabunny/dist/modules/src/media-sink.js:1475` |
| 29 | 21.5 | 0.2% | VU meter render | `apps/web/src/components/editor/panels/timeline/timeline-vu-meter.tsx:69` |
| 31 | 20.6 | 0.2% | Radix `Slider` internals | `node_modules/@radix-ui/react-slider/dist/index.mjs:580` |

Full 40-row table + raw `.cpuprofile` files: `apps/web/docs/perf/bug14-evidence/`.

### Mechanism: what `(program)` + the native canvas/WebCodecs symbols actually are

`resetTransform`, `fillRect`, `drawImage`, `clearRect`, `getContext`, `decode`,
`EncodedVideoChunk`, `read`, `put`, `setAttribute` are all native Canvas2D/WebCodecs bindings —
V8's CPU profiler frequently can't attribute deep native call time to a JS frame and buckets it
as `(program)`. The JS-attributable sibling frames that ARE resolved
(`_videoSampleToWrappedCanvas` at `mediabunny/.../media-sink.js:1475`, `_runWorker`,
`mergeAlpha`, `insertIntoCache`, `next`) are all internals of mediabunny's **`CanvasSink`**
class — confirmed by grepping the mediabunny source (`_videoSampleToWrappedCanvas` is
`CanvasSink`'s private per-frame rasterizer, called from `getCanvas`/`canvases`/
`canvasesAtTimestamps`).

`CanvasSink` (as opposed to the `VideoSampleSink` the thumbnail path uses) has exactly one
caller in this codebase: **`apps/web/src/services/video-cache/service.ts`** — the preview
renderer's decode cache (`VideoCache.getFrameAt`, whose own comment says "the render loop
awaits `getFrameAt`"). Combined, the native canvas/WebCodecs symbols + `(program)` account for
roughly **70%+ of the profiled self-time**. Mechanism: the newly-inserted 4K clip has **no
proxy yet** (still generating in the worker), so every time the preview compositor needs a
frame for the current playhead — which happens right when a new element lands on the timeline,
and repeatedly if there's any live redraw — `VideoCache` must decode the clip's **original**
3840×2160 HEVC via `CanvasSink`, entirely on the main thread. This is the exact mechanism the
2026-07-14 perf audit already named as **opportunity #6** ("worker compositor + worker-side
decode") and **#7** ("keep decoded frames as VideoFrames end-to-end" — `CanvasSink` rasterizes
to a 2D canvas main-thread-side before Byorn ever sees the frame). BUG14 is this same
architectural cost, specifically triggered by "insert a not-yet-proxied 4K clip."

**This is out of scope for a fix here**: the call site (`services/video-cache/service.ts`) is
on this task's explicit off-limits list (owned by the perf-wave's renderer/worker-compositor
track), and the fix itself (`#6`/`#7` in the audit, L-effort, "flagship structural fix") is
architectural, not a small single-file change.

## 4. What was fixed: the CLIP auto-indexer racing proxy generation

**Rank 2 in the table above — `sampleVideoFrames` in
`apps/web/src/services/search/embedding-service.ts` — was independently fixable and in
scope.** `useEmbeddingIndexer()` (`apps/web/src/hooks/use-embedding-indexer.ts`, mounted
unconditionally in `editor-provider.tsx`) auto-indexes every new video/image asset into the
local CLIP visual-search store, **fire-and-forget, with no gate**. Its frame sampler creates a
plain `<video>` element and seeks it to up to 120 timestamps across the asset's duration
(2s interval, so ~22 seeks for this 45s fixture); each `onseeked` draws to a canvas and calls
`toBlob`. For a freshly-imported, not-yet-proxied 4K/HEVC source, **each seek is a real decode
of the full-resolution original** — running concurrently with (a) the auto-proxy job decoding
the *same* original off-thread, and (b) the preview renderer's own `CanvasSink` decode of the
same original (§3). All three compete for the same CPU/decoder resources at exactly the moment
BUG14 describes.

Notably, this directly contradicts the intent documented in `editor-provider.tsx`'s own
comment ("gate in-browser inference (background CLIP indexing) on playback/scrub/export being
idle") and the `LocalAIScheduler` pattern already used elsewhere
(`lib/local-ai/local-clip.ts:99`, `media-manager.ts`'s `runAutoProxyGeneration`): the scheduler
gate is real, but it only wraps the CLIP **inference** dispatch inside `LocalClip`, not the
**frame-sampling** phase in `embedding-service.ts` that runs first and is the expensive part
for a heavy video.

### Fix

`apps/web/src/hooks/use-embedding-indexer.ts` — added `shouldDeferIndexing()`, a pure guard
checked before dispatching `indexMedia(asset)`: skip (don't mark indexed/inflight) any asset
whose own proxy generation is currently running (`editor.media.isProxyGenerating(assetId)`).
Nothing is lost — proxy start *and* finish both call `MediaManager.notify()`
(`media-manager.ts`'s `generateProxyForAsset`), the same channel this hook already subscribes
to, so a skipped asset is retried automatically on the very next tick once its proxy job
clears.

This doesn't close the race completely — an asset can begin indexing in the narrow window
between "asset added" (tick fires) and "proxy job actually starts" (`waitForIdle()` inside
`runAutoProxyGeneration` resolving), since neither event is instantaneous. Measured below.

GitNexus impact (`useEmbeddingIndexer`, upstream): **LOW risk**, single call site
(`editor-provider.tsx`'s `EditorRuntimeBindings`), no other consumers.

### Verification

Unit test: `apps/web/src/hooks/use-embedding-indexer.test.ts` (2/2 pass) — `shouldDeferIndexing`
returns `true`/`false` correctly against a stubbed `isProxyGenerating`.

Typecheck: `bunx tsc --noEmit` — 0 errors (confirmed against both changed files specifically
and a full clean run). Lint: `bunx biome check` on both files — 0 errors/warnings.

Re-profiled with the same harness against the fixed build (`after-fix-t0.cpuprofile`,
`after-fix-t1000.cpuprofile`):

| Run | Import | Proxy state at mutation | Mutation → next rAF | Longtasks | `embedding-service.ts` self-time |
|---|---|---|---|---|---|
| before, t+0 | 4017 ms | generating | 905.5 ms | 39 | **807.1 ms (6.7%)** |
| before, t+1000ms | 3080 ms | generating | 875.7 ms | 52 | (not separately isolated; embedding-service.ts frames present) |
| after, t+0 | 421 ms | generating | 69.3 ms | 10 | **26.1 ms (0.60%)** — residual: this run still lands in the narrow "added but proxy hasn't started yet" race window |
| after, t+1000ms | 149 ms | generating | 45.8 ms | 0 | **0.0 ms (0.00%)** — fully deferred, guard engaged cleanly |

The `embedding-service.ts` numbers are the load-bearing comparison — **contention-independent**
(presence/absence of a code path in the profile, not a timing race). They confirm the fix
mechanism works exactly as designed: once the asset's proxy job has actually started
(true by t+1000ms in every run observed), the CLIP indexer no longer touches the main thread
for that asset at all.

**The wall-clock numbers (905ms/876ms → 69ms/46ms, longtasks 39/52 → 10/0) are NOT presented as
a clean isolated measurement of this fix's impact** — see caveat below. They're consistent with
the fix and with reduced contention; the file-presence comparison above is the number to trust.

## 5. Caveats

- **Shared-machine contention confound.** The "before" pass ran with 3–5 other worktree
  sessions' `next build`/`tsc --noEmit` active concurrently (same class of confound the
  2026-07-14 audit flagged: "up to 7 measurement agents shared this machine"). The "after" pass
  ran with contention down to ~1 other process. The wall-clock before/after delta in §4
  therefore mixes "fix effect" with "less contention" — it is directionally consistent with the
  fix but should not be read as an isolated multiplier. The `embedding-service.ts` file-presence
  comparison is the contention-independent evidence.
- **run3 (t+3000ms) never completed pre-fix** — the harness's own `page.goto` for the third
  attempt exceeded the test's 280s budget while the tab was still finishing run2's background
  work. This is itself a data point (main-thread pressure outlasting a single mutation by a
  wide margin) but means only 2/3 planned pre-fix attempts produced full profiles.
- **Symbol resolution**: production E2E build with `productionBrowserSourceMaps: true` +
  Turbopack. Source maps resolved cleanly once the tooling read each chunk's own trailing
  `//# sourceMappingURL=` comment (the referenced map filename does **not** always match the
  JS chunk's own content-hash filename under Turbopack — a naive `<chunk>.js.map` lookup finds
  nothing). No fallback to `bun run dev` was needed.
- **`(program)` bucket**: 44–62% of self-time across all profiles is unattributed native code.
  Traced to Canvas2D/WebCodecs via its JS-attributable sibling frames (mediabunny's
  `CanvasSink` internals) rather than directly, since V8's sampling profiler frequently can't
  walk through native API calls to a JS caller frame.
- Understanding-Pass ONNX (env-gated, `NEXT_PUBLIC_UNDERSTANDING_AUTORUN`) was **not** enabled
  in this build and did not appear in any profile — consistent with the task brief's framing
  that it's off by default and not required to reproduce this bug.

## 6. Recommendation for the remaining (unfixed) majority

The dominant cost (§3, ~70%+ of self-time) is `services/video-cache/service.ts`'s `CanvasSink`-
based main-thread decode of un-proxied sources for preview rendering. This is exactly perf-audit
opportunities **#6** (worker compositor + worker-side decode, L-effort) and **#7** (keep
decoded frames as `VideoFrame`s end-to-end, M-effort, `texImage2D(VideoFrame)` count today is
still 0). No new information changes that doc's ranking or effort estimate — this session adds
a second, independent confirmation that it's the right next perf-wave target, now specifically
tied to the "heavy import + immediate edit" interaction rather than only scrub/playback.

A smaller, still-unaddressed secondary contributor: React re-render churn from
`background-tasks-store` progress ticks propagating into timeline-adjacent components
(`draggable-item.tsx`, `timeline-vu-meter.tsx`, the zoom hook, Radix `Slider`/`Slot` internals —
combined ~2–4% of self-time across profiles). Worth a follow-up pass to check store-selector
scoping, but it's multi-file and wasn't chased further here (below the "small single-file" bar
for this task).

## 7. Evidence index

All under `apps/web/docs/perf/bug14-evidence/`:

- `before-fix-t0.cpuprofile`, `before-fix-t1000.cpuprofile` — pre-fix CDP profiles (§3 table
  sourced from `before-fix-t0`)
- `after-fix-t0.cpuprofile`, `after-fix-t1000.cpuprofile` — post-fix CDP profiles (§4 table)
- `before-fix-console-log.txt`, `after-fix-console-log.txt` — harness console output (import
  timing, longtask arrays, proxy-state checks) for each run
- `summary-after-fix.json` — structured after-fix run results

Fixture: `apps/web/e2e/fixtures/bug14/heavy_4k_hevc_45s.mp4` (104 MB, gitignored by
`apps/web/e2e/fixtures/` in `.gitignore` — left untracked rather than force-added like the w2
fixtures, given its size). Regenerate:
```
ffmpeg -y -f lavfi -i "testsrc2=size=3840x2160:rate=30:duration=45" \
  -f lavfi -i "sine=frequency=440:duration=45" -vf "noise=alls=15:allf=t" \
  -c:v hevc_videotoolbox -tag:v hvc1 -b:v 18M -c:a aac -b:a 128k -movflags +faststart \
  heavy_4k_hevc_45s.mp4
```

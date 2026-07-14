# AXIS-6 — Memory / Caching / Storage

## 1. Header

- **Machine:** Apple M3, 8 cores, **8 GB RAM** (all numbers carry memory-pressure caveat), macOS 26.3
- **Browser:** Google Chrome 150.0.7871.115 via Playwright 1.61.1 `channel:'chrome'`, **headed**
- **GPU renderer (verified at runtime):** `ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)` — real Metal, not SwiftShader
- **Build:** prod-e2e @a2af6c7f (`bun run build:e2e`, served `next start` on port 3106)
- **Date:** 2026-07-14 (lock window 22:34–22:55 JST, ~21 min — 1 min over the 20-min budget, noted; single acquisition)
- **Fixtures:** `fixture-1080p30-h264.mp4` (30 s 1080p30 H.264, 29 MB), `fixture-4k-hevc.mp4` (20 s 4K HEVC, 98 MB), `fixture-audio-3min.wav` (180 s PCM, 16 MB) from the shared fixtures dir
- **navigator.deviceMemory:** 8, **hardwareConcurrency:** 8 (runtime)

### Fixture project as built (deviations from spec, stated)

- **Session-loop project** (`session.mjs`): 3 tracks (2 video + 1 audio), 7 elements = 4× 1080p fixture staggered/overlapping (t = 0, 5, 10, 15 across two video tracks), 1× 4K HEVC (t = 20), 1 text element, 2-effect chain (`color-adjust` + `blur`) on clip 1, 3-min audio at t = 0. **Deviation:** no literal transition element — `AddTransitionCommand` is only constructible from the transitions panel component and is not reachable through the `E2EBridge`/TimelineManager surface; adding one would have required patching product code (forbidden). Two overlapping clips stand in for the adjacency case.
- **Part-2 project** (`part2.mjs`, for reopen/switch/cache runs): 2 video clips (1080p @ 0–10 s, 4K @ 10–18 s) + 3-min audio.
- **Honest-compression statement:** the "editing session" loop ran **12 cycles ≈ 2.5 min of continuous activity** (each cycle = 8 s real playback + 7 seeks + split + effect add/remove + 3 undos), not the 10–20 min asked. Lock contention (7 agents, one 8 GB machine) forced the tighter batch. The flat verdict below is solid across those 12 cycles; a slow leak under ~1 MB/min would be below this test's detection floor — labeled as such.

## 2. Numbers

### 2a. Sustained-session loop (12 cycles, one document, no navigation)

Per-cycle samples (heap via `performance.memory`, rest via CDP `Performance.getMetrics` + DOM census + runtime `URL.createObjectURL` wrap installed before app load):

| cycle | usedJSHeap MB | DOM nodes (CDP) | JS listeners | doc DOM nodes | blob: outstanding | Documents |
|---|---|---|---|---|---|---|
| 1 | 125.9 | 1928 | 3310 | 895 | 6 | 1 |
| 2 | 105.1 | 1883 | 4392 | 894 | 6 | 1 |
| 3 | 120.4 | 1756 | 792 | 895 | 6 | 1 |
| 4 | 104.3 | 1272 | 977 | 894 | 6 | 1 |
| 5 | 112.9 | 1806 | 3587 | 895 | 6 | 1 |
| 6 | 79.5 | 1706 | 1895 | 895 | 6 | 1 |
| 7 | 104.1 | 1722 | 2429 | 894 | 6 | 1 |
| 8 | 99.5 | 1724 | 2439 | 895 | 6 | 1 |
| 9 | 132.4 | 2325 | 5473 | 895 | 6 | 1 |
| 10 | 73.8 | 1735 | 2759 | 894 | 6 | 1 |
| 11 | 117.9 | 1761 | 3131 | 895 | 6 | 1 |
| 12 | 86.5 | 1715 | 2159 | 895 | 6 | 1 |

**Verdict: SAWTOOTH/FLAT.** Heap oscillates 74–132 MB with no upward trend (cycle 12 < cycle 1). DOM nodes flat (894–895), blob: URLs flat at 6 outstanding (8 created / 2 revoked total — 2 transient thumbnail intermediates correctly revoked), listener count oscillates with no monotonic growth. No leak detectable at this session scale.

### 2b. Heap-snapshot class counts (CDP `HeapProfiler.takeHeapSnapshot` after forced GC)

**Reliability caveat:** counts for app/library JS classes (`CanvasSink`, `Input`, `WrappedCanvas`) are unreliable in the minified prod build (constructor names are mangled — `WrappedCanvas: 0` during active playback proves the undercount). **Native classes (VideoFrame, HTMLCanvasElement, ImageBitmap, HTMLVideoElement, AudioBuffer) are browser-defined names and reliable.**

| sample point | HTMLCanvasElement | HTMLVideoElement | VideoFrame | ImageBitmap | AudioBuffer |
|---|---|---|---|---|---|
| after 12-cycle session + GC | 8 | 4 | **90** | 1 | n/c |
| part2: after playback + GC (before switches) | 5 | 4 | **132** | 1 | 5 |
| part2: after 6 switches + GC | 5 | 4 | 41 | 1 | 5 |
| part2: after leaving warm project + GC | 6 | 3 | 58 | 1 | 4 |

**Finding: 90–132 live `VideoFrame` wrapper objects survive a forced GC after playback.** Not monotonic (41–132 across samples), so not an unbounded leak, but far above the expected working set (prefetch ring = 4 + pool 8 per active sink; 2 video media were active). If those frames are **unclosed**, each 4K frame pins ~12 MB of NV12/IOSurface memory outside the JS heap (up to ~1.6 GB at the 132 sample); if closed, the wrappers are near-free. Heap snapshots cannot distinguish closed/unclosed, and I could not capture renderer-process RSS to arbitrate (see §5). **This is the single most important follow-up measurement.** Suspect code: mediabunny decode path used by `apps/web/src/services/video-cache/service.ts` (CanvasSink converts VideoFrame→canvas; the frame should be closed after conversion) and `apps/web/src/lib/media/processing.ts:125-140` (frames ARE explicitly closed there).

### 2c. Cache effectiveness (part-2 project, `window.__byornPerf` = PerfStatsCollector)

15 s continuous playback from t=0, stats sampled every 3 s (N=3 runs):

| t (s) | fps run1 | fps run2 | fps run3 | avgDecodeMs (run3) |
|---|---|---|---|---|
| 3 | 27.4 | 30.2 | 30.1 | 0.33 |
| 6 | 30.0 | 29.3 | 29.7 | 0.44 |
| 9 | 30.0 | 24.2 | 29.3 | 0.46 |
| 12 | 26.6 | 17.2 | 21.8 | 0.83 |
| 15 | 15.7 | 13.9 | 30.0 | 0.26 |

- During the 1080p clip (t 0–10): **~30 fps, avgDecodeMs 0.26–0.46 ms, 0 framesSkipped** — the prefetch ring serves essentially 100% of render-path requests synchronously; decode is fully off the hot path. **The @75e7d287 prior art held.**
- The dip to 14–22 fps lands exactly in the 4K clip window (t 10–18) in all 3 runs: decoder throughput on 4K, not cache misses (avgDecodeMs stays <1 ms; framesSkipped 2/404 — the drop policy sheds frames instead of stalling).

Scrub (20 spread seeks over 3.5 s, one run): **fps 16.7, avgFrameMs 25.6, p95FrameMs 178, avgDecodeMs 26.8, framesSkipped 74/419, veryLongFrames 12.** Scrub is the uncached path by design (keyframe re-seek + forward decode in `seekToTime`, service.ts:321); the ring never covers it. ~27 ms average decode-wait per scrub frame and 178 ms p95 frame time is the measured scrub UX gap vs native (Palmier-class editors keep a scrub thumbnail/proxy pyramid).

**Eviction policy (code, `apps/web/src/services/video-cache/service.ts`):** there is **no bound at all** — `sinks: Map` grows one entry per media×tier and is only emptied by `clearVideo` (asset delete) / `clearAll` (project switch/close). Per actively-decoding sink: `SINK_POOL_SIZE = 8` pooled canvases at decode resolution + 4-frame ring (service.ts:78-89,577-583). Code-derived arithmetic: a full-tier 4K sink pins 8 × 3840×2160×4 B ≈ **265 MB**; a preview-tier sink capped at 1920 ≈ 66 MB. A 20-clip project of **distinct** 4K media files, once all warmed for preview, would pin ~1.3 GB of pooled canvases on this 8 GB machine (clips sharing one media share one sink). **SPECULATIVE (not measured — a 20-distinct-4K-file fixture set wasn't available in the lock window); the per-sink constants are read from code, the thrash claim is untested.** No memory-pressure response exists anywhere (`navigator.deviceMemory` unused in the codebase — grep confirms 0 hits).

### 2d. Media persistence & project reopen

Storage layout (verified in code + runtime):
- **Raw media bytes → OPFS**, per-project directory `media-files-<projectId>` (`apps/web/src/services/storage/service.ts:254`, `opfs-adapter.ts`). OPFS verified available AND actually used at runtime (`navigator.storage.getDirectory` present; adapter opened successfully).
- **Metadata + thumbnails → IndexedDB** (`media-metadata` store); thumbnails are `data:` URLs (survive reload, no re-thumbnail on reopen — verified: after reload `thumbScheme: "data:"`).
- **Runtime access → blob: URLs** minted per load (`service.ts:379-397`); 6 outstanding for 3 assets, revoked on asset removal and project switch (`media-manager.ts:97-105, 224-234`).
- **HEVC ingest normalization persisted:** the 4K HEVC fixture was transcoded once at import (`normalized: {originalCodec: "hevc"}`, stored file 56.6 MB H.264 vs 98 MB source) and **not re-transcoded on reopen** — the prior-art seam does its job.

| metric | median | min–max | N | cold/warm | how |
|---|---|---|---|---|---|
| Import 3 fixtures (incl. 4K HEVC→H.264 transcode) | 12.9 s | 12.0–43.1 s | 4 | cold | `setInputFiles` → `media.getAssets().length >= 3` (real ingest pipeline). 43.1 s outlier = first-ever run w/ concurrent first-paint + heap profiler attached |
| Project reopen, full page reload (storage on disk, in-memory caches dead) — media ready | 942 ms | 882–2566 ms | 3 | cold page / warm disk | `page.reload()` → bridge ready + 3 assets restored |
| Project switch via navigation, once background ingest work drained | ~660 ms | 311–682 ms | 4 | warm | history navigation → bridge ready + project id matches |
| Project switch during post-import background work | 8.8–18.7 s | — | 3 | — | same; see caveat below |

**Reopen is NOT re-doing ingest work** — no re-decode, no re-thumbnail, no re-transcode; ~0.9 s to restore 104 MB of media across 3 assets from OPFS. The 8.8–18.7 s switches immediately after import show background pipelines (auto-transcribe ingest pass, embedding indexer) contending for the machine — an editor-responsiveness issue on 8 GB, not a storage issue.

### 2e. Project-switch leak check (the known bug class) — partial

Runtime heap-diff across 5+ in-session client-side switches **could not be executed as designed** (see §5): (a) calling `editor.project.loadProject()` directly with the editor UI mounted **crashes the route** — `EditorLayout` reads `editor.timeline.getTracks()` during the cleared-scenes window inside `loadProject` (`project-manager.ts:153-154` clears before the async load) and the `/editor` error boundary swallows the tree. Reproduced 3×, deterministic. (b) My popstate-based navigation emulation degraded to full document loads (proven by the injected blob-census counters resetting), which resets the JS heap and therefore cannot show singleton-store retention.

What the (navigation-based) switches did show: no cross-navigation accumulation of native media objects (VideoFrame 132→41, blob: URLs fully released, HTMLVideoElement stable 3–4).

**Static analysis of the singleton-store class (the transcript-store precedent, editor-provider.tsx:56-65):** on a real client-side project switch, `EditorProvider.loadProject` resets exactly two things — Director WeakMaps (`hydrateDirectorStateFromBible`) and `useTranscriptStore.reset()`. These module-global zustand stores hold **per-project data and are NOT reset** (all under `apps/web/src/stores/`):

| store | per-project state that bleeds |
|---|---|
| `beat-grid-store.ts` | beat grid pinned to old project's `elementId/trackId/mediaId` |
| `generation-status-store.ts` | `statusMap` + live poll intervals for old project's jobs |
| `frame-chain-store.ts` | pending first-frame URL chains into the NEW project's next generation |
| `omni-reference-chain-store.ts` | same pattern |
| `background-tasks-store.ts` | old project's task list stays in the widget |
| `search-store.ts` | results referencing old project's mediaIds |
| `engagement-store.ts`, `youtube-reels-store.ts`, `takes-notification-store.ts`, `arrangement-store.ts`, `pen-mask-store.ts` | smaller same-class state |

Byte-wise these are small (KBs); the risk is **correctness bleed** (wrong-project beat grid / chained frame / stale polling), same class as the fixed transcript bug. **Labeled: static finding, runtime retention not verified** (blocked by the crash above — which is itself the stronger finding).

### 2f. crossOriginIsolated / platform gates (VERIFIED at runtime, prod-e2e build)

```
crossOriginIsolated: false
typeof SharedArrayBuffer: undefined
performance.measureUserAgentSpecificMemory: unavailable
'gpu' in navigator: true
navigator.storage.getDirectory: available, opens OK
```

Deploy config: `apps/web/next.config.ts` has **no `headers()` at all**; **no `vercel.json`; no `middleware.ts`** — COOP/COEP are not set anywhere in the repo (grep: 0 hits). **Any other axis's proposal needing SharedArrayBuffer (multithreaded WASM ffmpeg/Whisper, SAB ring buffers) or `measureUserAgentSpecificMemory` is currently gated OFF and requires adding `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` (or `credentialless`) first.** Warning attached: COEP breaks every cross-origin subresource that lacks CORP/CORS — this app loads R2-hosted media, Google fonts, unsplash/CMS images (see next.config remotePatterns), so flipping it is a project, not a header one-liner.

## 3. Evidence pointers

- VideoCache unboundedness + per-sink pool math: `apps/web/src/services/video-cache/service.ts:78` (`PREFETCH_RING_CAPACITY = 4`), `:89` (`SINK_POOL_SIZE = 8`), `:92-93` (unbounded Maps), `:577-583` (pool allocation at decode resolution), `:629-642` (only explicit clears).
- Project-switch cleanup that DOES exist: `apps/web/src/core/managers/media-manager.ts:216-238` (`clearAllAssets`: videoCache.clearAll + revoke all blob URLs), called from `project-manager.ts:128,153,303,322`.
- Audio decoder cleanup exists and is aggressive: `audio-manager.ts:128-134` (`handleTimelineChange` → `disposeSinks()` on every timeline/media notify; subscription wired in constructor `:62-66`) — initially suspected leak, ruled out.
- Route crash on direct loadProject: `project-manager.ts:153-154` (`clearAllAssets`/`clearScenes` before async load) + `scenes-manager.ts:262-266` / `getActiveScene()` throw + `app/editor/error.tsx` boundary; `EditorLayout` reads tracks at `app/editor/[project_id]/page.tsx:73-81`.
- Stores not reset on switch: `components/providers/editor-provider.tsx:44-66` (only transcript + director hydration).
- Blob URL discipline elsewhere: paired create/revoke verified in `lib/export.ts:30-37`, `services/renderer/canvas-renderer.ts:38-47`, `lib/media/processing.ts:179-207`. One unpaired pattern: `hooks/use-thumbnail-gen.ts:94-105` mints one blob URL used as both `url` and `thumbnailUrl` — revoked once by `removeMediaAsset` (`media-manager.ts:97-105`) via the `asset.url` branch, so double-revoke of the same URL (harmless) rather than a leak.
- Raw data: `$BENCH/axis-6/sustained-session.json`, `part2.json`, `post-session-heap-classes.json`, `boot-and-build.json`, logs.

## 4. Ranked opportunities

| # | Opportunity | Measured evidence | Expected gain | Effort | Risk | Class vs native Metal | Verified prerequisites | Re-run recipe |
|---|---|---|---|---|---|---|---|---|
| 1 | **Determine + fix VideoFrame retention after GC** (audit close() discipline on the mediabunny decode path; add a live-VideoFrame counter to perf-stats) | 90–132 live VideoFrame wrappers post-GC after playback (heap snapshots, 4 samples) | If unclosed: up to ~1.6 GB pinned at the 132-sample on 4K content — on 8 GB this is the difference between smooth and swapping. If closed: ~0 (then close this ticket) | S (measure) / M (fix) | Low — measurement first | CLOSABLE | none | `$BENCH/axis-6/part2.mjs` heap-class sampling + add renderer RSS via `ps` on the renderer PID before/after playback |
| 2 | **Byte-bounded, deviceMemory-aware VideoCache with LRU sink eviction** (evict by `lastAccess`, budget = f(navigator.deviceMemory), keep the per-sink ring/pool as is) | No bound exists (service.ts:92, clears only); per-sink pool = 265 MB (4K full) / 66 MB (preview@1920) code-derived; 20-media thrash claim SPECULATIVE | Prevents the unbounded tail; caps worst-case at budget. Gain unquantified until a 20-distinct-media fixture run | M | Medium — evicting a sink the playhead returns to re-pays keyframe re-seek (warm() already mitigates); must not evict mid-export | MITIGABLE (native editors page decoded frames too; they just have real VM) | `navigator.deviceMemory` = 8 verified present | Build 20 distinct 4K files (`ffmpeg -ss` slices of the fixture), warm all for preview, watch renderer RSS + `videoCache.getStats()` (expose totalSinks in perf HUD) |
| 3 | **Fix the store-bleed class: single `resetProjectScopedStores()` in `editor-provider.loadProject`** covering the §2e table (mirror the transcript-store fix) | Static: only 2 of ~13 project-scoped globals reset (editor-provider.tsx:56-65); transcript precedent was a real shipped bug | Correctness (wrong-project beat grid/frame chains/polls), not bytes | S | Low — each store already has trivial initial state | CLOSABLE | none | In-session client-side switch (real router nav, e.g. drive the projects-page Link), then read `useBeatGridStore.getState().grid` etc. in the new project |
| 4 | **Harden `project.loadProject` against mounted-UI calls** (null-safe `getTracks()` during the cleared window, or gate clearing behind the load) | Deterministic route crash, reproduced 3× (§2e) | Robustness: today any programmatic switch (future MCP/Director verb, tests) kills the editor to an error boundary | S | Low | CLOSABLE | none | `page.evaluate(() => editor.project.loadProject({id: otherId}))` with editor mounted; expect no error-boundary swap |
| 5 | **Scrub-path frame cache** (persist a coarse thumbnail strip per media — e.g. 1 frame/s at 160 px from the ingest thumbnail pass — and serve scrub previews from it, full decode only on settle) | Scrub: avgDecodeMs 26.8 vs playback 0.26–0.83; p95 frame 178 ms; 74/419 frames skipped (§2c) | Scrub p95 from ~178 ms to <20 ms (SPECULATIVE until built); closes the most visible feel-gap vs Palmier | M/L | Medium — cache invalidation on edit/effects; disk budget in OPFS | MITIGABLE (native gets it via VideoToolbox speed; we can match perceived quality with a pyramid) | OPFS verified available + already used | Re-run `part2.mjs` scrubPerf block; compare stats |
| 6 | **COOP/COEP enablement project** (prerequisite unlock, not a direct win) | `crossOriginIsolated: false`, SAB absent, no headers config anywhere (§2f) | Unlocks pthreads-WASM (ffmpeg/Whisper), SAB pipelines, `measureUserAgentSpecificMemory` for real memory telemetry | M (audit all cross-origin subresources for CORP/CORS: R2, fonts, unsplash, iconify) | High — silently breaks any un-CORP'd embed in prod | STRUCTURAL | Verified absent today | After headers: `page.evaluate(() => crossOriginIsolated)` on the deploy |
| 7 | **Do NOT add media re-ingest caching — already solved** (anti-recommendation) | Reopen restores 104 MB / 3 assets in 942 ms median with zero re-decode/re-thumbnail/re-transcode (§2d) | — | — | — | — (prior art held: OPFS layer + HEVC seam + data:-URL thumbnails) | — | `part2.mjs` coldReopen block |

## 5. What I could NOT measure (and why)

1. **Renderer/GPU process RSS per cycle** — planned via `ps` against Chrome's process tree; not wired into the harness before the lock window closed (the stub in `session.mjs` returns null). This is the missing arbiter for finding #1. ~15 min of harness work + one lock window.
2. **In-session client-side project-switch heap retention** — direct `loadProject` crashes the route (finding #4); popstate emulation degraded to full document navigations (proven by injected blob-census counters resetting), which resets the heap. Needs a real router transition (drive the projects page `Link`) — one more lock window.
3. **20-clip 4K thrash test** — no 20-distinct-media fixture set within the window; the VideoCache math in §2c is code-derived, thrash unverified.
4. **GPU memory via CDP** — `SystemInfo.getInfo`/`Memory` domains not exposed through Playwright's page-level CDP session in this Chrome; `performance.measureUserAgentSpecificMemory` unavailable (no COI). Only JS-heap + heap-snapshot numbers are reported.
5. **Live VideoFrame closed-vs-open state** — heap snapshots count wrappers, not pinned backing stores (finding #1's open question).
6. **30-min-scale slow leaks** — session compressed to 12 cycles ≈ 2.5 min of activity (lock contention); detection floor ~1 MB/min.
7. **`videoCache.getStats()` direct readout** — the singleton isn't exported on any window seam and the class name is minified; hit rates were inferred from PerfStatsCollector decode-wait (a good proxy: <1 ms = ring-served, ~27 ms = re-seek).

## 6. Scripts left in $BENCH/axis-6/

- `session.mjs` — 12-cycle sustained-session harness: blob-URL census injection, per-cycle CDP metrics, heap-snapshot class counts, fixture-project builder (documented construction via the real `EditorCore` API)
- `part2.mjs` — cold import / reload-reopen timing, playback+scrub PerfStats sampling, navigation-based switch timing, heap-class diffs
- `run.sh` — server + session runner (port 3106, lock-window batching)
- Outputs: `sustained-session.json`, `part2.json`, `post-session-heap-classes.json`, `boot-and-build.json`, `server*.log`, `session.log`

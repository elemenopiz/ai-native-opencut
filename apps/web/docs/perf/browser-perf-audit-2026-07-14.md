# Browser Perf Audit — 2026-07-14

Seven-axis measured investigation of Byorn's perceived performance vs. native (Palmier Pro /
Metal-class) editors. **Evidence + ranked opportunity map only — no fixes shipped in this pass.**

## 1. Header — what was measured, on what

- **Machine:** Apple M3, 8 cores, **8 GB RAM**, macOS 26.3. All numbers carry a
  memory-pressure caveat: up to 7 measurement agents shared this machine (26+ Chrome
  processes at peak, pageouts observed); a bench lock serialized timed runs but could not
  eliminate ambient contention. 4K numbers showed up to 2× load-dependent variance.
  **Re-run the baseline on a quiet 16 GB machine before treating any number as a constant.**
- **Browser:** Google Chrome 150.0.7871.115 via Playwright 1.61.1 `channel:'chrome'`
  (installed Chrome, NOT bundled Chromium — which lacks H.264/HEVC), **headed**, with
  `--disable-backgrounding-occluded-windows --disable-background-timer-throttling
  --disable-renderer-backgrounding` (mandatory: occluded windows suspend rAF).
- **GPU verified every run:** `ANGLE (Apple, ANGLE Metal Renderer: Apple M3)` — real Metal,
  never SwiftShader.
- **Build:** production `bun run build:e2e` @ HEAD `a2af6c7f` (shared image; export timing
  used a dedicated worktree with the E2E export stub removed — the stub is build-time and
  invalidates export numbers otherwise). Dev/turbopack numbers were ruled invalid.
- **Platform capabilities (runtime-verified, ×3 independent confirmations):** WebGPU ✅,
  OPFS ✅, HW H.264 encode ✅, HW HEVC 4K decode ✅ (SW HEVC ❌),
  `EXT_disjoint_timer_query_webgl2` ✅, **`crossOriginIsolated` ❌ / SharedArrayBuffer ❌**
  (no COOP/COEP anywhere: no `headers()` in next.config.ts, no vercel.json, no middleware).
- **Fixtures** (scratch bench dir, generation recipe in bench scripts):
  `fixture-1080p30-h264.mp4` (30 s 1920×1080@30 H.264+AAC, 29 MB),
  `fixture-4k-hevc.mp4` (20 s 3840×2160@30 HEVC hvc1, 98 MB — the "GoPro" fixture),
  `fixture-audio-3min.wav` (180 s PCM, 16 MB), plus **THE fixture project**: 5–6 tracks,
  7 elements = 4× 1080p staggered/overlapping + 1× 4K HEVC + text + 2-effect chain +
  cross-dissolve + 3-min audio (scripted via the real `window.__BYORN_E2E__` manager APIs;
  construction scripts per axis).
- Full per-axis reports + raw traces/JSON + re-runnable scripts: session scratch
  `bench/axis-{1..7}-*.md` and `bench/axis-N/` (see §7 for what to harvest into the repo).

## 2. Verdict

**Byorn already feels native where users start:** warm editor open 317 ms, edit ops sub-ms
in the store and 33–50 ms to paint, zero long tasks, zero CLS, flat memory over an editing
session, project reopen 942 ms with zero re-ingest, and all-1080p export at 6.7× faster than
realtime. **It is visibly, measurably behind the moment a 4K/HEVC source appears or the
timeline gets heavy:** 12–20 s blocking ingest (an unconditional full-res transcode of a
codec the browser hardware-decodes natively), fixture-project playback at 3–6.5 fps with the
renderer main thread 81% saturated while the hardware decoder sits starved at ~8% duty and
the GPU draws 2 quads/frame, 316 ms far-seeks, 178 ms p95 scrub frames, and 4K-source export
slower than realtime (78% of it decoding 4K pixels that get downscaled to 1080p anyway).
**The single biggest lever is the "heavy media path": stop doing provably unnecessary
full-res 4K work (skip decodable-HEVC transcode, decode-at-output-tier on export, auto-proxy
on ingest, pin `prefer-hardware`) and get decode+composite off the main thread — every one of
those is measured, most are S/M effort, and together they attack every red cell in the
baseline table.** WebGPU migration, by contrast, measured as a ~zero-gain non-lever: do not do it.

## 3. THE BASELINE TABLE — golden interactions

Re-run this table after every perf wave (scripts: §7). Budgets are proposed "native feel"
targets. Status: 🟢 inside budget · 🟡 median fine / tail or scaling suspect · 🔴 breached.

| # | Interaction | Measured (median, min–max, N) | Budget | Status |
|---|---|---|---|---|
| 1 | Cold load → editor interactive (TTI) | 1,091 ms (620–3,709, N=5; steady-state cold ≈370–500 ms, loopback) | <3,000 ms | 🟡 (outlier = server first-compile; WAN unmeasured) |
| 2 | Warm reload → editor interactive | **317 ms** (315–343, N=5) | <1,000 ms | 🟢 (rivals native launch) |
| 3 | Project open (existing, 1 clip) → first frame | 1,215–1,294 ms (870–1,707, N=5) | <1,500 ms | 🟡 (1-clip project; scaling unmeasured — blocked by crash, §6) |
| 4 | Project reopen (104 MB media, 3 assets, cold page) | **942 ms** (882–2,566, N=3), zero re-decode/re-thumbnail/re-transcode | <2,000 ms | 🟢 (OPFS+IndexedDB persistence prior art held) |
| 5 | Clip drop (1080p) → visible frame | 281 ms (158–472, N=5) | <500 ms | 🟢 |
| 6 | **4K HEVC ingest (drop → asset ready)** | **18.9 s** (12.0–19.9, N=3+3 across two axes) — ~99% = unconditional full-res HEVC→H.264 transcode, on the main thread | <5,000 ms (soft) | 🔴 **worst number in the audit** |
| 7 | Scrub: seek → painted frame | 25 ms median, **117.8 ms worst-of-20**; scrub-path decode 26.8 ms avg, **178 ms p95 frame** | <50 ms incl. tail | 🟡 (median 🟢, tail 🔴 — the uncached seek path) |
| 8 | Far seek, 4K HEVC (outside 2 s window) | **316 ms** (vs 91 ms @1080p; near-seek ~1–2 ms any res) | <150 ms | 🔴 |
| 9 | Edit op (split/move/trim): store update | 0.4–0.6 ms | <16 ms | 🟢 |
| 10 | Edit op → next paint | 33–50 ms (move 50.1 at the line; first-op-per-track warm-up outliers 533–1,071 ms) | <50 ms | 🟢/🟡 (warm-up tail) |
| 11 | Playback fps, 1080p-only content | ~30 fps, decode-wait 0.26–0.83 ms, 0 skips (ring ~100% hit) | project fps sustained | 🟢 (@75e7d287 held) |
| 12 | **Playback fps, THE fixture project (4K layer + effects + 6 tracks)** | **4.8 fps warm / 5.8 cold** (base), 6.5 (15-clip warm), 3.0 (4K canvas), avg frame 150 ms; main thread 81% busy, HW decoder starved (~11 fps delivered vs ~90 demanded, 6.9 ms/frame capability) | ≥24 fps sustained | 🔴 **the feel gap vs native** |
| 13 | Export, all-1080p sources (30 s timeline) | 4.47 s wall = **0.149× realtime (6.7× faster)**, 91% encoder-bound at the HW ceiling (~208 fps encode) | <0.5× realtime | 🟢 (at machine ceiling — done) |
| 14 | **Export, fixture project w/ 4K layer (27 s)** | 42.1 s = **1.56× realtime (slower than realtime)**, 78% = full-res 4K decode downscaled to 1080p at paint | <1.0× realtime | 🔴 |
| 15 | Sustained session memory (12 edit cycles) | Heap sawtooth 74–132 MB flat; DOM/listeners/blob-URLs flat | no monotonic growth | 🟢 (caveat: 90–132 post-GC VideoFrame wrappers, §5-M1) |
| 16 | Cold wire weight, /editor | 1,205.6 KB transferred, 61 subresources; 3,936 KB raw / 1,089 KB gzip eager; CLS = 0 | <1 MB gzip | 🟡 (zero code-splitting; ~95 KB gzip trivially deferrable) |

Context: the prior 28.4 fps / 2.2 ms compositor number (@75e7d287) was real but on a lighter
scene — an empty-scene control ran at exactly 30.002 fps / 0.23 ms (the loop isn't the limiter).
Row 12 is the honest number under protocol load.

## 4. Ranked opportunity map

Ranking = (expected perceived gain × confidence) ÷ effort. Class is vs. native Metal:
**CLOSABLE** (we can match), **MITIGABLE** (can't match mechanism, can match feel),
**STRUCTURAL** (native keeps it; position around it).

| # | Opportunity | Axis | Measured evidence | Expected gain | Effort | Risk | Class |
|---|---|---|---|---|---|---|---|
| 1 | **Skip the unconditional HEVC→H.264 ingest transcode when `probe.decodable` is true** | 3 | 11.0–19.9 s transcode = >99% of 4K ingest; this exact browser HW-decodes 4K HEVC at 309 fps (measured); `PORTABLE_VIDEO_CODECS=["avc"]` forces transcode regardless | Ingest 18.9 s → **<0.2 s** (probe+thumbnail) for decodable sources | M | Med (downstream h264 assumptions need audit; keep transcode fallback for non-decodable browsers) | CLOSABLE |
| 2 | **Cap export decode tier at output canvas size** (decode 4K at ≤1080p when exporting 1080p) | 4 | 32.8 s of 42.1 s fixture export = full-res 4K decode, then downscaled at paint; tier seam already exists (`video-node.ts:100-128`) | 4K-source export 1.56× → ~0.5–0.7× realtime (SPECULATIVE ~3–4×, floor = 4.9 s encode) | M | Med (full-res fallback needed for crop/zoom>1 elements) | CLOSABLE |
| 3 | **Auto background proxy generation on ingest via the already-shipped `generateProxy()`** (+ fix its odd-dimension 480p crash) | 3 | Proxy infra fully built, wired to a manual settings button only; generation measured 2.2 s median per 20 s 4K clip (8–9× faster than server sw-ffmpeg); 480p preset crash reproduced (853×480 odd width rejected by AVC encoder) | 4K scrub/preview at proxy cost (far-seek 316 ms → ~91 ms-class; SPECULATIVE end-to-end) | S (+S for the crash fix) | Low | CLOSABLE (native NLEs all do this) |
| 4 | **Kill the playhead forced-reflow loop** (`timeline-playhead.tsx` writes `style.left` then reads `clientWidth/scrollLeft` every rAF tick → cache via ResizeObserver, move via `transform`) | 2 | **631 forced layouts / 3,384 ms in a 17.3 s trace (~20–24% of main-thread busy)** during pure playback | Returns ~1/5 of the main thread to the decode pump; +2–5 fps on fixture (SPECULATIVE) | **S** | Low | CLOSABLE |
| 5 | **Set `decoderOptions.hardwareAcceleration:'prefer-hardware'`** at the 3 mediabunny sink call sites (video-cache, proxy-generator, processing) | 3 | App passes no preference anywhere; measured: 1080p 579→949 fps (+64%), 4K HEVC 112→309 fps (+176%), AND run-to-run variance collapses (133–918 → 914–1,029) | 2–3× decode throughput + consistency; feeds rows 8/12 | **S** | Low (isConfigSupported-verified; add no-preference fallback) | CLOSABLE |
| 6 | **Worker compositor + worker-side decode** (OffscreenCanvas; CanvasRenderer + node tree + mediabunny sinks off the main thread; React posts scene descriptors) | 2 | Main thread 81% busy hosts decode pump + rAF composite + microtask chains; HW decoder starved (6.9 ms/frame capability, ~11 fps delivered vs ~90 demanded); at 4K canvas the rAF loop itself fell to 2–4 ticks/s (main-thread raster of 4K frames) | Fixture playback 3–6 fps → 20–30 fps (extrapolation from decoder capability — the flagship structural fix) | **L** | High (text-node DOM font APIs, cache handoff, messaging) | CLOSABLE — this IS native's UI/render-thread split; no SAB needed (verified) |
| 7 | **Keep decoded frames as VideoFrames end-to-end** (VideoSampleSink instead of CanvasSink; drawImage/texImage2D accept VideoFrame) | 2 | `texImage2D(VideoFrame)` count = **0** today: mediabunny rasterizes every frame to a 2D canvas on the main thread before Byorn sees it; main-thread 4K raster is why the 4K canvas crawls | Removes one full-res main-thread raster per layer per frame; combines with #6 (VideoFrame is transferable) | M | Med (frame lifetime vs canvas-pool aliasing contract; interacts with M1 below) | CLOSABLE |
| 8 | **Code-split the editor** (`next/dynamic` for Director catalog/API, gl-transitions defs, wavesurfer, dnd, Settings/onboarding views) | 7 | **0** `next/dynamic`/`React.lazy` sites repo-wide; ~330 KB raw / ~95 KB gzip of never-used-at-open modules in the eager 1,089 KB gzip set | ~9% off first-paint payload; TTI delta SPECULATIVE | M | Low | CLOSABLE |
| 9 | **Delete `public/ffmpeg/ffmpeg-core.wasm` (31 MB) + 3 dead `@ffmpeg/*` deps** | 7 | 0 references in src AND built output; deployed + URL-reachable for nothing | 31 MB off every deploy; hygiene | **S** | ~0 | cleanup |
| 10 | **Measure→fix VideoFrame retention after GC** (close() discipline on the decode path; add live-frame counter to perf-stats) | 6 | 90–132 live VideoFrame wrappers survive forced GC after playback (expected ~12–24); if unclosed = up to ~1.6 GB pinned IOSurface on 4K on an 8 GB machine; closed-vs-open unresolved (renderer RSS is the missing arbiter) | Bounded today, but potentially the difference between smooth and swapping on low-RAM | S measure / M fix | Low | CLOSABLE |
| 11 | **Byte-bounded, deviceMemory-aware VideoCache LRU** (evict by lastAccess; budget = f(deviceMemory)) | 6+3 | No eviction exists (unbounded Map, cleared only on delete/switch); per-sink pool = 265 MB (4K full) / 66 MB (preview) code-derived; 12→20 concurrent sinks collapses tick rate 5.4× with 1.3–1.9 s stalls (8 GB implicated) | Flattens the 20-clip cliff; caps worst case | M | Med (don't evict what warm() protects; never mid-export) | MITIGABLE (native has real VM headroom) |
| 12 | **Scrub-path thumbnail strip / preview pyramid** (coarse 1 fps strip per media from ingest; full decode on settle) | 6 | Scrub decode 26.8 ms avg / p95 frame 178 ms / 74 of 419 frames skipped vs sub-ms during playback | p95 178 ms → <20 ms target (SPECULATIVE); the most visible feel gap vs Palmier scrubbing | M/L | Med (invalidation on edit) | MITIGABLE — #3 (proxies) buys most of it cheaper; do that first |
| 13 | **Overlap export decode/encode + concurrent audio mixdown + throttle per-frame progress notify** | 4 | Phases measured strictly serial (frame N+1 waits on N's encode await); mixdown 0.76 s serial pre-phase; 810–900 store-wide notifies per export (cost unmeasured) | ~13% now; ~30% **after** #2 lands; mixdown ~2–3% | S–M | Low | CLOSABLE |
| 14 | **`resetProjectScopedStores()` on project switch** (~10 stores bleed: beat-grid, generation-status polls, frame-chain, background-tasks, search…) + **harden `loadProject` against mounted-UI calls** (deterministic crash, 3× repro) | 6 | Static: only transcript + Director WeakMaps reset today (editor-provider.tsx:56-65) — same class as the shipped transcript-leak bug; crash: `getTracks()` during cleared-scenes window → error boundary | Correctness (wrong-project data, stale polls), not bytes; crash blocks any programmatic switch (future MCP/Director verbs) | S+S | Low | CLOSABLE |
| 15 | **Cache waveform peaks per mediaId** (persist like thumbnailUrl) | 3 | 70–115 ms recomputed on every `AudioWaveform` mount (code-confirmed uncached); worse for compressed audio | Removes a recurring redundant cost | S–M | Low | CLOSABLE |
| 16 | **Local-AI GPU/CPU yield during playback + ingest** (tighten the existing scheduler's playback gate) | 2 | 3,126 ms of WebGPU (CLIP indexing) during a traced playback window; post-import project switches took 8.8–18.7 s while background pipelines drained | First-play-after-import smoothness (SPECULATIVE size) | S | Low | CLOSABLE |
| 17 | **Service worker precache + offline shell (+ PWA installability)** | 7 | No SW exists; chunks already immutable-cached; warm TTI 317 ms is the loopback floor — the real win is WAN cold (1.2 MB) → 0 network bytes + instant/offline open; manifest.json already present | Instant repeat-open story vs "native launches fast"; WAN delta SPECULATIVE from loopback | M | Low-med | CLOSABLE — the unclaimed web-native counter |
| 18 | **Idle-prewarm Whisper/CLIP worker** (requestIdleCallback → WorkerSlot.acquire; idle-unload already exists) | 7 | 0 prewarm sites; 21 MB ORT WASM + HF weights all paid at first use (first-use latency unmeasured — WAN) | Cuts first-transcribe/search latency; costs bytes for sessions that never use it — product call, mind 8 GB users | S | Med | MITIGABLE |
| 19 | **Effect-chain GL batching** (keep intermediates as textures across a clip's chain) + pool transition scratch canvases + fix `drawFullscreenQuad` per-draw WebGLBuffer leak | 2 | 2 uploads + 2 canvas round-trips per frame for a 2-effect chain (avgEffect 2.4 ms @1080p / 4.6 ms @4K); createBuffer 2/frame with 0 deletes (leak, live-counted); 2 full-frame OffscreenCanvas allocs/frame during transitions | ~1–2 ms/frame at today's depth — do after #4/#6; leak fix is hygiene | S–M | Low | CLOSABLE |
| 20 | **Cloud/hybrid export** ("preview local, final render in cloud") | 4 | Honestly sized: NO server compositor exists (`export.py` = single-file ffmpeg re-encode; frontend stub has 0 call sites); sources not in R2 for local projects (fixture = 150 MB unique → 60/24/12 s at 20/50/100 Mbps floor); export is credit-unmetered ($0 COGS today); local 1080p export already 6.7× realtime — **cloud can never win wall-clock there** | 4K-source crossover exists (~68 s vs 4.7 min local @100 Mbps + SPECULATIVE 0.3× GPU server) — but #2 likely guts the speed case; residual rationale = battery/thermals/close-the-tab + >1080p outputs. Unit economics fine (~1 credit/export); the cost is build+ops (compositor rewrite or GPU headless-Chrome fleet) | L | High | **STRUCTURAL lever (ours)** — re-evaluate AFTER #2 with fresh ratios |
| 21 | **COOP/COEP enablement** (unlocks SAB, threaded WASM, `measureUserAgentSpecificMemory`) | 1/2/5/6 | `crossOriginIsolated:false` verified ×3; zero headers config repo-wide; COEP flip requires CORP/CORS audit of R2/fonts/unsplash subresources | Prerequisite unlock only — nothing in the top 10 needs it (worker compositor works without SAB) | M | High (silently breaks un-CORP'd embeds) | STRUCTURAL — defer until something needs it |

**Measured anti-recommendations (do NOT do):**
- **WebGPU migration of the node graph: ~zero gain.** GPU pipeline is 2 draws / 2 uploads /
  2.4–4.9 ms per frame — idle. Port surface is ~20 GLSL effects + ~20 transitions for nothing.
  (Also fenced: WebGPU q8 collapses CLIP embeddings.)
- **Don't rebuild media persistence** — OPFS + IndexedDB thumbnails + persisted HEVC
  normalization already give 942 ms reopen with zero re-work.
- **Timeline virtualization is not urgent** — flat commit counts and 0 long tasks through 50
  clips (insert scales 0.17 ms/clip). Re-test at 200–500 clips; don't build it on vibes.
- **Encoder `prefer-hardware` pinning: measured ≈0** on M3 (hw/sw/no-pref all ~4.8 ms/frame,
  encoder already at ceiling). The decoder-side hint (#5) is where the 2–3× lives. May differ
  on Windows/dGPU — unmeasured.

### Correctness bugs surfaced by measurement (fix independently of perf)

- **B1 — `text-node.ts:372-376` `paddingX`-of-undefined crash** to the editor error boundary
  during media import; 6/6 repro once onset, suspected trigger via the embedding-indexer UI
  path. Blocked one axis's playback measurement entirely. Root-cause session needed.
- **B2 — `generateProxy()` 480p odd-dimension crash** (853×480 rejected by AVC encoder) —
  scale math never rounds to even. (Background-task chip already filed.)
- **B3 — `loadProject()` with mounted editor UI crashes the route** (cleared-scenes window),
  3× deterministic — blocks programmatic project switching.
- **B4 — fps60 playback wedge** (one `getFrameAt` stalled 81 s, N=1) — decode-scheduler
  starvation signal under over-demand; needs a repro attempt.

## 5. Per-opportunity detail — mechanism + verification

(Files/symbols and re-run recipes; full evidence in the per-axis reports.)

**#1 Skip decodable-HEVC transcode.** `decideNormalization()` in
`src/lib/media/normalize-media.ts:42-49` transcodes every non-AVC codec even when
`probe.decodable === true`; `normalizeVideoFile` re-encodes at source resolution. All 9
`processMediaAssets` call sites pay it, on the main thread (no Worker in the chain).
Prereq: audit downstream all-video-is-h264 assumptions (export mixdown, thumbnails); keep
the transcode as the fallback when `canDecode()` is false (and see #20's server fallback for
that residual class). Verify: re-run ingest-stage attribution on the 4K fixture — total
should drop from ~11–19 s to probe+thumbnail (~0.2 s).

**#2 Export decode-tier cap.** Export scenes leave `previewDecodeMaxSize` unset →
`tier:"full"` (`nodes/video-node.ts:14-19,100-128`); frames are decoded at 3840×2160 then
`drawImage`-downscaled to the 1080p output canvas. Extend the existing tier plumbing with
an export tier = output canvas size, falling back to full-res per element when crop/zoom
samples beyond output density. Verify: re-run the export bench — decode bucket ≈÷4, wall
42 s → ~15–20 s, output pixels identical.

**#4 Playhead forced reflow.** `timeline-playhead.tsx` (own rAF loop during playback):
writes `el.style.left` (~line 77) then reads `clientWidth/scrollWidth/scrollLeft`
(~lines 88-92). Cache viewport metrics via ResizeObserver, move the marker with
`transform`, read scrolls before writes. Verify: re-trace 10 s playback —
`Blink.ForcedStyleAndLayout` count → ~0 (from 631/3.4 s).

**#5 `prefer-hardware` decode.** Add `decoderOptions:{hardwareAcceleration:"prefer-hardware"}`
at `video-cache/service.ts:577-583`, `proxy-generator.ts` CanvasSink, `processing.ts`
VideoSampleSink, with try/no-preference fallback. Verify: standalone decode-throughput
harness before/after (expect 1080p ~950 fps tight-band, 4K ~309 fps).

**#6 Worker compositor.** Move `CanvasRenderer` + node tree + mediabunny sinks into a worker
via `transferControlToOffscreen` (verified supported); React posts scene descriptors; the
tick channel already isolates React from the frame loop, so the seam is clean. Watch:
text-node uses DOM font APIs (needs `OffscreenCanvas` text or a font-ready handshake);
VideoCache handoff. No SAB required. Verify: re-run the compositor bench — CrRendererMain
busy% during playback and `avgDecodeMs` are the two numbers that must collapse; fixture fps
≥20.

**#20 Cloud export honesty.** What exists: FastAPI `/api/export/render`
(`services/ai-backend/app/routes/export.py`) = single-input ffmpeg re-encode; a typed,
never-called client (`ai-client.ts:1487`); R2 with content-addressed dedup. What's missing:
any server-side timeline/compositor — the options are a compositor rewrite (permanent
two-renderer parity tax on every future effect) or GPU headless-Chrome fleet (code reuse,
ops burden). Watermark parity: free under headless-Chrome (same `drawWatermark()` Canvas2D
path), a port item under a rewrite. Decision gate: re-run the export baseline after #2; if
4K-source exports land ≤0.7× realtime locally, cloud export's remaining case is
battery/thermals/close-the-tab UX and >1080p outputs — schedule accordingly, not for speed.

## 6. Structural honesty — what native Metal keeps

| Native advantage | Can we close it? | Position |
|---|---|---|
| Direct VideoToolbox decode at target resolution, zero-copy IOSurface → Metal texture | Mostly — WebCodecs rides the same silicon (309 fps 4K HEVC measured); what we lose is copy discipline, which #5/#7/#6 largely recover | CLOSABLE in feel: our measured decode ceiling exceeds playback demand by >3× once fed properly |
| Dedicated render thread, UI can never starve the compositor | Architecturally yes — worker compositor (#6) is exactly this split | CLOSABLE (the single most important architecture move) |
| Real virtual memory + unified-memory headroom; no per-tab budget | No. A browser tab on an 8 GB machine lives in a box | MITIGABLE: byte-bounded caches (#11), proxies (#3), VideoFrame hygiene (#10), deviceMemory-aware tiers. Accept the box, manage it |
| Local file I/O with no ingest step | Partially — OPFS already gives us persistent, re-ingest-free media (942 ms reopen) | MITIGABLE; #1 removes our self-inflicted worst case |
| Instant binary launch | Warm 317 ms already competitive; cold WAN pays ~1.2 MB | MITIGABLE via SW precache (#17) + code-split (#8) |
| Raw DSP/shader throughput | Not contested — our GPU load is 2 draws/frame; the fight isn't here | ACCEPT + don't compete (per the poach docs' "deliberately ignore") |
| — Our levers they can't pull — | | |
| Zero-install, instant updates, links that open a project | inherent | Claim louder in positioning |
| Cloud offload (export, heavy AI) off a Python backend + R2 | exists for AI; export = STRUCTURAL project (#20) | Re-price after #2; sell as battery/thermals/close-the-tab, not speed |
| Prewarmed shell / offline open | unclaimed today | #17 is cheap and visible |

## 7. Bench harness recommendation

The audit leaves ~15 re-runnable scripts in the session scratch (`bench/axis-N/`). Harvest
into `apps/web/bench/` (gitignored results dir) as the standing regression harness:

1. **Golden-interaction suite** (axis-1's `01`–`07` scripts + shared `lib.js`): TTI
   cold/warm, project open, clip drop, 4K ingest, scrub, edit ops, real export — prints
   the §3 baseline table. This is the artifact to re-run per wave.
2. **Compositor scenarios** (axis-2's `bench.js base|heavy|fps60|res4k`): builds THE fixture
   project via `__BYORN_E2E__`, reads `window.__byornPerf`, optional CDP trace, GL counters.
3. **Decode/cache microbench** (axis-3's standalone harness): bundles the real shipped
   `video-cache`/`normalize-media`/`proxy-generator` via `bun build` — high-N numbers with
   no app boot; the right place to verify #1/#3/#5.
4. **Export bench** (axis-4's `run-export-bench.mjs` + phase brackets): needs a non-e2e or
   stub-removed build — consider making the E2E export stub opt-in (`NEXT_PUBLIC_E2E_STUB_EXPORT`)
   so one build serves both (that's a product-code change; do it in the first perf wave).
5. **Memory session loop** (axis-6's `session.mjs`/`part2.mjs`): heap/DOM/blob/VideoFrame
   census; add the missing renderer-RSS sampler (the #10 arbiter).
6. **Startup/bundle** (axis-7's `measure.cjs`/`resources.cjs` + `--experimental-analyze` in a
   throwaway worktree): eager-set gzip total is the budget number; fail the wave if it grows.

Validity rules the harness must encode (each one burned an agent this session):
`channel:'chrome'` headed + the three `--disable-*throttling/backgrounding` flags + an
in-page rAF-rate probe before trusting numbers; GPU renderer string asserted ≠ SwiftShader;
big fixtures over a real HTTP server (Playwright `route.fulfill` dies on 98 MB bodies);
never `page.reload()` right after building a project (races the 800 ms debounced save —
seed via `addInitScript`); `VideoEncoder`/`VideoDecoder` probes need a secure/localhost
origin; the E2E build stubs export; expect first-op-per-track decoder warm-up outliers.

## 8. Freshness

- **Re-run the §3 table**: after every perf wave (at minimum suites 1–2); after any Next.js
  major / Turbopack default change (re-check bundle anatomy, §16); after Chrome majors
  (WebCodecs/rAF/headless behavior shifts); after any mediabunny upgrade (decode path).
- **Re-measure on a quiet ≥16 GB machine** before publishing any number externally — the
  8 GB + 7-agent contention inflated variance (4K numbers up to 2×), and several findings
  (VideoCache 20-sink cliff, VideoFrame retention severity) are RAM-sensitive.
- **Single-run caveats to re-confirm at N≥5**: axis-2 scenario numbers (N=1–2; conclusions
  rest on 50–600× ratios so direction is safe), axis-5's entire set (N=1), the fps60 wedge
  (N=1), axis-5's playback commit-storm anomaly (1,869 commits/30 s, ~107 Tooltip/Popper
  components per commit — likely a synthetic-media decode-retry artifact; re-run with real
  ingested media before treating as a regression).
- **Blocked measurements to close next session**: real-UI ingest long-task census (script
  ready, axis-3), real mouse-driven INP (selector fixes documented, axis-5), renderer RSS
  during playback (axis-6), first-transcribe WAN latency + weight bytes (axis-7), real
  Vercel edge headers + PWA installability (needs the live deploy).
- The **text-node import crash (B1) must be fixed before any future fixture-project baseline
  is trustworthy** — it blocked item 12's N this session.

## 9. The three highest-leverage moves

Ranked by (expected perceived gain × confidence) ÷ effort:

1. **The "heavy-media path" wave — #1 + #5 + #3(+B2 fix) + #2.** Four S/M items, every one
   backed by a direct measurement, no new architecture: skip decodable-HEVC transcode,
   pin prefer-hardware decode, auto-generate proxies with already-shipped code, cap export
   decode at output tier. Together they turn the audit's three worst numbers (18.9 s ingest,
   316 ms far-seek/178 ms scrub p95, 1.56× realtime export) into green or near-green cells,
   and they de-risk/re-price the cloud-export decision for free.
2. **Main-thread liberation — #4 now, #6 as the flagship.** The playhead reflow fix is
   S-effort and returns ~20% of the main thread immediately; the worker compositor is the
   L-effort structural move that closes the one gap users feel most (fixture playback
   4.8 → 20-30 fps) and is the only item here that changes our class vs native rather than
   a number.
3. **Delivery quick wins — #9 + #8 + #17.** Delete the 31 MB orphan, code-split ~95 KB gzip
   off first paint, add the service-worker instant-open shell. Small, low-risk, and they
   claim the web-native "launches instantly, always fresh" story Palmier can't tell.

**Dispatch first: move 1, the heavy-media-path wave.** Highest confidence (all four numbers
measured on both sides), bounded blast radius (three files' policy seams + one existing
tier), and it fixes the first impression — a GoPro user's very first drag currently costs
19 seconds of frozen import for no technical reason. Fold the B1 crash root-cause into the
same wave's verification step, since its trigger (media import) sits on the same path and
blocks the post-wave baseline re-run.

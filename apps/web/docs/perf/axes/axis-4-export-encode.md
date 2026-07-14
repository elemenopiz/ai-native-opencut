# AXIS-4 (EXPORT/ENCODE) — Byorn Perf Audit 2026-07-14

## 1. Header

- Machine: Apple M3, 8 cores, **8 GB RAM** (memory-pressure caveat applies to all numbers; fixture
  run 2's +15% outlier is consistent with pressure), macOS 26.3.
- Browser: Google Chrome 150.0.7871.115 via Playwright `channel: 'chrome'`, **headed**.
- GPU renderer string (runtime-verified): `ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)`,
  vendor `Google Inc. (Apple)` — real Metal-backed GPU, not SwiftShader.
- Build: **not** the shared `$BENCH` prod-e2e `.next` in the main checkout — that build's
  `E2EBridge` unconditionally stubs `renderer.exportProject`
  (`apps/web/src/components/editor/e2e-bridge.tsx:74-98` on main: "Swap the real (canvas + ffmpeg)
  encoder for a deterministic stub"), which is invalid for export timing per the shared PROTOCOL's
  own warning. Instead: a dedicated git worktree at
  `/Users/zsha/Documents/ai-native-opencut-axis4-export` (branch `axis4-export-bench`, off
  `a2af6c7f`, own `bun install` + own `bun run build:e2e` + own `.next`, served on port 3104 —
  the shared prod build was never touched or rebuilt), with throwaway edits:
  1. `e2e-bridge.tsx` — removed the `exportProject` monkey-patch. Export runs the **unmodified
     production canvas/mediabunny/WebCodecs path**. `NEXT_PUBLIC_E2E=1` is kept only to bypass the
     beta-gate proxy (`apps/web/src/proxy.ts:38-41` returns `NextResponse.next()` under the flag)
     and to expose `editor` / `processMediaAssets` / `buildElementFromMedia` on `window` for
     scripted, repeatable project construction (bypassing UI drag-drop, which is not under test).
  2. `scene-exporter.ts` / `canvas-renderer.ts` / `renderer-manager.ts` — `performance.now()`
     brackets around decode(prepare) / paint / encode / mux / audio-mixdown, surfaced as
     `window.__axis4ExportTiming` + `window.__axis4MixdownMs`. Nothing merged; main checkout
     untouched (protocol rule 2).
- Date: 2026-07-14 (runs 22:56–23:06 JST under the bench LOCK). Fixtures (shared set):
  `fixture-1080p30-h264.mp4` (30 s 1080p30 H.264+AAC, 30,503,677 B), `fixture-4k-hevc.mp4`
  (20 s 4K30 HEVC hvc1, 102,419,303 B), `fixture-audio-3min.wav` (180 s stereo PCM, 17,280,078 B).

### Fixture-project construction (scripted, repeatable — `$BENCH/axis-4/run-export-bench.mjs`)

Per PROTOCOL: 6 tracks, 7 elements = 4× the 1080p fixture (8 s spans; two overlapping pairs on two
video tracks, 1 s overlaps), 1× the 4K HEVC clip (18 s span on a third video track, starting t=3),
1 text element, `cross-dissolve` (0.5 s) `transitionOut` on the first clip of each overlapping
pair, a 2-effect chain (`color-adjust` + `vignette`) on clipA, and the 3-min audio fixture
trimmed to the 27 s timeline on an audio track. Timeline duration 27.0 s → 810 frames @30.
Export options both projects: `{format: "mp4", quality: "high", fps: 30, includeWatermark: true}`;
fixture adds `includeAudio: true`. Output canvas 1920×1080 (set from first inserted 1080p asset).

## 2. Numbers

### 2a. Export wall time + phase split (N=3 each, cold — fresh page & fresh project per run)

**Simple project — 30 s single 1080p clip, no audio/effects/transitions (clean lower bound):**

| Metric | median | min–max | N | How measured |
|---|---|---|---|---|
| Export wall (outer) | **4.475 s** | 4.425–4.518 s | 3 | `Date.now()` around `renderer.exportProject` |
| **Realtime ratio (wall / 30 s timeline)** | **0.149×** (≈6.7× faster than realtime) | 0.147–0.151× | 3 | derived |
| encode (`videoSource.add` waits, incl. encoder backpressure) | 4.088 s (**91%**) | 4.044–4.120 s | 3 | per-frame brackets, summed |
| decode (node.prepare waits, videoCache full tier) | 0.262 s (5.9%) | 0.237–0.300 s | 3 | same |
| paint (Canvas2D composite + watermark) | 0.053 s (1.2%) | 0.050–0.062 s | 3 | same |
| mux (`output.finalize`) | 0.081 s | 0.074–0.083 s | 3 | bracket |
| audio mixdown / audio encode | 0 (no audio) | — | 3 | bracket |
| Output buffer | 22.6 MB (≈6.0 Mbps, QUALITY_HIGH) | — | 3 | `buffer.byteLength` |

**Fixture project — 27 s, 6 tracks, 4×1080p + 18 s 4K HEVC layer + text + audio + 2 effects + 2 transitions:**

| Metric | median | min–max | N | How measured |
|---|---|---|---|---|
| Export wall (outer) | **42.1 s** | 39.7–48.6 s | 3 | as above |
| **Realtime ratio (wall / 27 s timeline)** | **1.56×** (SLOWER than realtime) | 1.47–1.80× | 3 | derived |
| decode (dominated by full-res 4K HEVC) | 32.8 s (**~78%**) | 31.4–38.1 s | 3 | per-frame brackets |
| paint | 0.99 s (2.4%) | 0.63–1.09 s | 3 | same |
| encode | 4.93 s (11.7%) | 4.87–7.93 s | 3 | same |
| mux | 1.24 s | 0.46–2.12 s | 3 | bracket |
| audio mixdown (`createTimelineAudioBuffer`, pre-loop) | 0.76 s | 0.74–1.26 s | 3 | bracket in renderer-manager |
| audio encode (`audioSource.add` + `output.start`) | 0.05 s | 0.047–0.057 s | 3 | bracket |
| Output buffer | 20.2 MB | — | 3 | `buffer.byteLength` |

Buckets + residual reconcile with wall to <0.1% (e.g. simple run 0: 302+4088+81+1 = 4472 ms vs
4474 ms inner wall) — no unattributed time.

**The headline anatomy finding:** the bottleneck **flips with source material**. All-1080p-source
export is *encoder-bound* (91% encode, runs at the machine's encoder ceiling — see 2c) and 6.7×
faster than realtime. Add one 4K HEVC source layer and export becomes *decode-bound* (~78% waiting
on full-res 4K HEVC decode, `videoCache.getFrameAt tier:"full"` → ~40 ms/frame while the 4K clip
is on screen) and drops to 1.56× slower than realtime — a **10.5× swing in realtime ratio**
attributable to source decode, not to compositing (paint stays ≈1 ms/frame in both) and not to
encoding (encode stays ~4.5–6 ms/frame in both).

### 2b. WebCodecs capability — configured vs available (runtime-verified on this Chrome/machine)

Configured by the app: `scene-exporter.ts:97-100` passes only `{codec: "avc"|"vp9", bitrate}` to
mediabunny's `CanvasSource` — **no `hardwareAcceleration` key** → mediabunny forwards `undefined`
(`encode.js:118-137`) → WebCodecs default **`no-preference`**. The app also never sets
`latencyMode` (defaults to `"quality"`) or `contentHint`.

Available (`VideoEncoder.isConfigSupported`, localhost secure context, Chrome 150 / M3):

| Codec / resolution | prefer-hardware | prefer-software |
|---|---|---|
| H.264 High `avc1.640028` 1080p 8 Mbps | supported | supported |
| H.264 High L5.1/L5.2 4K 20 Mbps | supported | supported |
| HEVC Main L5.1 4K | supported | supported |
| VP9 L5.1 4K | NOT supported | supported |
| AV1 L5.1 4K | NOT supported | supported |

(Methodology note: a first probe wrongly reported 4K H.264 unsupported — `avc1.640028` is level
4.0, which caps at 1080p; that was a codec-string artifact, corrected with L5.1/L5.2 probes in
`$BENCH/axis-4/probe-4k.mjs`. Also: `VideoEncoder` is undefined on non-secure origins — probes
must run on localhost/https.)

### 2c. Does the missing `prefer-hardware` matter? — No, measured

Raw `VideoEncoder` microbench (300× 1080p frames off an OffscreenCanvas, same `avc1.640028` +
8 Mbps + queue-depth-4 backpressure discipline as mediabunny, N=3 per setting,
`$BENCH/axis-4/encode-hw-vs-sw.mjs`):

| hardwareAcceleration | median ms/frame | min–max (total ms for 300) |
|---|---|---|
| no-preference (what Byorn gets today) | 4.79 | 1432–1701 |
| prefer-hardware | 4.80 | 1438–1468 |
| prefer-software | 4.72 | 1392–1430 |

All three settings identical within noise (~4.8 ms/frame ≈ **208 fps encoder ceiling at 1080p**).
The in-app export achieves 900 frames / 4.088 s = **220 fps effective through the encode bucket** —
i.e. the export loop already runs at the encoder's ceiling; pinning `prefer-hardware` would buy
**≈0** on this machine. "Configured vs available" is therefore NOT a gap on Apple Silicon/Chrome
150 (it may still matter on Windows dGPU boxes — unmeasured, SPECULATIVE).

`VideoFrame(canvas)` construction cost (draw + construct + close, no encoder,
`$BENCH/axis-4/videoframe-cost.mjs`): 300 frames in 11.3–22.1 ms = **0.04–0.07 ms/frame** vs
draw-only 0.3–1.3 ms/300. Canvas→encoder readback is **negligible**; there is no `readPixels`/
`getImageData` in the app path (mediabunny wraps the canvas in `new VideoFrame(canvas)` —
`sample.js:777-802` — the browser-native, GPU-side constructor). Caveat: construction may defer
actual copy until encoder consumption; but since total encode cost is byte-identical between the
in-app loop and the raw benchmark, there is no hidden readback tax unaccounted for.

## 3. Evidence & code anatomy (file:line per finding)

### 3a. Pipeline trace

`export-button.tsx` → `ProjectManager.export()` (`core/managers/project-manager.ts:218-240`) →
`RendererManager.exportProject()` (`core/managers/renderer-manager.ts:99-186`: audio mixdown →
`buildScene()` full-quality scene → `SceneExporter`) → `SceneExporter.export()`
(`services/renderer/scene-exporter.ts:81-166` on main): per frame `await renderer.render()` then
`await videoSource.add(time, 1/fps)` → mediabunny `VideoEncoderWrapper` → WebCodecs
`VideoEncoder` → `Mp4OutputFormat`/`BufferTarget` mux in JS.

**Correction to the mission brief**: export compositing is **Canvas2D**, not WebGL.
`CanvasRenderer` (`canvas-renderer.ts:60-96`) uses `getContext("2d")`; WebGL is only an
effect/transition side-channel (`webgl-effect-renderer.ts`, `transition-renderer.ts`) whose
output is blitted back via `drawImage`. Export is full-res by design (prior art @75e7d287,
`nodes/video-node.ts:14-19`: export scenes leave `previewDecodeMaxSize` unset → `tier: "full"`).

### 3b. Findings with numbers

1. **4K-source decode is THE export bottleneck** (fixture: 32.8 s of 42.1 s). The export path
   decodes 4K HEVC at native 3840×2160 (`video-node.ts:100-102` tier "full") and then downscales
   to the 1080p output canvas at paint time (`drawImage` in `visual-node.renderVisual`). When the
   output canvas is smaller than the source, full-res decode work is partially wasted — see
   opportunity #1.
2. **Encoder is saturated on the all-1080p path** (2c): export encode bucket ≈ encoder ceiling.
   No app-side overhead worth chasing there (readback ≈0.05 ms/frame, paint ≈0.06 ms/frame).
3. **Sequential render→encode, no cross-frame overlap** (`scene-exporter.ts:133-145` on main):
   frame N+1's decode+paint doesn't start until frame N's `videoSource.add` await returns.
   mediabunny only blocks when `encodeQueueSize >= 4` (`media-source.js:444`), so the encoder
   queue does absorb some jitter — but the measured buckets show decode (32.8 s) and encode
   (4.9 s) are *serial* today on the fixture: overlapping them perfectly would hide
   min(decode, encode+paint) ≈ ~5–6 s of the 42 s (~13%). On the simple project the same overlap
   would hide the 0.26 s decode inside the 4.1 s encode (~6%). Modest but real; see opportunity #2.
4. **Audio mixdown is a serial pre-phase** (`renderer-manager.ts:128-136`): 0.76 s median
   (fixture) before the first video frame starts. Could run concurrently with the first frames;
   sub-second on this fixture, grows with audio-graph complexity.
5. **Per-frame progress `notify()`** (`project-manager.ts:225-228`): fires a store-wide notify
   every frame (810–900×/export). NOT isolated in this measurement (the harness called
   `renderer.exportProject` directly, bypassing `ProjectManager.export`'s callback), so its cost
   in the real UI flow is **unmeasured** here — flagged for a follow-up A/B; the phase buckets
   above are unaffected (they run below the callback).
6. **No composited-then-dropped frames in export** — verified: `realtime` drop policy is
   preview-only (`canvas-renderer.ts:9-15`; `SceneExporter` never sets it). Every frame is
   rendered exactly once; frame-exactness is intentional.
7. **Mux + BufferTarget**: finalize is 0.08 s (simple) / 0.46–2.12 s (fixture). Whole output is
   buffered in memory (`BufferTarget`), 20–23 MB here — fine at this size; would balloon for
   long/4K exports (8 GB machine caveat).

## 4. Ranked opportunities

| # | Opportunity | Measured evidence | Expected gain | Effort | Risk | Class vs native Metal | Verified prerequisites | Re-run to verify |
|---|---|---|---|---|---|---|---|---|
| 1 | **Cap export decode tier at output canvas size** (decode 4K sources at ≤1080p when exporting 1080p; keep full-res when output ≥ source or when a crop/zoom>1 samples beyond output density) | Fixture export: 32.8 s/42.1 s (78%) is full-res 4K HEVC decode; simple 1080p export decode is only 0.26 s. Seam already exists: `previewDecodeMaxSize`/tier plumbing in `video-node.ts:100-128` + `videoCache` sink tiers (prior art @75e7d287 — this *extends* the tier idea to export, it does not re-propose playback scaling) | Up to ~3–4× on 4K-source exports (decode scales ~with pixel count; 42 s → SPECULATIVE ~15–20 s, bounded below by the 4.9 s encode + ~1 s paint) | M | Output-quality parity needs care with crop/zoom/transform>1 elements (must fall back to full-res per element); otherwise output pixels identical (1080p is 1080p) | **CLOSABLE** (native VideoToolbox decoders do decode-at-target-res the same way) | None new — WebCodecs decode + existing tier seam, verified present | Re-run `run-export-bench.mjs` fixture project; expect decode bucket ≈÷4 |
| 2 | **Overlap frame N+1 decode/paint with frame N encode** (double-buffer canvas or start `prepare()` for N+1 before awaiting `add(N)`) | Buckets are serial today: fixture decode 32.8 s + encode 4.9 s + paint 1.0 s ≈ wall 40.5 s; encoder queue (depth 4, `media-source.js:444`) already absorbs sub-frame jitter but not the macro overlap | ~13% on fixture (hide ~5–6 s), ~6% on simple (hide 0.26 s) — becomes the *main* lever only after #1 lands (then decode≈8 s vs encode 5 s → overlap hides ~5 s of ~15 s ≈ 30%) | S–M | Needs a second canvas (CanvasSource binds one canvas — either two CanvasSources or copy-to-staging); cancellation and memory (+1 frame) manageable | CLOSABLE | None — pure JS restructuring | Same harness; expect wall ≈ max(decode, encode) + paint instead of sum |
| 3 | **Run audio mixdown concurrently with first video frames** | 0.76 s median serial pre-phase (fixture), `renderer-manager.ts:128-136` | ~0.7–1.3 s flat per export (2–3% here; more on long audio graphs) | S | Low — mixdown is independent of video loop; just `Promise.all` with a deferred `audioSource.add` | CLOSABLE | None | Same harness; `mixdownMs` should overlap wall, not add |
| 4 | **Throttle per-frame export progress notify** (`project-manager.ts:225-228` → every 4–8 frames) | UNMEASURED here (harness bypassed the callback); 810–900 store-wide notifies per export interleaved with the hot loop on the main thread | SPECULATIVE until measured in the real UI flow; likely small (encode awaits dominate) but free to take | S | None (progress bar still >4 Hz) | CLOSABLE | None | A/B with export driven through `project.export()` + React UI mounted, count renders via react-scan |
| 5 | **Pin `hardwareAcceleration`/`latencyMode` on export encode** | Measured **≈0 gain** on this machine (2c: hw/sw/no-pref all ~4.8 ms/frame) | ~0 on Apple Silicon; unknown on other platforms (SPECULATIVE) | S | Low | — (already at parity with native encoder throughput here) | Verified: all three prefs supported at 1080p | `encode-hw-vs-sw.mjs` on the target platform |
| 6 | **Cloud/hybrid export ("preview local, render in cloud")** | See §5: no server compositor exists (`export.py` is a single-input ffmpeg re-encode, its frontend client `ai-client.ts:1487` is dead code); source assets are NOT in R2 for local-only projects (upload cost §5a); local realtime ratio measured 0.149× (1080p sources) / 1.56× (4K-source) | For 1080p-source projects cloud can never win wall-clock (local is already 6.7× realtime; upload alone loses). For 4K-source projects: crossover exists but only with a GPU server & good uplink (§5c desk-math) | **L** (a compositor rewrite or headless-Chrome fleet) | High (parity burden or browser-fleet ops; new COGS on a currently-$0 path) | **STRUCTURAL** — this is the lever native-desktop Palmier cannot pull, but note opportunity #1 shrinks the local pain it would solve | R2 storage exists + content-addressed dedup (`cloud-media-storage.ts`); ai-backend :8420 exists; NO timeline renderer server-side (verified absent) | Prototype-level, not re-runnable today |

Ranking rationale: #1 dwarfs everything measured (78% of fixture wall); #2/#3 are cheap follow-ons;
#6 is strategically interesting but should be evaluated *after* #1, because #1 alone plausibly
brings 4K-source exports from 1.56× to ~0.6× realtime locally, gutting the wall-clock case for
cloud on typical projects (the remaining cloud case is battery/thermals/tab-must-stay-open UX +
>1080p outputs, not speed).

## 5. Cloud/hybrid export — honestly sized

### 5a. What would we upload

Local ingest does NOT auto-upload to R2 — `uploadMedia()` (`services/storage/cloud-media-storage.ts:103-152`)
is called only from VC/collab media sync (`app/api/version-control/media/route.ts`) and
AI-generation caching (`lib/studio/media-storage.ts`). A local-only project's sources live in
IndexedDB/Files client-side. R2 is content-addressed (SHA-256), so the 4× reused 1080p clip
uploads once.

Fixture project unique source bytes: 30,503,677 + 102,419,303 + 17,280,078 = **150.2 MB**.
Rendered-intermediate alternative (upload the *output* instead — i.e. local render + cloud store):
20.2 MB, but that defeats the purpose (render already happened locally).

| Uplink | Link-saturated upload time (150.2 MB) |
|---|---|
| 20 Mbps | ~60 s |
| 50 Mbps | ~24 s |
| 100 Mbps | ~12 s |

Floor, not prediction: excludes TLS/PUT overhead (3 objects), client-side SHA-256 hashing
(`computeHash`), and real-world uplink variance — all unmeasured, SPECULATIVE. Upload is per
unique asset per project *once* (dedup), so a second export of the same project uploads ~0.

### 5b. Server side: what exists vs what's missing

Exists: FastAPI ai-backend (:8420) with a mounted `/api/export/render` route
(`services/ai-backend/app/routes/export.py`, `main.py:86`) and a typed-but-**never-called**
frontend client (`ai-client.ts:1487-1490` `exportRender` — zero call sites in `apps/web/src`).
R2 storage + presigned GETs exist (`cloud-media-storage.ts:180-192`).

Missing — and this is the honest core: `export.py` takes a **single already-on-server file path**
and runs one ffmpeg scale/pad/trim re-encode. There is **no timeline model, no multi-track
compositor, no effects/transitions/text/keyframes server-side**, and no R2 download path feeding
it. 100% of Byorn's compositing lives in browser TypeScript (`services/renderer/nodes/*`,
`webgl-effect-renderer.ts`, ~20 GL transitions in `lib/transitions/`). Server export therefore
means either:

1. **Reimplement the compositor** (ffmpeg filter graphs / native) — large rewrite + permanent
   two-renderer parity burden (every new effect/transition/caption feature ×2), or
2. **Headless Chrome in the cloud** running the actual TS renderer — full code reuse, but needs
   GPU-attached instances for the WebGL effect/transition passes (SwiftShader would violate this
   audit's own validity bar), a Chrome build with proprietary codecs, and a browser-fleet ops
   surface (per-job lifecycle, crash recovery, scaling).

Both are infrastructure projects. SPECULATIVE, unbuilt, untimed.

### 5c. Cost & wall-clock crossover (desk-math, anchored on MEASURED local ratios)

Export today is **not credit-metered** (`lib/credits/cost-table.ts` has no export action) and
costs Byorn $0.00 COGS — cloud export creates a new cost line, not a shift. The credit doc's
$0.05–0.40/s rates (`docs/token-credit-system-plan.md:62-73`) are generative-model prices,
irrelevant to render compute; generic anchors (SPECULATIVE, list-price order of magnitude):
CPU 4-vCPU ≈ $0.003/min, T4-class GPU ≈ $0.006–0.009/min.

Wall-clock: `cloud = upload + queue + server_render + download` vs `local = ratio × T`.

- **All-1080p-source projects (measured ratio 0.149×):** local export of a 3-min timeline ≈ 27 s.
  Upload of its sources alone (≥150 MB-class) exceeds that on any realistic uplink. **Cloud never
  wins wall-clock for 1080p-source projects. Full stop.**
- **4K-source projects (measured ratio 1.56×):** local 3-min timeline ≈ 4.7 min. Cloud at
  100 Mbps + GPU server rendering at (SPECULATIVE) 0.3× realtime: ~12 s upload + ~54 s render +
  ~2 s download ≈ 68 s → cloud wins ~4×. At 20 Mbps: 60 s + 54 s + 8 s ≈ 2 min → still wins for
  T ≳ 80 s of timeline. BUT: if opportunity #1 (decode-tier cap) lands and brings local 4K-source
  exports to ~0.6× realtime (SPECULATIVE ~3–4× local speedup), the 100 Mbps crossover moves to
  T ≳ ~3 min and the 20 Mbps case becomes marginal. **Recommendation: land #1 first, then re-run
  this table with the new measured ratio before committing to cloud-export infrastructure.**
- Per-export server cost at the anchors: a 3-min-timeline 4K-source render at 0.3× ≈ 1 GPU-minute
  ≈ **$0.01 ≈ 1 credit** at the ledger's 1cr=$0.01 anchor — pricing is a non-issue vs generation
  costs; the issue is the build+ops, not the unit economics.

### 5d. Watermark/provenance parity

Exports watermark by default (`includeWatermark ?? true`, `renderer-manager.ts:151`; UI toggle
`export-button.tsx:364-376`). Drawn in `CanvasRenderer.drawWatermark()` (`canvas-renderer.ts:168-241`)
— pure Canvas2D (pill + logo bitmap + "Made with Byorn"). Headless-Chrome cloud export preserves
it for free (same code); a compositor rewrite must port it (small but real parity item). Measured
watermark cost is inside the paint bucket (≤1 ms/frame total paint incl. watermark) — negligible.

## 6. What could NOT be measured (and why)

- **Per-frame progress-notify overhead in the real UI flow** — harness invoked
  `renderer.exportProject` directly (deliberately, to isolate the render/encode pipeline);
  the `ProjectManager.export` → store notify → React re-render path needs a separate UI-mounted
  A/B (opportunity #4).
- **Real-world upload throughput** to R2 — no network-throttled run; §5a is a bandwidth floor.
- **Cloud render wall-clock** — nothing exists server-side to time (§5b); the 0.3× figure is an
  explicit SPECULATIVE anchor.
- **Which internal path (hw vs sw) Chrome's `no-preference` actually picks** during a live encode
  — `isConfigSupported` reports support, not the runtime choice; however 2c shows the choice is
  performance-irrelevant on this machine (all prefs ≈4.8 ms/frame), so the question is moot here.
- **Isolated watermark on/off delta** — bundled inside the ≤1 ms/frame paint bucket; not worth a
  dedicated run at this magnitude.
- **Windows/dGPU behavior** of opportunity #5 — different encoder stacks; out of scope on this Mac.
- Memory-pressure sensitivity: fixture run 2 (48.6 s, +15% over median) is consistent with 8 GB
  pressure (102 MB fixture + 4K decoder + encoder in flight); N=3 is too small to characterize
  the tail — noted as machine caveat, not a code finding.

## 7. Scripts / artifacts left in `$BENCH/axis-4/`

- `run-export-bench.mjs` — main harness (project construction + N=3 export runs + phase readback
  + GPU/WebCodecs probes). Re-run: build+serve the instrumented worktree
  (`cd /Users/zsha/Documents/ai-native-opencut-axis4-export/apps/web && bun run build:e2e &&
  PORT=3104 bun run start`), serve fixtures (`python3 $BENCH/axis-4/cors-server.py`), then
  `node run-export-bench.mjs http://localhost:3104 ./results.json`. (Fixture bytes go over a
  local CORS HTTP server — pushing 102 MB through CDP-evaluate base64 OOM-killed the page on
  this 8 GB machine.)
- `results.json` — raw run data (all numbers in §2a derive from it).
- `probe-4k.mjs` — corrected 4K/HEVC/VP9/AV1 `isConfigSupported` matrix (needs localhost origin;
  `VideoEncoder` is undefined on non-secure contexts).
- `encode-hw-vs-sw.mjs`, `videoframe-cost.mjs` — encoder-ceiling and readback micro-probes (§2c).
- `cors-server.py` — fixture static server (port 3199).
- `server.log` — worktree prod server log.
- Worktree `/Users/zsha/Documents/ai-native-opencut-axis4-export` (branch `axis4-export-bench`):
  the instrumented `e2e-bridge.tsx`, `scene-exporter.ts`, `canvas-renderer.ts`,
  `renderer-manager.ts`. NEVER merged; remove with `git worktree remove --force
  /Users/zsha/Documents/ai-native-opencut-axis4-export && git branch -D axis4-export-bench`
  once the audit is consumed.

LOCK discipline: acquired 22:56:20, released 23:06:54 JST (≈10.5 min, one acquisition); server +
Chrome instances killed before release; shared prod build untouched.

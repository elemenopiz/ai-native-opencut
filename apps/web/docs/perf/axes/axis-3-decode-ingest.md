# AXIS-3 (DECODE/INGEST) — Byorn Perf Audit 2026-07-14

## Header

- Machine: Apple M3, 8 cores, 8 GB RAM, macOS 26.3.
- Browser: Google Chrome 150.0.7871.115, `channel: 'chrome'` via Playwright
  (`@playwright/test@1.61.1`), **headed** for every timed run.
- GPU renderer (verified via `WEBGL_debug_renderer_info` / `UNMASKED_RENDERER_WEBGL`):
  `ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)` — real Metal
  GPU, not SwiftShader. Confirmed identical across every harness page load.
- `crossOriginIsolated`: `false`. `navigator.gpu` present: `true` (WebGPU
  available, unused by this axis). OPFS (`navigator.storage.getDirectory`)
  present: `true`. **Deploy config check**: `apps/web/next.config.ts` sets no
  `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` headers and
  there is no `vercel.json` adding them — `crossOriginIsolated:false` is a
  deploy-config fact, not just a browser default. (No SharedArrayBuffer need
  was found on this axis's code paths, so this is a note, not a finding.)
- Repo HEAD a2af6c7f. Build: shared prod e2e build at
  `$BENCH/prod-build.done` (built by axis-1, `bun run build:e2e`), reused as-is
  — I did not rebuild.
- Fixtures: `fixture-1080p30-h264.mp4` (30s 1920×1080@30 h264), `fixture-4k-hevc.mp4`
  (20s 3840×2160@30 hevc/hvc1), `fixture-audio-3min.wav` (180s PCM), all from
  the shared fixtures dir (paths in PROTOCOL.md).
- Date: 2026-07-14.

## Method note (read before the numbers)

Two measurement surfaces were used, both **exercising the real shipped
production source**, never a rewrite:

1. **Standalone harness** (`$BENCH/axis-3/harness/`) — a tiny static page
   (`bun`-served on port 5303, NOT the shared bench port range, no LOCK
   needed) that imports `mediabunny` plus **unmodified bundles of the actual
   shipped files**, built with `bun build --target=browser` straight from
   `apps/web/src` (no edits, just bundling for standalone execution):
   - `apps/web/src/services/video-cache/service.ts` (the real `VideoCache`
     class — prefetch ring, decode tiers, seek logic)
   - `apps/web/src/lib/media/normalize-media.ts` (the real probe +
     HEVC→H.264 transcode decision/execution)
   - `apps/web/src/services/proxy/proxy-generator.ts` (the real
     `generateProxy()`)
   These three files have **zero non-`mediabunny` dependencies**, so bundling
   them standalone is a lossless extraction, not a mirror/rewrite. This let me
   get high-N, low-noise measurements of the decode/cache/ingest core without
   paying Next.js build/server/UI-automation cost per run, and to avoid
   contending for the shared bench LOCK for most of this axis's work.
2. **Real running app** (shared e2e prod build, my assigned port 3103) — used
   for whatever standalone harness *cannot* answer honestly: the actual
   drop→ready UI flow (React state, `addMediaAsset`, `storageService`
   persistence) and cross-project reopen behavior. Gated behind the shared
   bench LOCK per protocol.

All `.ts` driver scripts and the harness itself are left in `$BENCH/axis-3/`
(paths listed at the end) so any of this can be re-run.

## 1. WebCodecs decode utilization

Verified at runtime (`VideoDecoder.isConfigSupported`) on a real page context
(note: WebCodecs globals are **not** exposed on `about:blank` in this Chrome —
had to navigate to a real origin first; recorded as a harness gotcha):

| Codec/res | hardwareAcceleration | supported |
|---|---|---|
| h264 1920×1080 (avc1.640028) | no-preference | true |
| h264 1920×1080 | prefer-hardware | true |
| h264 1920×1080 | prefer-software | true |
| hevc 3840×2160 (hvc1.1.6.L153.B0) | no-preference | true |
| hevc 3840×2160 | prefer-hardware | true |
| hevc 3840×2160 | **prefer-software** | **false (unsupported)** |

**Finding — the app never configures `hardwareAcceleration` at all.**
`grep -n decoderOptions` across `apps/web/node_modules/mediabunny` confirms
`CanvasSink`/`VideoSampleSink` both accept a `decoderOptions.hardwareAcceleration`
passthrough to `VideoDecoder.configure()`, but every call site in the app
(`apps/web/src/services/video-cache/service.ts:577-583`,
`apps/web/src/services/proxy/proxy-generator.ts` CanvasSink construction,
`apps/web/src/lib/media/processing.ts` VideoSampleSink construction) constructs
the sink with `{ poolSize, fit, ...outputSize }` only — **no `decoderOptions`
key anywhere in the app's mediabunny call sites.** That means every decode in
Byorn runs under WebCodecs' default `"no-preference"`, leaving the
hardware-vs-software choice entirely to the browser/OS heuristic.

Measured impact of that gap (decode-only throughput, `CanvasSink.canvases()`,
150 frames, `$BENCH/axis-3/harness/harness.html` → `decodeThroughput`,
`$BENCH/axis-3/run-ingest-proxy.log` / `run-harness.log`):

| Fixture | hardwareAcceleration | N | median fps | min–max fps | median firstFrameMs |
|---|---|---|---|---|---|
| 1080p30 h264 | no-preference | 3 | 579 | 133–918 | 14–589 (highly variable) |
| 1080p30 h264 | **prefer-hardware** | 3 | **949** | 914–1029 | 13–22 (stable) |
| 1080p30 h264 | prefer-software | 3 | 323 | 287–469 | 16–59 |
| 4K30 hevc | no-preference | 5 | 112 | 83–228 | 135–494 |
| 4K30 hevc | **prefer-hardware** | 5 | **309** | 258–359 | 24–95 |
| 4K30 hevc | prefer-software | — | **unsupported, N/A** | — | — |

Reading this: `no-preference` is not just "usually hardware" — its own runs
show 2-3x run-to-run swings (1080p: 133 vs 918 fps; hevc: 83 vs 228 fps) that
`prefer-hardware` does not exhibit (1080p: 914-1029, a tight band; hevc:
258-359). Explicitly requesting `prefer-hardware` bought ~2-3x more *and more
consistent* throughput on this exact machine. (8GB-RAM caveat: some of
`no-preference`'s variance likely reflects memory-pressure-driven fallback
decisions the browser makes silently — see the ring-stress section below for
a much sharper version of the same effect.)

## 2. Prefetch ring / decode tiers under stress

The shipped `VideoCache` (`apps/web/src/services/video-cache/service.ts`) —
`PREFETCH_RING_CAPACITY=4`, `SINK_POOL_SIZE=8` — bundled unmodified and driven
directly (not through the compositor) with N independently-keyed
`mediaId` sinks (6/12/20, mirroring "many distinct clips on the timeline";
the fixture mix per protocol was 1 HEVC-4K + (N-1) 1080p, all served via
`getFrameAt({ tolerateStale:true })` at a simulated 30fps tick, 12s runs — a
deliberate deviation from the nominal 30s, see below):

| N sinks | wall-clock ticks completed in 12s | effective tick rate | calls/sink-tick | p50 latency | p95 latency | max latency | slow calls (>16.7ms) | very-slow (>33.4ms) |
|---|---|---|---|---|---|---|---|---|
| 6 | 317 | ~26.4/s | 1902 | 0.2ms | 2.5ms | 178ms | 11 | 6 |
| 12 | 149 | ~12.4/s | 1788 | 0.1ms | 2.8ms | **1381ms** | 12 | 10 |
| 20 | 28 | **~2.3/s** | 560 | 0ms | 8.4ms | **1898ms** | 12 | 9 |

**This is not linear degradation.** 6→12 sinks (2x) costs ~2.1x tick-rate;
12→20 sinks (1.67x) costs **5.4x** tick-rate — a cliff, not a slope. The
`finalCacheStats` at each N show `activeSinks === totalSinks === N` (every
sink stayed alive/decoding; nothing gets evicted), and `p50`/`p95` latency
stay tiny even at N=20 (median call cost is ~free) while `max_ms` balloons
into the 1.3-1.9 SECOND range — i.e. most calls are fine but a small number
per run stall for over a second. That signature (steady low median, rare
huge-tail stalls, unrelated to per-call cost) matches concurrent hardware
decoder session contention or memory-pressure GC pauses rather than raw CPU
decode cost — 20 live `VideoDecoder` instances × up to 8 pooled canvases each
(1× 4K @ ~33MB/canvas + 19× 1080p @ ~8MB/canvas ≈ **~1.5GB** of canvas memory
alone) on an 8GB machine is a very plausible root cause, and this run also
independently reproduced a hard crash: the **first** attempt at n=12/n=20 in
the same page context as n=6 failed with `TypeError: Failed to fetch` — most
consistent with the tab (or the harness's own static server) getting
memory-pressured; retrying each N in a **fresh page context** made it
succeed. (See `$BENCH/axis-3/run-harness.log` for the crash, `run-stress-only.log`
for the fixed re-run.) This machine's 8GB RAM plus 6 other agents' concurrent
dev servers/builds during this run is a real confound — noted, not
hidden.

Deviation from the brief's ask: 30s runs at 3 clip counts × (implicitly) both
fixture-mix variants would be ~3-6 min of wall time per attempt, and the first
attempt's OOM-adjacent crash cost a retry; I used 12s runs to fit inside the
lock/time budget. The shape of the result (cliff between 12 and 20, not a
smooth line) is unlikely to be an artifact of the shorter window since it
shows up consistently in both the tick-rate collapse and the max-latency
blowup.

I did **not** get a real compositor-level (perfStats `framesSkipped`/
`longFrames`) confirmation with 20 independently-**ingested** clips in the
real app — see "what I could not measure."

## 3. Seek latency anatomy

Real `VideoCache.getFrameAt`, N=5 per fixture, fresh `VideoCache` instance per
run (`$BENCH/axis-3/run-harness.log`, `seekAnatomy`):

| Fixture | cold open (median) | near-seek +0.3s (median) | far-seek →15s, cold (median) | far-seek →2s backwards (median) | near-seek warm-ring (median) |
|---|---|---|---|---|---|
| 1080p30 h264 | 11.2ms (11.0-219.2, first-run JIT outlier) | **0.6-1.3ms** | 91.2ms | 41.5ms | **0.6-1.9ms** |
| 4K30 hevc | 33.0ms (26.7-105.3) | **0.6-15ms** (15ms first-run outlier, else ≤1.5ms) | **316.3ms** | 132.9ms | **1.3-2.5ms** |

Anatomy: a "near seek" (inside the 2s sequential window / already in the
4-frame ring — `SEQUENTIAL_WINDOW_SECONDS=2.0` in `service.ts`) costs ~1-2ms
**regardless of resolution** — the ring/serveCurrent fast path is doing
exactly its documented job. A "far seek" (outside the window — forces
`seekToTime`: iterator teardown, keyframe re-seek, forward decode to target)
costs ~91ms at 1080p and **~316ms at 4K HEVC** — roughly the same ~3.4x ratio
as the raw decode-throughput gap between the two fixtures (consistent: it's
decode-bound, not container/seek-bound). 316ms is solidly above the
~100-150ms threshold where a UI action reads as "stuck" rather than
"responsive" — scrubbing a 4K HEVC timeline far ahead of the current position
is the single most visible per-interaction cost this axis measured.

## 4. Proxy / preview-file strategy

**Persistent background proxies are NOT what's shipped, despite proxy
infrastructure already existing.** Code trail:
`apps/web/src/services/proxy/proxy-generator.ts` (`generateProxy()`, real
WebCodecs-based downscale+re-encode via mediabunny `CanvasSink`→`CanvasSource`)
is wired to exactly one call site,
`MediaManager.generateProxyForAsset` (`apps/web/src/core/managers/media-manager.ts:270`),
which is invoked **only** from a manual button in the asset settings panel
(`apps/web/src/components/editor/panels/assets/views/settings.tsx:286`). There
is no automatic/background trigger on ingest — `needsProxy()` exists
(`media-manager.ts:257`, true above `PROXY_THRESHOLD_WIDTH/HEIGHT` i.e.
>1920×1080) but nothing calls `generateProxyForAsset` off the back of it. So
today: decode-tier downscaling at *playback* time (fenced prior art) is the
only automatic path; there is no persistent, pre-computed lower-res file the
way every native NLE (including Palmier) builds proxies on ingest.

**Real bug found while measuring this** (not fixed — read-only per protocol):
`generateProxy()` at the shipped `"480p"` preset (`PROXY_PRESETS["480p"] =
{maxWidth:854, maxHeight:480}`, `apps/web/src/services/storage/types.ts:28`)
crashes on the 4K HEVC fixture. `3840×2160` scaled by
`min(854/3840, 480/2160, 1) = 0.22222…` yields `proxyWidth = round(3840 ×
0.22222) = 853` — an **odd** width — and the WebCodecs AVC encoder throws:
```
The dimensions 853x480 are not supported for codec 'avc'; both width and
height must be even numbers.
```
Reproduced deterministically (`$BENCH/axis-3/run-ingest-proxy.log`,
`480p-bug-repro`). `generateProxy()` never rounds to an even number before
constructing the encoder. `"720p"` (1280×720) and `"1080p"` presets happen to
land on even numbers for this fixture's aspect ratio, so only the smallest
preset is broken here — but the bug is in the scale-math, not the preset
table, so it can reproduce for other source resolutions/aspect ratios at any
preset. Flagged as a background task (`task_958000ac`, "Fix odd-dimension
crash in generateProxy() 480p preset") rather than fixed directly, per the
read-only mandate.

**Cost of what a proxy WOULD buy**, measured two ways:

- In-browser WebCodecs (the *existing*, already-shipped `generateProxy()`,
  unmodified, "720p" target since "480p" is broken): 20s @ 3840×2160 hevc →
  1280×720 h264, N=3: **2.02s / 2.19s / 2.62s** wall (median 2.19s, ~0.11x
  realtime). Output ~2.1MB.
- Server-side ffmpeg stand-in (`ffmpeg-static` v6.0, libx264 `veryfast`,
  software-only — this static build has no `--enable-videotoolbox`), same
  clip → 960×540 h264: N=3: **18.59s / 18.33s / 8.20s** wall (median 18.33s;
  `user` CPU time was a consistent ~25.6-27.4s across all 3 runs — the fast
  8.2s wall-time run had the same CPU cost, just less contention from other
  agents' concurrent processes on the shared machine).

**This is a real, counter-intuitive finding**: the already-shipped in-browser
WebCodecs proxy path is **~8-9x faster** than a naive software-ffmpeg
server-side proxy on this exact hardware, because Apple Silicon's hardware
video engine beats a software x264 `veryfast` encode by a wide margin. A
*hardware*-encoding server path (VideoToolbox on macOS infra, or NVENC) would
likely close most of that gap, but the numbers as shipped say: turning on
automatic background proxy generation via the **existing, already-built**
`generateProxy()` is cheap (~2.2s for a 20s clip) and does not require
building a server transcode pipeline at all.

## 5. Ingest pipeline throughput

**This is the single biggest number in this report.** Real end-to-end
`processMediaAssets()` behavior (probe → decide → transcode-if-needed →
`getVideoInfo` → thumbnail), measured via an unmodified bundle of
`normalize-media.ts` + inline mirrors of `getVideoInfo`/`generateThumbnail`'s
mediabunny calls (`$BENCH/axis-3/run-ingest-proxy.log`, `ingestStages`, fresh
page per run). Caveat: my harness folds `getVideoInfo`'s own
Input-open+track-metadata read into the `thumbnail` bucket rather than timing
it as its own stage the way `processing.ts` does (it calls `getVideoInfo` and
`generateThumbnail` as two separate mediabunny `Input`s) — this is a
methodological simplification, not a different code path, and `getVideoInfo`
is metadata-only (no full decode), so it should add at most a few ms, not
change the dominant-stage conclusion below:

| Fixture | N | probe | decision | transcode | thumbnail | **total** |
|---|---|---|---|---|---|---|
| 1080p30 h264 | 3 | 3.7-17.3ms | passthrough | — (skipped) | 26-125ms | **30-142ms** (median ~32ms) |
| 4K30 hevc | 3 | 3.7-8.7ms | **transcode** | **10.9-11.5s** | 79-185ms | **11.0-11.5s** |

The transcode stage is **>99% of total ingest time** for the HEVC fixture and
dwarfs everything else in the pipeline by 2-3 orders of magnitude. Root cause,
confirmed by reading `apps/web/src/lib/media/normalize-media.ts:42-49`:
`PORTABLE_VIDEO_CODECS` contains **only** `"avc"` — `decideNormalization()`
transcodes **every** non-h264 codec unconditionally, *even when
`probe.decodable` is already `true`* (i.e. even when this exact browser can
decode HEVC directly — which §1 showed it can, with hardware support). The
transcode re-encodes at **source resolution** (`normalizeVideoFile`,
`normalize-media.ts:143-148`: `video:{codec:"avc", bitrate: QUALITY_HIGH}`, no
scale) via mediabunny `Conversion` (WebCodecs decode → re-encode), producing a
56,575,291-byte (~54MB) H.264 file from the 98MB HEVC source, taking ~11s wall
for a 20s clip (~0.55x realtime — better than the ffmpeg software baseline in
§4 since this is a full-resolution 1:1 transcode using hardware decode+encode
via WebCodecs, not a downscale, but still >10s of blocking work per HEVC
import). Earlier runs (before other agents' load eased) showed 19.2-19.9s for
the same operation — **2x variance tied to concurrent machine load**, an
important caveat for anyone re-running this.

Every call site of `processMediaAssets` (`grep` found 9: the assets panel,
YouTube export panel, paste-media, 4 studio add/generate flows, timeline
drag-drop) pays this same tax — it is not a one-off UI path.

**Main-thread jank during ingest**: not independently re-measured with a
fresh `longtask` census in this pass (script for it — `run-real-app.ts`,
`uploadAndTime()` — installs a `PerformanceObserver('longtask')` before
upload and is ready to run; it was queued behind the shared bench LOCK and I
ran out of time to execute it — see "what I could not measure"). What IS
confirmed by code inspection: `processMediaAssets` (`processing.ts:224`) is a
plain `for...of` loop with `await` on each stage, on the **main thread** — no
`Worker` offload anywhere in the ingest path (confirmed no `new Worker(`
reference near `processing.ts`/`normalize-media.ts`; mediabunny's `Conversion`
API runs its WebCodecs encode/decode pair directly on the calling context, and
`processMediaAssets` calls it from the React event-handler thread, i.e. the
main thread). An 11-second synchronous-ish `await` chain with WebCodecs
callbacks firing on the main thread is a strong prior for visible jank (spinner
freezes, scroll janks) during HEVC ingest — this sizes the "ingest worker
offload" follow-up as high-value: an 11-second, main-thread-adjacent block is
large enough that even partial offload (e.g. only the transcode step, via a
dedicated Worker running its own mediabunny `Conversion` against a
`Transferable`/`OffscreenCanvas`) would measurably improve perceived
responsiveness during import, independent of any effect on total ingest wall
time.

## 6. Thumbnail + waveform cost, and reopen behavior

**Thumbnail** (video-frame thumbnail, `generateThumbnail`/`generateThumbnails`
in `processing.ts`, `VideoSampleSink.samplesAtTimestamps`): 26-185ms per clip
(see §5 table, `thumbnailMs` column) — cheap, single-frame grab, not a
bottleneck. Read the full persistence path
(`storageService.saveMediaAsset`, `apps/web/src/services/storage/service.ts:320-348`):
the `MediaAssetData` metadata record written to IndexedDB includes
`thumbnailUrl`, `width`, `height`, `duration`, `proxy`, `needsProxy`, etc.
verbatim alongside the file blob — so by code inspection this should NOT need
to be recomputed on reopen (I could not get a live browser-driven reopen run
in — see below — so "no recompute on reopen" is a strong code-level
inference, not a live-measured confirmation).

**Waveform is a different story — code-confirmed, no live cache exists.**
`apps/web/src/components/editor/panels/timeline/audio-waveform.tsx`: for an
uploaded (non-library) audio clip, the component calls
`newWaveSurfer.load(audioUrl)` (line ~104) on **every mount**, and WaveSurfer.js
does its own fetch+decode+peaks internally — there is no cache keyed by
mediaId/content-hash anywhere in this component or its callers. Since
`audioUrl` is a fresh `URL.createObjectURL()` per session (blob URLs don't
survive reload), this fetch+decode+peaks sequence reruns from scratch **on
every mount**, including every project reopen and (depending on whether the
timeline virtualizes/remounts elements on scroll — not verified) potentially
more often than that.

I measured the underlying cost directly (fetch + `decodeAudioData` + a
faithful copy of `extractPeaks()`'s min/max bucket scan from
`audio-waveform.tsx`, real `fixture-audio-3min.wav`, N=5, fresh page each run,
`$BENCH/axis-3/run-waveform.log`):

| stage | median | min-max |
|---|---|---|
| fetch (16MB WAV, localhost) | 28ms | 24-38ms |
| `decodeAudioData` | 42ms | 33-59ms |
| peaks scan (512 buckets × 2 channels) | 12.8ms | 10-30ms |
| **total per mount** | **~83ms** | **70-115ms** |

For this WAV fixture (already-PCM, cheap to decode) the absolute cost is
modest, but it is a **needless, uncached, recurring** cost that would scale
much worse for compressed audio (MP3/AAC podcasts, the common real case) —
`decodeAudioData` on a compressed multi-minute file costs meaningfully more
than PCM. Caching peaks (keyed by mediaId, computed once, persisted like
`thumbnailUrl` already is) is a small, well-scoped, low-risk fix.

## What I could NOT measure (honest gaps)

- **Real-app end-to-end ingest timing via the actual upload UI**
  (drop→ready through React state / `addMediaAsset` / IndexedDB persistence),
  and a fresh `longtask` census during that upload — script is written and
  ready (`$BENCH/axis-3/run-real-app.ts`), but it needs the shared bench LOCK
  (port 3103) and I could not get a turn before running out of time budget for
  this pass. The harness-level numbers in §5 are a lower bound (no React
  overhead, no IndexedDB write, no `addMediaAsset` optimistic-update path) —
  the real UI number will be equal or higher, never lower.
- **Reopen-cache verification with a live browser** (does `VideoDecoder`
  actually get reconstructed on project reopen with no user interaction; does
  the persisted `thumbnailUrl` actually skip a redecode) — same script, same
  blocker. The thumbnail persistence claim in §6 is code-inspection only, not
  live-verified.
- **Compositor-level (perfStats `framesSkipped`/`longFrames`/`avgDecodeMs`)
  numbers with 20 independently-ingested real clips on the real timeline** —
  the ring-stress numbers in §2 are at the `VideoCache` layer (real class,
  synthetic driver), not cross-checked against the actual render loop's
  frame-skip counters. Given the ~11s-per-HEVC-clip ingest cost from §5,
  ingesting 20 distinct real clips to build that timeline is itself a
  multi-minute setup cost I did not have budget for in this pass.
- I did not verify whether the timeline virtualizes/remounts `AudioWaveform`
  on scroll (which would multiply the §6 recurring cost) — stated as an open
  question, not a claim.
- 4K HEVC numbers throughout carry real, measured, sometimes 2x run-to-run
  variance that tracks with how many other axis-agents were concurrently
  building/running on the same 8GB machine — every 4K number in this report
  should be read as "this order of magnitude, on a contended machine," not a
  precise constant.

## Ranked opportunities

| # | Opportunity | Measured evidence | Expected gain | Effort | Risk | Class | Prerequisites (verified) | Re-run recipe |
|---|---|---|---|---|---|---|---|---|
| 1 | **Stop unconditionally transcoding decodable HEVC on ingest** (skip §5's 11s tax when `probe.decodable===true`, e.g. play back HEVC directly via WebCodecs like the video-cache already does, or only transcode for the ~subset of browsers that truly can't decode it) | §5: 11.0-11.5s (up to 19.9s under load) transcode cost, 99%+ of total ingest time, for a codec THIS exact browser can already hardware-decode (§1: hevc prefer-hardware supported:true) | Cuts HEVC ingest from ~11s to ~<200ms (probe+thumbnail only) on any browser where `canDecode()` is true — the large majority of the current cost, disappears | M (touches `decideNormalization`'s policy + downstream assumption that all playable video is h264; needs a fallback path for browsers where hevc decode really is unsupported) | Medium — some downstream code may assume all ingested video is h264/AAC (export mixdown, thumbnailing paths) and needs auditing before loosening this | STRUCTURAL for browsers that can't decode HEVC at all (still need a transcode/server fallback there); CLOSABLE for the common case (this exact Chrome/macOS config, and Safari, which both hardware-decode HEVC) | `run-ingest-proxy.ts` → `ingestStages()`, before/after on `fixture-4k-hevc.mp4`, N≥3 |
| 2 | **Turn on automatic background proxy generation using the already-shipped `generateProxy()`** | §4: existing WebCodecs `generateProxy()` costs only ~2.2s median for a 20s 4K clip (720p target) — 8-9x cheaper than a naive server-side ffmpeg path, and the infra (storage, MediaAsset.proxy field, UI hook) already exists, just not auto-triggered | Gives scrub/preview at proxy resolution instead of full 4K decode tiers — directly answers the "does every native NLE have proxies" gap; expected win sizes to roughly the 1080p-vs-4K gap seen in §1/§3 (e.g. far-seek 316ms→~91ms-class numbers) but NOT independently re-measured end-to-end through the compositor — labeled SPECULATIVE for the playback-side number, MEASURED for the generation cost | S (wire `needsProxy()` → `generateProxyForAsset()` automatically post-ingest, background/idle-priority) | Low — reuses existing, already-tested code path; main risk is #4's crash below if triggered at "480p" | CLOSABLE | `run-ingest-proxy.ts` → `proxyGenCost()`; then re-measure §3's seek anatomy against the generated proxy file instead of the raw 4K source |
| 3 | **Fix `generateProxy()`'s odd-dimension crash at the "480p" preset** | §4: reproduced deterministically — `853×480` (odd width) rejected by the AVC encoder for this exact fixture's aspect ratio | Removes a real crash that currently makes the smallest/cheapest proxy tier unusable for some sources | S (round `proxyWidth`/`proxyHeight` to even numbers in `proxy-generator.ts`'s scale math before constructing `CanvasSource`) | Low | CLOSABLE (pure bug fix, no tradeoff) | none | `run-ingest-proxy.ts` → `proxy480pBugRepro` block; assert no error |
| 4 | **Explicitly set `decoderOptions.hardwareAcceleration:"prefer-hardware"`** on the `CanvasSink`/`VideoSampleSink` constructions in `video-cache/service.ts`, `proxy-generator.ts`, `processing.ts` | §1: prefer-hardware gave ~2-3x higher AND far more consistent throughput than the current default (`no-preference`) on both fixtures | 1080p: ~580→~950fps median (+64%), tighter variance (287-918 → 914-1029 range); 4K: ~112→~309fps median (+176%) | S (one-line `decoderOptions` addition at 3 call sites) | Low — `isConfigSupported` already confirms both codecs support `prefer-hardware`; only risk is a device/browser combo where hardware decode is flakier than software (rare, worth a try/no-preference fallback) | CLOSABLE | `run-harness.ts` → `decodeThroughput()` with `hwAccel` swapped at those 3 call sites (requires a worktree edit + rebuild, not just the standalone harness) |
| 5 | **Investigate/cap concurrent `VideoDecoder` sink count** (decoder pool ceiling, or dispose-on-not-visible for off-screen timeline clips) | §2: non-linear throughput cliff between 12 and 20 concurrent sinks (tick-rate collapses 5.4x for only 1.67x more sinks; max per-call latency hits 1.3-1.9s) | Would flatten the N=20 cliff back toward the N=6/12 slope — SPECULATIVE on exact number without a fix prototype, but the cliff shape strongly implicates a resource-contention ceiling that a pool/eviction policy would address | M (needs a policy: e.g. LRU-dispose sinks for clips far outside the current viewport/playhead, or a hard concurrent-decoder cap with graceful degradation) | Medium — must not regress the "warm ahead of playhead" behavior that `VideoCache.warm()` already provides | MITIGABLE (structural limit is real hardware decoder session limits, but a smarter eviction policy can push the cliff much further out) | S (partial — 8GB RAM is a real ceiling for THIS machine; better on 16GB+/ real users' hardware, worth re-testing on a higher-RAM machine) | `run-stress-only.ts`, N=[6,12,20,28...] sweep, fresh page per N |
| 6 | **Cache waveform peaks per mediaId** (persist alongside `thumbnailUrl`, compute once) | §6: 70-115ms recomputed on every `AudioWaveform` mount for a cheap PCM WAV; code-confirmed zero caching in `audio-waveform.tsx` | Removes a fully redundant recurring cost; bigger win on compressed audio (not measured — WAV was the only audio fixture) | S-M (compute once in the ingest pipeline like the thumbnail already does, store peaks array in the persisted `MediaAsset`, feed `AudioWaveform`'s already-supported `audioBuffer`-shaped fast path) | Low | CLOSABLE | none | `run-waveform.ts`, before/after on a compressed-audio fixture (not yet in the shared fixture set) |
| 7 | **Ingest worker offload for the transcode/probe stage** | §5: `processMediaAssets` is a synchronous `for...of`+`await` loop with no `Worker` in the call chain; an 11s (up to 19.9s) WebCodecs transcode runs in the main JS context during HEVC ingest | SPECULATIVE on user-visible jank magnitude (I did not get the `longtask` census run in — script ready, see gaps) but sizes as high-value given #1 above may shrink this same cost by ~50-100x for the common decodable-HEVC case; if #1 lands, this follow-up's urgency drops sharply (nothing 11s-long left to move off-thread for the common path) — recommend sequencing #1 before investing in this | L (Worker + mediabunny in worker context + Transferable file handling + progress messaging) | Medium | STRUCTURAL (would still matter for genuinely non-hardware-decodable sources) | `run-real-app.ts` → `uploadAndTime()`'s `longtask` collector (written, unrun) |
| 8 | **Server HEVC fallback** (for browsers where `canDecode()` is false) | Confirmed: no server-side transcode route exists at all today (`grep -rln ffmpeg apps/web/src/app/api apps/web/src/lib` → empty); `@ffmpeg/core`/`@ffmpeg/ffmpeg`/`@ffmpeg/util` are in `package.json` but **zero import sites** in `src` (dead dependency, 0 bytes even in `node_modules` — already not installed) | N/A directly, but this axis's ffmpeg-static server-side proxy timing (§4: ~8-19s wall / ~26s CPU for a 20s 4K clip on software libx264 veryfast) is a reasonable stand-in lower bound for "how expensive would a server transcode route be" | L (net-new server route + job queue + storage handoff) | Medium-High (new infra, cost/latency for users on unsupported browsers) | STRUCTURAL | none blocking | ffmpeg timing in this report; `du -sh node_modules/@ffmpeg` confirms it's already prunable dead weight independent of this decision |

## Scripts left in `$BENCH/axis-3/`

- `decode-capability.ts` — standalone `VideoDecoder.isConfigSupported` +
  GPU-renderer + `crossOriginIsolated`/`navigator.gpu`/OPFS check.
- `harness/` — static server (`serve.ts`, port 5303) + `harness.html` (all
  in-browser test functions) + unmodified `bun build --target=browser`
  bundles of the real `video-cache/service.ts`, `normalize-media.ts`,
  `proxy-generator.ts`, and a raw-mediabunny re-export (`mb-entry.ts` →
  `mediabunny-bundle.js`). Fixture files are symlinked in, not copied.
- `run-harness.ts` — decode-throughput hw-accel sweep + seek anatomy + first
  (crashed) ring-stress attempt. Log: `run-harness.log` (+`run-harness-run1.log`,
  the pre-fix HEVC-prefer-software-crash attempt, kept for the record).
- `run-stress-only.ts` — the fixed, fresh-page-per-N ring-stress retry
  (n=12/20). Log: `run-stress-only.log`.
- `run-ingest-proxy.ts` — ingest-stage attribution (probe/transcode/thumbnail)
  + proxy-generation cost + the 480p bug repro. Log: `run-ingest-proxy.log`
  (+`run-ingest-proxy-run1.log`, the pre-fix 480p-crash attempt).
- `run-waveform.ts` — waveform fetch/decode/peaks cost. Log: `run-waveform.log`.
- `run-real-app.ts` — **written but not executed** (blocked on shared LOCK
  contention/time budget): real-UI ingest timing with `longtask` census, warm
  vs cold, and a reopen-cache test with `AudioContext.decodeAudioData` /
  `VideoDecoder` constructor instrumentation via `page.addInitScript`. Left
  in place for whoever picks this up next (or a follow-up pass).
- `proxy-960x540.mp4` — the ffmpeg-static-generated proxy stand-in used for
  the §4 server-side timing comparison.

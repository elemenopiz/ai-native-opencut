# AXIS-1 — Baseline & Budgets

Byorn perf audit, 2026-07-14. Repo HEAD `a2af6c7f`.

## 1. Header

- Machine: Apple M3, 8 cores, 8 GB RAM (shared with up to 6 other concurrent
  measurement agents this session — real, observed contention: 26+ Chrome
  processes at peak, disk dropped from 24 GiB to 19 GiB free, one `LOCK`
  acquisition stalled ~35 min waiting for other axes), macOS 26.3.
- Browser: Google Chrome 150.0.7871.115 (`channel: 'chrome'` via Playwright
  1.61.1, **not** bundled Chromium), headed (never headless — protocol
  requires this for real rAF/GPU).
- GPU renderer (verified at runtime, `WEBGL_debug_renderer_info`):
  `ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)` — real
  Metal backend, not SwiftShader.
- Platform capabilities (verified at runtime, not recalled):
  `navigator.gpu` (WebGPU) = **true**; `crossOriginIsolated` = **false**;
  `SharedArrayBuffer` = **false** (COOP/COEP not set on this build/deploy —
  SAB-dependent code paths are unavailable); `navigator.storage.getDirectory`
  (OPFS) = **true**; `navigator.ml` (WebNN) = **false**;
  `VideoEncoder.isConfigSupported({codec:'avc1.640028', hardwareAcceleration:
  'prefer-hardware'})` = **true** (HW H.264 encode available).
- Build: `bun run build:e2e` (`NEXT_PUBLIC_E2E=1`), served via `bun run start`
  on port 3101 (shared `$BENCH/prod-build.done` image, not rebuilt). Item 7
  (real export) required a **separate non-e2e build** — see §7.
- Date: 2026-07-14.
- Fixtures: `fixture-1080p30-h264.mp4` (30s 1920×1080@30 H.264+AAC, 29 MB),
  `fixture-4k-hevc.mp4` (20s 3840×2160@30 HEVC+AAC, 98 MB, "GoPro" fixture),
  `fixture-audio-3min.wav` (180s stereo PCM, 16 MB).

## 2. Numbers table

All timings are wall-clock unless noted "in-page" (measured with
`performance.now()` inside the browser via `page.evaluate`, avoiding Node/CDP
IPC jitter — used for scrub and edit-op latency, which are sub-100ms).

| # | Metric | Median | Min–Max | N | Cold/Warm | How measured |
|---|---|---|---|---|---|---|
| 1 | Cold load → editor interactive (TTI) | **1091 ms** | 620–3709 | 5 | Cold (fresh browser process/profile per run) | Node stopwatch: `page.goto('/editor/<id>')` → `window.__BYORN_E2E__.ready===true` AND `[data-testid=export-open]` visible |
| 1 | Warm reload → editor interactive (TTI) | **254 ms** | 230–466 | 5 | Warm (same context, `page.reload()`) | same condition as above |
| 2 | Project open (existing project, 1080p clip already on timeline) → timeline rendered | **1294 ms** | 880–1707 | 5 | Warm (same browser, repeated close/reopen nav) | nav start → `[data-testid=timeline-element]` visible |
| 2 | Project open → canvas first frame painted | **1215 ms** | 870–1669 | 5 | Warm | nav start → largest `<canvas>` has a non-black pixel (raced concurrently with the timeline-DOM check, both timed from the same nav start) |
| 3 | Clip drop (1080p H.264) → asset ready | **81 ms** | 78–289 | 5 | — | file-input `setInputFiles` → `editor.media.getAssets().length` increments |
| 3 | Clip drop (1080p) insert → canvas repainted | **70 ms** | 18–150 | 5 | — | `insertElement()` call → canvas non-black-pixel change |
| 3 | Clip drop (1080p) drop → canvas painted (total) | **281 ms** | 158–472 | 5 | — | sum of the above + IPC |
| 8 | 4K HEVC ingest (drop → asset ready) | **18943 ms** | 12045–19892 | 3 | — | same as above; **seam = transcode** (confirmed via `asset.normalized.originalCodec === "hevc"`, not just a toast) |
| 3/8 | 4K HEVC insert → canvas painted | **407 ms** | 212–469 | 3 | — | insert → canvas repaint (post-transcode, already-decodable file) |
| 4 | Scrub latency: `playback.seek()` → next committed compositor frame | **25.0 ms** | 14.2–117.8 | 20 | — | in-page: `performance.now()` before `seek()`, resolved when `perfStats.getStats().framesRendered` increments (rAF-polled) |
| 6 | Split-at-playhead: command call → store updated | **0.5 ms** | 0.3–0.7 | 5 | — | in-page, `splitElements()` call duration |
| 6 | Split → next paint | **34.7 ms** | 32.5–1070.8† | 5 | — | in-page, store-update → canvas repaint |
| 6 | Move clip: store updated | **0.4 ms** | 0.3–0.5 | 5 | — | in-page, `updateElementStartTime()` |
| 6 | Move → next paint | **50.1 ms** | 46.0–55.5 | 5 | — | |
| 6 | Trim edge: store updated | **0.6 ms** | 0.4–0.7 | 5 | — | in-page, `updateElementTrim()` |
| 6 | Trim → next paint | **33.3 ms** | 28.6–46.2 | 5 | — | |
| 5 | Playback fps sustained, THE fixture project | **NOT OBTAINED** | — | 0/6 attempts | — | blocked by a reproducible crash — see §3 |
| 7 | Export wall-time vs realtime | **NOT OBTAINED THIS SESSION** | — | — | — | blocked by lock contention on the required separate non-e2e build — script + worktree ready, see §7 |

† Split's first 2/5 runs (each on a **newly-created track**, first element on
that track) took 1070.8 ms and 533.3 ms; runs 3–5 (same pattern, later
tracks) took 32.5–34.7 ms. Consistent with a one-time per-track/first-decode
warm-up cost (video decoder/pipeline init), not steady-state split cost — the
median already reflects the warm state; the warm-up itself is a distinct,
worth-noting cost (see opportunities).

Cited (not measured by AXIS-1, from PROTOCOL.md's prior-art fence, @75e7d287):
playback compositor throughput last measured **28.4 fps at a 30 fps target,
2.2 ms avg frame**. Re-verifying this under THE fixture project's full load
(4K HEVC + effects + transition + 3 tracks) is exactly what item 5 was meant
to add and could not, this session — see §3.

## 3. Major finding: reproducible editor crash on media import (blocks item 5)

**This is the headline finding of this baseline pass.** While scripting THE
fixture project (per protocol: ≥3 tracks, ≥6 clips, 4K HEVC, text,
transition, effect chain, 3-min audio), importing media reproducibly crashed
the editor to its React error boundary ("The editor hit an unexpected
error") — **6/6 attempts** once it started occurring, across every
combination tried:

- 1080p + 4K HEVC + 3-min audio (3 attempts)
- 1080p + 4K HEVC only, no audio (1 attempt)
- 1080p only, with a 20s idle "settle" window after import (1 attempt)
- 1080p only, **zero idle wait**, crash at ~720 ms post-import (1 attempt)

Console error (identical stack every time):
```
TypeError: Cannot read properties of undefined (reading 'paddingX')
    at l.element (.../22a283e06b69b907.js:138:169768)
    at wp (.../22a283e06b69b907.js:138:170886)
    at canvasRef (.../22a283e06b69b907.js:138:173827)
    ...React render internals...
```
Screenshot of the resulting error-boundary screen: `$BENCH/axis-1/crash-screenshot.png`.

**Code responsible (by symbol name in the stack, matched to source):**
`src/services/renderer/nodes/text-node.ts:372-376` —
```ts
const bg = this.params.background;
const resolvedBackground = {
  ...bg,
  color: resolveColorAtTime({ baseColor: bg.color, ... }),
  paddingX: resolveNumberAtTime({ baseValue: bg.paddingX ?? DEFAULT_TEXT_BACKGROUND.paddingX, ... }),
  ...
```
reads `.paddingX` (and other fields) off a `background` object that some
text-like render node received as `undefined`/malformed. This node type is
built somewhere in the render tree for a project that has **only imported
media, no user-created text element** in 4 of 6 repros — so it is not the
explicit text element I scripted; the most likely source, given the
`onnxruntime` console warnings that fire in the same window (CLIP embedding
indexing — `src/hooks/use-embedding-indexer.ts`, which "watches the media
manager and indexes any newly-added video/image assets" unconditionally on
every import), is a UI element driven by that pipeline (e.g. a
duplicate/similar-media badge or an auto-generated overlay) rather than the
compositor's own text-node path being hand-fed bad data.

**Not fully root-caused** — genuinely isolating this needs either a
source-level bisection (disable `useEmbeddingIndexer`, re-test) or a
DevTools breakpoint session, both out of scope for a read-only measurement
pass. Two honest candidate explanations remain open:
1. A latent bug in a CLIP-indexing-driven or duplicate-detection-driven UI
   component that renders once certain (possibly cross-project/cross-session,
   Postgres-backed "user-media memory" per this repo's own docs) state exists
   — consistent with it NOT reproducing in my own earlier scripts (01–04, 06:
   20+ combined single-1080p imports, zero crashes) and then reproducing
   100% of the time once it started, ~40 minutes into the session.
2. System resource exhaustion on the shared 8 GB machine (peak 26+ Chrome
   processes across 7 concurrent audit agents) corrupting some in-page state
   (e.g. a starved WebGL context, a failed IndexedDB write silently returning
   malformed data) — also consistent with the timing.

Either way: **this is a real, currently-reproducible crash, not a
measurement artifact** — the screenshot and console stack are genuine
browser output, not a script bug (confirmed by cross-checking against 20+
prior clean imports earlier in the same session using materially identical
code paths). It directly blocked item 5 (no clean fixture-project fps run
was obtainable) and would block any real user who hits the same trigger
mid-session. Recommend a follow-up debugging pass (not in this agent's
scope) starting from `use-embedding-indexer.ts` and whatever UI subscribes to
its output.

## 4. Proposed "native feel" budgets vs status

Budgets are my proposal for this audit; "native" reference is Palmier Pro /
general 60fps-native-app expectation, cited qualitatively (no public Palmier
timing numbers found), not measured.

| Interaction | Proposed budget | Measured | Status |
|---|---|---|---|
| Warm TTI | < 1000 ms | 254 ms median (230–466) | Green |
| Cold TTI | < 3000 ms | 1091 ms median, but 3709 ms worst-case (first-ever launch in a session) | Yellow — steady-state is green, but the outlier needs explaining (see opportunities) |
| Project open (existing, 1 clip) | < 1500 ms to first frame | 1215–1294 ms median | Yellow — inside budget on median but close to it, and this is a **1-clip** project; scaling to THE fixture project's ~6-7 clips is unmeasured (blocked, §3) |
| Clip drop (1080p) → visible frame | < 500 ms | 281 ms median (158–472) | Green |
| 4K HEVC ingest (drop → ready) | < 5000 ms (soft; transcode is inherently heavy) | 12–20 s | Red — 3-4x over even a generous budget; this is the transcode-seam cost, not a rendering bug (see opportunities) |
| Scrub latency | < 50 ms | 25.0 ms median, but 117.8 ms worst-of-20 | Yellow — median is green, tail is not; ~15-20% of samples exceeded 50ms |
| Edit-op (split/move/trim) store update | < 16 ms | 0.4-0.6 ms | Green (trivially) |
| Edit-op → next paint | < 50 ms | 33-50 ms median | Green (move at 50.1ms is right at the line) |
| Playback fps (THE fixture project) | ≥ 24 fps sustained, no more than 5% very-long frames | **unmeasured** | Grey / unmeasured (blocked, §3) — prior art cites 28.4fps@30fps-target/2.2ms avg frame on a simpler scene (@75e7d287), not re-verified under full fixture load |
| Export wall-time / realtime ratio | < 2.0x for `quality:high` | **unmeasured** | Grey / unmeasured this session (§7) |

## 5. What could not be measured, and why

- **Playback fps sustained on THE fixture project (item 5)** — blocked by
  the crash in §3. No amount of retrying within the lock window produced a
  clean run once the crash onset began (~40 min into the session).
- **Export wall-time vs realtime ratio (item 7)** — the shared prod-e2e
  build permanently stubs `renderer.exportProject` (see
  `e2e-bridge.tsx`; `NEXT_PUBLIC_E2E` is a **build-time** constant, so it
  stubs export for every session on that build, not just Playwright-driven
  ones). Real export requires a separate non-e2e build. I prepared this in
  its own git worktree (`/Users/zsha/Documents/ai-native-opencut-axis1-export`,
  detached at `a2af6c7f`, `.env.local` copied, `node_modules` symlinked to
  skip a redundant `bun install`) and wrote the driver script
  (`$BENCH/axis-1/07-export-real.js`, drives the real UI: file-input import →
  hover "+" add-to-timeline → Export → Export, completion detected via
  Playwright's `download` event on the real `downloadBuffer()` call). I did
  **not** get a lock window free long enough to run the build + test — this
  session had heavy, sustained contention from up to 6 other concurrent
  agents (one wait alone spanned ~35 minutes). The script is ready to run
  standalone: `cd apps/web && bun run build` (no E2E flag) `&& PORT=3101 bun run start`,
  then `node $BENCH/axis-1/07-export-real.js`.
- **Real mouse-drag scrub cross-check** — attempted as a secondary
  validation of the primary (in-page `seek()`-based) scrub number, but the
  Node-timed result (5178 ms, n=1) is almost certainly an artifact of a bad
  element locator / wait condition, not a real measurement — I did not have
  time to debug it and have excluded it from the reported numbers (see
  `04-scrub-latency.js`'s own "informal" labeling in its output).
- **`crossOriginIsolated` / SharedArrayBuffer prerequisite** — confirmed
  **false** on this deploy (no COOP/COEP headers), meaning any future
  SAB-dependent optimization (e.g. certain WASM threading strategies) is not
  currently available without a `next.config`/`vercel.json` header change.
  Flagging as context, not a bug — noted per protocol's platform-capability
  verification rule.

## 6. Ranked opportunities

| Opportunity | Evidence | Expected gain | Effort | Risk | Class | Prerequisites | Re-verify with |
|---|---|---|---|---|---|---|---|
| Fix the media-import crash (§3) | 6/6 repro after onset, screenshot + stack captured, file:line `text-node.ts:372-376` + `use-embedding-indexer.ts` implicated | Removes a currently-live crash risk; SPECULATIVE beyond that (root cause not isolated) | M (needs a debugging session to isolate) | Was HIGH before this was found — a crash mid-edit is a total-loss event for perceived quality | STRUCTURAL-adjacent (correctness, not perf) but must fix before any THE-fixture-project perf work is trustworthy | none | Re-run `05-build-fixture-project-and-playback-fps.js` with `AXIS1_FULL_FIXTURE=1`; success = it completes without hitting the error boundary |
| 4K HEVC ingest latency (12-20s transcode) | measured, §2 item 8 | SPECULATIVE — a Web Worker/streaming transcode could hide this behind a "ready in background" state instead of blocking asset-ready; magnitude of gain unmeasured | M | Medium (touches `normalize-media.ts` transcode path) | MITIGABLE (transcode cost is real, but UX can hide it) | none new | Re-run item 8's script, comparing "usable in editor" time (if a progressive/streaming path existed) vs current "fully ingested" time |
| Cold-TTI outlier (3709 ms on first-ever launch vs 620-1568ms on subsequent) | measured, §2 item 1, n=5 | SPECULATIVE — likely first-connection-to-local-Postgres or first-Chrome-process warm costs, not app-side; needs a profile to confirm | S (just profile it) | Low | Unclear until profiled — may be entirely environmental | none | Re-run `01-cold-warm-tti.js`, capture a CDP trace on the first cold run specifically |
| Scrub tail latency (117.8ms worst-of-20 vs 25ms median) | measured, §2 item 4, n=20 | SPECULATIVE — likely occasional decode-cache misses on the 1080p source; a prefetch-on-hover or wider decode-tier cache could flatten the tail | M | Low (perf-only, scoped to VideoCache/decode tiers already touched by prior art @03843823) | MITIGABLE | none new | Re-run `04-scrub-latency.js`, histogram the 20 samples, correlate outliers with `avgDecodeMs` from `perfStats` |
| First-split-per-track warm-up cost (1070ms/533ms first 2 runs vs ~33ms steady state) | measured, §2 item 6 footnote, n=5 | SPECULATIVE — looks like a one-time video-decoder-pipeline init cost per new track; if so, pre-warming decoders when a track is created (before the user's first edit on it) could remove it | S-M | Low | MITIGABLE | none new | Re-run `06-edit-ops.js`'s split loop with more reps, check whether cost re-appears per-NEW-track or is truly one-time per session |
| `crossOriginIsolated`/SAB unavailable (no COOP/COEP headers) | verified at runtime, §2 header | SPECULATIVE — only matters if a future optimization wants SharedArrayBuffer (e.g. certain multithreaded WASM codec paths) | S (header config) | Low | CLOSABLE (a deploy-config change, not app code) | Vercel/Next.js response headers | `crossOriginIsolated` in a fresh page load after the header change |

## 7. Scripts left in `$BENCH/axis-1/`

- `lib.js` — shared Playwright helpers (`newBrowser`/`newPage` with
  `channel:'chrome'` headed, GPU-renderer + platform-capability probes,
  `stats()`, `waitForBridgeReady()`, `waitForCanvasPainted()` — polls the
  largest `<canvas>` for a non-black pixel via rAF, independent of
  `perfStats`).
- `01-cold-warm-tti.js` — item 1 (cold/warm TTI), re-runnable as-is.
- `02-project-open.js` — item 2 (existing project + media open), handles
  the `/editor/<id>` → real-id redirect correctly (a gotcha: the URL you
  navigate to is NOT the persisted project's id).
- `03-clip-drop-ingest.js` — items 3 + 8 (1080p clip-drop, 4K HEVC ingest +
  seam detection).
- `04-scrub-latency.js` — item 4 (in-page `seek()`→paint latency + an
  informal/unreliable real-mouse-drag cross-check, excluded from reported
  numbers).
- `05-build-fixture-project-and-playback-fps.js` — item 5 driver; builds
  THE fixture project (or, via `AXIS1_FULL_FIXTURE=1`/`AXIS1_FAST=1` env
  vars, variants) and runs the playback-fps sampling loop. **Currently hits
  the §3 crash before completing** — re-run once that's fixed; this is the
  single most valuable script to resurrect first.
- `06-edit-ops.js` — item 6 (split/move/trim latency). Note: an earlier draft
  used a dynamically-constructed function body to dispatch ops and was
  rejected by this environment's security hook; the checked-in version uses a
  fixed op-name switch statement instead — no dynamic code evaluation.
- `07-export-real.js` — item 7 driver, targets the **separate non-e2e
  build** (not the shared e2e image); not yet run this session (§5/§7).
- Non-e2e export worktree: `/Users/zsha/Documents/ai-native-opencut-axis1-export`
  (git worktree, detached @ `a2af6c7f`, `.env.local` copied,
  `node_modules` symlinked to the main checkout) — ready for `bun run build`
  + `07-export-real.js`.
- `crash-screenshot.png` — the §3 error-boundary screen.
- `server.log` / `server2.log` — raw `next start` output from this
  session's runs (includes the crash's server-side error-telemetry POST
  bodies, useful for a debugging follow-up).

# AXIS-7 — Startup / TTI / Delivery Pipeline Audit

## Header
- Machine: Apple M3, 8 cores, 8 GB RAM (memory pressure real; observed `vm_stat` free pages
  low during this run — treat single-run numbers as directional, not lab-grade).
- Browser: Google Chrome 150.0.7871.115 at `/Applications/Google Chrome.app`, driven via
  Playwright `channel: 'chrome'`.
- Build: prod e2e build, `apps/web/.next`, `NEXT_PUBLIC_E2E=1`, HEAD a2af6c7f
  (shared build; `$BENCH/prod-build.done` = `a2af6c7f`). Bundler: **Turbopack** (Next.js
  16.1.3's `next build` defaults to Turbopack; no `--webpack` flag in `build:e2e`).
- Repo HEAD: a2af6c7f. Date: 2026-07-14.
- Fixtures: none of the media fixtures were needed for this axis (startup/delivery, not
  playback/export) — the fixture project matters for axis-4/axis-2/axis-6, not here.
- Second, disposable git worktree used ONLY for a bundle-analyzer build (own `bun install`,
  never merged, main checkout untouched):
  `/Users/zsha/Documents/ai-native-opencut-axis7-bundle` (branch: detached at a2af6c7f).

## 0. Method notes specific to this axis
- Next.js 16.1.3's `next build` produces a **Turbopack** build by default. Turbopack does not
  print the classic webpack "Route / First Load JS" size table, and does not leave
  `.js.map` files next to the two heaviest client chunks even with
  `productionBrowserSourceMaps: true` — so per-module attribution from the shared `.next`
  alone is not possible from chunk contents (fully minified, no `node_modules/...` path
  comments survive).
- Fix: `next build --experimental-analyze` (Turbopack-only flag) writes a real per-module
  graph to `.next/diagnostics/analyze/data/<route>/analyze.data` (a length-prefixed
  JSON+binary frame format) plus a servable "Next.js Bundle Analyzer" treemap SPA at
  `.next/diagnostics/analyze/index.html`. I ran this **only** in the disposable worktree
  above (own `bun install`, own build, ~90s compile + typecheck), never in the shared
  `.next`. The first JSON frame of `analyze.data` contains `sources` (module path tree),
  `output_files` (chunk filenames), and `chunk_parts` (`{source_index, output_file_index,
  size, compressed_size}`) — real per-module byte counts, not estimates.
- All KB figures below are **on-disk file sizes / decoded module sizes from that graph**,
  i.e. verified, not SPECULATIVE, unless explicitly marked.

## 1. Bundle anatomy — /editor/[project_id] critical path

### 1a. Eager "first load" set (from the shared build's own manifests — most authoritative
for "what ships before the editor can render")
Source: `.next/server/app/editor/[project_id]/page_client-reference-manifest.js`
(`entryJSFiles`) + `.next/build-manifest.json` (`rootMainFiles`/`polyfillFiles`) + on-disk
`stat`/`gzip -9` of each file in `.next/static/chunks/`.

| Metric | Value |
|---|---|
| Eager JS+CSS files | 21 files |
| Total raw (uncompressed) | **3,935.8 KB** |
| Total gzip (transfer proxy) | **1,088.6 KB** |

Two chunks dominate (editor-specific, confirmed by grepping which route manifests
reference each hash — see below):

| Chunk | Raw | Gzip | Scope |
|---|---|---|---|
| `22a283e06b69b907.js` | 1,759.2 KB | 490 KB | **editor-only** (only `/editor/[project_id]` references it) |
| `f5ac631d9d4ddf24.js` | 928.4 KB | 238 KB | shared with `/projects` |
| `dda7cb546d0925ee.js` | 218.4 KB | 68 KB | shared root chunk |
| `709bc1a0eedb23e0.css` | 163.6 KB | 24.2 KB | Tailwind global CSS |
| `9a31a927234b745a.js` | 128.2 KB | 35 KB | shared |
| `a6dad97d9634a72d.js` | 110.0 KB | 38.5 KB | Next polyfill-nomodule (see 2f) |
| `110ca4bc22e45873.js` | 117.2 KB | 38 KB | shared |
| (14 smaller files) | ~510 KB | ~157 KB | shared/root |

### 1b. Top-20 heaviest modules, /editor/[project_id] (from `--experimental-analyze`
module graph, client bundle only, JS+CSS only — i.e. the transitive closure the analyzer
associates with the route, which is **larger** than 1a's strict initial-paint set because
it also counts code split into a lazily-instantiated worker chunk that is reachable from,
but not loaded eagerly by, the route)

Total client JS+CSS the analyzer associates with this route: **4,895 KB raw / 1,656 KB
gzip**, 787 first-party (`apps/web/src`) modules + ~1,173 vendor modules.

| # | Module | Raw KB | Gzip KB | Eager on initial paint? |
|---|---|---|---|---|
| 1 | `@huggingface/transformers/dist/transformers.web.js` | 429.9 | 107.4 | **No — worker-only** (see §2a) |
| 2 | `onnxruntime-web/dist/ort.bundle.min.mjs` | 302.6 | 87.7 | **No — worker-only** |
| 3 | `next/dist/.../react-dom-client.production.js` | 193.5 | 60.8 | Yes (framework) |
| 4 | `apps/web/src/app/globals.css` | 163.6 | 24.2 | Yes |
| 5 | `next/dist/build/polyfills/polyfill-nomodule.js` | 110.0 | 38.5 | **Not even fetched** by evergreen Chrome (`nomodule`; runtime-confirmed §3) |
| 6 | `@hugeicons/core-free-icons/dist/esm/index.min.js` | 97.1 | 24.1 | Yes — whole icon set, not tree-shaken (§2e) |
| 7 | `@hello-pangea/dnd/dist/dnd.esm.js` | 78.0 | 23.3 | Yes (drag-drop, statically imported) |
| 8 | `next/dist/compiled/buffer/index.js` | 66.4 | 20.9 | Yes (Node `Buffer` shim) |
| 9 | `apps/web/src/lib/director/tool-catalog.ts` | 47.6 | 14.2 | Yes — Director's full MCP-style verb catalog (§2d) |
| 10 | `mediabunny/.../isobmff-demuxer.js` | 45.4 | 11.5 | Yes (core media pipeline — legitimate, fenced) |
| 11 | `apps/web/src/lib/director/director-api.ts` | 44.9 | 14.8 | Yes (§2d) |
| 12 | `apps/web/src/lib/transitions/gl-definitions.ts` | 44.7 | 12.0 | Yes — shader/transition defs, only needed once an effect is applied |
| 13 | `mediabunny/.../sample.js` | 40.9 | 9.6 | Yes (core, fenced) |
| 14 | `wavesurfer.js/dist/wavesurfer.esm.js` | 40.6 | 11.7 | Yes — only useful once an audio waveform is shown |
| 15 | `mediabunny/.../matroska-demuxer.js` | 34.2 | 7.8 | Yes (core, fenced) |
| 16 | `sonner/dist/index.mjs` | 32.5 | 8.9 | Yes (toast lib, small, fine) |
| 17 | `mediabunny/.../media-sink.js` | 27.3 | 7.1 | Yes (core, fenced) |
| 18 | `apps/web/.../assets/views/settings.tsx` | 27.2 | 7.1 | Yes — a right-panel tab most sessions never open |
| 19 | `apps/web/.../ai/ai-setup-guide.tsx` | 27.0 | 5.2 | Yes — onboarding-only content |
| 20 | `mediabunny/.../codec.js` | 26.9 | 8.0 | Yes (core, fenced) |

Mediabunny alone contributes ~11 modules / ~296 KB raw to this list — that's the
already-shipped, fenced HEVC/decode stack (memory: "mediabunny was ALREADY the decode
stack"), and is legitimately needed immediately (ingest can happen the instant the editor
opens), so it is **not** flagged as an offender despite its size.

## 2. What's on the critical path that shouldn't be

**Zero code-splitting anywhere in the app.** `grep -rn "next/dynamic"` and
`grep -rn "React.lazy"` across all of `apps/web/src` return **0 hits**. `/editor/[project_id]/page.tsx`
statically imports `AssetsPanel`, `Timeline`, `PreviewPanel`, `RightPanel`, `AIPanelWrapper`,
`ReelBoard`, `CommandPalette`, `BackgroundTasksWidget`, `QuickActionsBar` — every panel, every
AI surface, every board/board dialog ships in the one eager 1.76 MB editor chunk regardless
of whether the user ever opens Director, drags a clip (dnd-kit), touches an effect
(gl-definitions), or looks at Settings. This is the single biggest, cheapest lever available
(see Opportunities, O1).

### 2a. Transformers.js / onnxruntime-web — correctly isolated (fenced, re-verified)
- `@huggingface/transformers` imported only in `src/lib/transcription/whisper.worker.ts` and
  `src/lib/local-ai/clip.worker.ts`; both instantiated via `new Worker(new URL("./*.worker.ts",
  import.meta.url))` in `local-whisper.ts:142` / `local-clip.ts:68`.
- Confirmed via manifest cross-reference: the compiled worker chunk `eb504f5b3a62b6de.js`
  (826 KB raw, contains both the transformers.web.js and ort.bundle.min glue) does **NOT**
  appear in the editor route's `entryJSFiles` — it is 100% lazy, only fetched when a worker
  is actually constructed.
- Worker creation itself is lazy-on-first-request through `WorkerSlot.acquire()`
  (`src/lib/local-ai/worker-slot.ts`), with a 5-minute idle-unload (`IDLE_UNLOAD_MS`) —
  fenced prior art, re-verified intact, not re-proposed.
- **No prewarming exists anywhere** (`grep -rn "prewarm|preload|requestIdleCallback"` across
  `lib/local-ai` and the transcribe-prompt hook: 0 hits). This is the real, unclaimed gap —
  see §4 and Opportunity O4.
- The ONNX WASM binary itself, `public`-equivalent
  `.next/static/media/ort-wasm-simd-threaded.jsep.232c7845.wasm`, is **21.1 MB** — confirmed
  referenced only from within `eb504f5b3a62b6de.js` (the worker chunk), never from any eager
  editor chunk. It is fetched only if/when the WASM backend actually initializes (i.e. no
  WebGPU, or WebGPU init fails) inside the worker.

### 2b. `@ffmpeg/*` — confirmed dead, AND a live 31 MB orphaned asset (new finding beyond
the previously-known "dead dependency" follow-up)
- `package.json` still lists `@ffmpeg/core@^0.12.10`, `@ffmpeg/ffmpeg@^0.12.15`,
  `@ffmpeg/util@^0.12.2` as dependencies.
- `grep -rn "@ffmpeg" apps/web/src` → **0 import sites**. Confirmed dead in the JS graph
  (consistent with prior GoPro/HEVC-ingest finding that mediabunny replaced it).
- **New**: `apps/web/public/ffmpeg/ffmpeg-core.wasm` is **31,235 KB (30.9 MB)** and
  `ffmpeg-core.js` is 110 KB, sitting in `public/` — confirmed via
  `grep -rn "ffmpeg-core" apps/web/src apps/web/.next/static/chunks/*.js` → **0 hits
  anywhere**, including inside the built output. This is 100% orphaned: never fetched by
  any code path, but it IS deployed as a public static asset (reachable at
  `/ffmpeg/ffmpeg-core.wasm` on the live site for anyone who guesses/crawls the URL) and
  costs ~31 MB of deploy artifact / CDN storage for zero benefit. See Opportunity O2.

### 2c. MCP SDK / Anthropic SDK — server-only, confirmed not client-bundled
- `@modelcontextprotocol/sdk` imports: `src/app/api/mcp/route.ts`,
  `src/lib/mcp/build-mcp-server.ts`, `src/lib/mcp/mcp-session-store.ts` — all under
  `src/app/api/*` or plain `src/lib/mcp/*` consumed only by that route. None of these paths
  appear in the editor's client `entryJSFiles` or in the `--experimental-analyze` client
  module list.
- `@anthropic-ai/sdk` imports: `src/app/api/llm/agent/route.ts`,
  `src/app/api/llm/enhance-prompt/route.ts`, and `src/lib/director/{agent,agent-gemini,
  vision-critic,reference-intake,take-critic-adapter}.ts`. The `lib/director/*` files are
  imported only by the `api/llm/agent` route handler (server-side), not by any client
  component — confirmed absent from the client module graph. **Only the client-safe
  surface — `tool-catalog.ts` and `director-api.ts` (thin fetch wrappers) — ships to the
  browser** (items #9/#11 in the top-20 table above), which is correct architecture, but
  those two files alone are ~93 KB raw / 29 KB gzip of eager weight for a feature (Director
  chat) many first-time sessions won't open in the first few seconds.

### 2d. Effect shaders / transitions — eager, should be deferred
`src/lib/transitions/gl-definitions.ts` (44.7 KB raw / 12 KB gzip of shader-transition
metadata) loads unconditionally with the editor shell, but by definition is only relevant
once a user drags a transition onto two adjacent clips. Same story for
`wavesurfer.esm.js` (40.6 KB) — only useful once an audio element exists on the timeline.

### 2e. Icon set not tree-shaking
`@hugeicons/core-free-icons/dist/esm/index.min.js` ships as a single 97.1 KB (24.1 KB
gzip) blob even though call sites use named imports (`import { LinkSquare02Icon } from
"@hugeicons/core-free-icons"` — `src/app/sponsors/page.tsx:8` etc.). The package bundles
all icon data into one minified file rather than one file per icon, so any named import
pulls the whole set in. Confirmed by its presence as a single `chunk_part` source rather
than split per-icon.

### 2f. `polyfill-nomodule.js` — fetched, not executed
Next.js always emits `polyfill-nomodule.js` (110 KB raw / 38.5 KB gzip) as a
`<script nomodule>`. Evergreen Chrome recognizes `nomodule` and does **not fetch** scripts
so marked, so despite appearing in `entryJSFiles`/on-disk this is very likely zero real
bytes over the wire for Chrome 150 users — flagged as a measurement caveat, not an
opportunity (nothing to fix; framework-level, would need a Next.js version change to
remove and isn't worth it for a Chrome-only-support product decision axis-7 wasn't asked
to make).

### 1c. Landing page (`/`) vs editor, eager bundle only (same manifest method as §1a)

| Route | Eager JS+CSS raw | Eager gzip |
|---|---|---|
| `/` (landing) | 534.6 KB | 140.7 KB |
| `/editor/[project_id]` | 3,935.8 KB | 1,088.6 KB |

The landing page is lean (7.4x smaller than the editor) and shares the same root/polyfill
chunks — the editor's weight is entirely in its own route-specific bundle, confirming O1
(code-splitting the editor shell) is where all the leverage is, not the marketing shell.

## 3. Measured startup (Playwright, `channel: 'chrome'`, headed)

- Server: prod build (`bun run start`, port 3107, shared `.next` @a2af6c7f). Script:
  `$BENCH/axis-7/measure.cjs`. GPU renderer verified every run:
  **"ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)"** — real Metal,
  not SwiftShader.
- Cold = fresh browser instance + `Network.clearBrowserCache` + `Network.setCacheDisabled`.
  Warm = fresh browser instance, one throwaway warming visit, then measured visit with
  HTTP cache enabled (memory+disk). N=5 each.
- **TTI-proxy definition (operational):** elapsed ms from `page.goto()` start until
  `window.__BYORN_E2E__.ready === true` — the E2E bridge flips this only after the real
  `EditorCore` singleton, timeline store, and slot-generation hook are live, i.e. the
  timeline is actually interactable. This is the closest machine-checkable equivalent of
  "editor responds".
- **Localhost caveat:** TTFB/network legs are near-zero on loopback; these numbers measure
  server render + parse/execute/hydrate, NOT real-world CDN latency. Cold-vs-warm deltas
  here are almost purely browser-cache parse/fetch effects, a LOWER bound on the real-user
  delta (where cold also pays ~1.2 MB of WAN transfer).
- **Memory-pressure caveat (8 GB M3):** cold run 0 included the Next server's own
  first-request route compile/warm (TTFB 2,085 ms outlier); min/max spread reflects that.

### /editor/[project_id] (prod, E2E build)

| Metric | Cold median | Cold min–max | Warm median | Warm min–max | N |
|---|---|---|---|---|---|
| TTFB | 408.7 ms* | 16.8–2,085.3 | 10.2 ms | 8.5–14.0 | 5/5 |
| DOMContentLoaded | 493.9 ms | 59.4–2,137.5 | 51.9 ms | 49.0–57.8 | 5/5 |
| FCP | 892.0 ms | 292–2,552 | 240.0 ms | 236–272 | 5/5 |
| load event | 823.1 ms | 247.9–2,441.8 | 202.1 ms | 193.5–219.7 | 5/5 |
| **TTI-proxy (editor ready)** | **1,066.0 ms** | 370–2,740 | **317.0 ms** | 315–343 | 5/5 |

\* cold medians are inflated by the run-0 server-side first-compile outlier; the
steady-state cold profile is closer to the min column (~370–500 ms TTI on loopback).
Warm numbers are extremely tight (315–343 ms TTI across 5 runs) — the editor shell
hydrates and becomes interactive in ~0.32 s once assets are cached, which is genuinely
competitive with a native app cold launch. **The repeat-visit story is already strong at
the parse/execute layer; what's unprotected is the network layer (no SW), which localhost
can't expose — that's O5's territory.**

### / (landing, prod)

| Metric | Cold median | Cold min–max | N |
|---|---|---|---|
| TTFB | 9.0 ms | 3.4–18.6 | 5 |
| DOMContentLoaded | 85.4 ms | 58.1–128.9 | 5 |
| load event | 128.7 ms | 109.7–176.4 | 5 |
| FCP | not captured (paint entry buffer empty at read time on the prerendered static page — script-timing gap, not a product regression) | — | 0 |

### Wire-transfer + CLS verification (single instrumented cold editor load,
`$BENCH/axis-7/resources.cjs`, 3 s settle after ready)

- 61 subresources, **1,205.6 KB transferred** (+12.5 KB HTML) — closely matches the §1a
  gzip estimate of 1,088.6 KB for JS/CSS, plus 47.6 KB font + 47.3 KB
  `/effects/preview.jpg` + 29.5 KB `/fonts/font-atlas.json` + favicon 8.8 KB + RSC fetch.
- **CLS = 0** (buffered `layout-shift` entries, `hadRecentInput` excluded) — the editor
  opens with zero layout shift. §5's font setup is doing its job; nothing to fix.
- `polyfill-nomodule.js` **absent from the network trace** — runtime confirmation of §2f
  (Chrome does not fetch `nomodule` scripts; the 110 KB is manifest noise, not user bytes).
- Worker chunk `eb504f5b3a62b6de.js` (transformers.js + ORT glue, 826 KB) **absent from
  the trace** — runtime confirmation of §2a: nothing model-related fetched on editor open.
- Two small eager fetches worth noting: `/effects/preview.jpg` (47.3 KB, an effects
  thumbnail fetched before any effect UI is opened) and `/fonts/font-atlas.json` (29.5 KB)
  land on every editor open; minor O1-adjacent deferral candidates.

## 4. WASM/model prewarming vs deferral

- Trigger: `WorkerSlot.acquire()` (`src/lib/local-ai/worker-slot.ts:47`), called from
  `local-whisper.ts` / `local-clip.ts` orchestrators, themselves invoked only from explicit
  user action — the transcribe toast in `use-transcribe-prompt.ts` requires a user click on
  the toolbar mic button (`onClick` just shows another toast telling the user where to
  click — the actual transcribe call isn't even wired from the toast itself); CLIP search
  is invoked from the Library/Insights search box on demand.
- **No idle-prewarm anywhere** — confirmed by source grep (§2a). Today: 100% of the
  worker+model-weight fetch cost is paid on the first transcribe/search action, not before.
- First-transcribe / first-search cold latency: NOT measured (WAN model download from the
  HF hub is too heavy for the contended lock window — see "could not measure" for the recipe).
- Network bytes for model weights are NOT part of the JS bundle (fetched from the HF hub /
  cached by the browser Cache API per the worker file header comments) — sizing them
  requires actually triggering a transcribe/search once, which needs the lock; see §5
  "could not measure."

## 5. Fonts / assets

- Fonts: exactly one `next/font/google` family, Inter, subset `latin`
  (`src/app/layout.tsx:14` — `Inter({ subsets: ["latin"] })`), self-hosted by Next with
  `appUsingSizeAdjust: true` (built-in CLS mitigation via a size-adjusted fallback metric
  font). Confirmed via `.next/server/app/editor/[project_id]/page/next-font-manifest.json`:
  a single `83afe278b6a6bb3c-s.p.3a6ba036.woff2`, **48.4 KB**, `p.` = preloaded. `next start`
  response for `/editor/*` includes a `Link: <.../83afe278...woff2>; rel=preload; as="font"`
  header (confirmed via `curl -I`), so the font preloads without a render-blocking discovery
  round-trip. This is about as good as font loading gets on this stack already — not an
  opportunity.
- Icons/logo: `public/icons/*` (favicons + apple/ms tile icons + `manifest.json` icons) sum
  to 276 KB total, reasonable; `byorn.svg` 121.7 KB (only used in a hidden/legacy context —
  not investigated further, low priority).
- CLS: **0** measured on a real cold editor load (buffered layout-shift entries, §3).

## 6. Cache headers + repeat-visit story

Verified live via `curl -I` against a running prod-build `next start` on the shared
LAN loopback (another axis's server, read-only single GETs, zero interference):

| Path | Cache-Control | Notes |
|---|---|---|
| `/_next/static/chunks/<hash>.js` | `public, max-age=31536000, immutable` | Optimal — Next's own default, **no vercel.json needed**, confirmed `next.config.ts` has no custom `headers()` at all |
| `/` (marketing, static) | `s-maxage=31536000` + `x-nextjs-cache: HIT`, `x-nextjs-prerender: 1`, `x-nextjs-stale-time: 300` | ISR-style edge cache with a 300s stale window |
| `/editor/[project_id]` | `private, no-cache, no-store, max-age=0, must-revalidate` | Correct — per-project dynamic HTML must not be cached |

- No `vercel.json` exists anywhere in the repo (`find` from repo root: 0 results) and
  `next.config.ts` defines no `headers()` function — all of the above is **Next.js's own
  framework default**, not a deliberate config choice. What I could NOT verify: real Vercel
  edge-network behavior (CDN-level cache hit rates, stale-while-revalidate at the edge) —
  only `next start` on localhost was checked; Vercel's actual edge may add/override
  headers I can't see from this machine.
- **No service worker anywhere** — `grep -rn "serviceWorker" apps/web/src apps/web/public`:
  0 hits; no `next-pwa`/`workbox` dependency; `next.config.ts` has no PWA wrapper.
- `public/manifest.json` exists and is linked (`src/app/metadata.ts:124`,
  `manifest: "/manifest.json"`) with a full icon set — so the **manifest half** of PWA
  installability is present, but without a service worker, Chrome's install criteria may
  not be reliably met (not confirmed live — would need a `beforeinstallprompt` check in a
  real browser session; see §7 and "could not measure").

## 7. Web-native counters to "native launches fast" — ranked

Byorn already wins on "no install, always latest" (nothing to claim — inherent to being a
web app) and loses on "first-run cold latency" (worse than a native app's launch, since a
cold /editor load ships ~1.1 MB gzip of JS before any interaction is possible, vs. a native
binary already resident on disk). The three concretely actionable web-native levers, in
descending order of (impact × cheapness):
1. **Code-split the editor shell** (O1) — biggest lever, zero risk, standard Next.js API,
   directly cuts the ~1.1 MB gzip eager payload.
2. **Delete the dead 31 MB ffmpeg asset + package.json deps** (O2) — trivial, zero risk,
   pure cleanup.
3. **Service worker + prewarmed shell for instant repeat-visits** (O5) — real potential
   given static chunks are already immutable-cacheable, but effort is Medium and the
   ceiling depends on the warm-load delta I couldn't fully measure yet (see below).

## Opportunities

| # | Opportunity | Measured evidence | Expected gain | Effort | Risk | Class | Prerequisites (verified) | Re-run to verify |
|---|---|---|---|---|---|---|---|---|
| O1 | Code-split editor: `next/dynamic` for `AIPanelWrapper`/Director chat, `ReelBoard`, effects/`gl-definitions`, `wavesurfer`, `@hello-pangea/dnd`, Settings/Captions views | 0 `next/dynamic` sites repo-wide (grep); §2 top-20 table sums ~330 KB raw / ~95 KB gzip in candidate-deferrable modules alone (tool-catalog+director-api 93KB, gl-definitions 44.7KB, wavesurfer 40.6KB, dnd 78KB, settings.tsx+ai-setup-guide.tsx 54KB) | ~90-100 KB gzip off first paint per session that never touches those features (~9% of the 1,088KB eager gzip total); SPECULATIVE for actual TTI-ms delta (needs before/after measurement) | M | Low (standard Next.js pattern; care needed for state that currently assumes these mount synchronously, e.g. `AIPanelWrapper`'s effect timing) | CLOSABLE (this is exactly the kind of instant-update, no-reload iteration a web app can do that a native app installer can't — but currently unclaimed) | None — `next/dynamic` works out of the box on this Next 16 Turbopack build | Re-run `--experimental-analyze` in a worktree pre/post change; diff `entryJSFiles` list + gzip totals |
| O2 | Delete `public/ffmpeg/ffmpeg-core.{wasm,js}` (31.3 MB) + remove `@ffmpeg/core`, `@ffmpeg/ffmpeg`, `@ffmpeg/util` from `package.json` | `grep -rn ffmpeg-core` across src + built `.next` output: 0 hits anywhere; confirmed orphaned | 31.3 MB off deploy artifact size; zero runtime effect (nothing references it) | S | Very low — confirmed zero references anywhere including build output | STRUCTURAL cleanup, not really a native-vs-web axis, but pure unclaimed cheap win | None | `grep -c ffmpeg-core` across repo + build output should be 0 both before and after; `du -sh public/` before/after |
| O3 | Fix `@hugeicons` tree-shaking (swap to per-icon-module icon lib, e.g. lucide-react already in the dep tree for some uses, or lazy-load rarely-used icon sets) | Single 97.1 KB/24.1 KB-gzip `index.min.js` module despite named-import call sites (confirmed via analyze.data: one `chunk_part` source, not split) | ~20-24 KB gzip | S–M | Low (icon swap is mechanical but touch-many-files) | CLOSABLE | None | Re-run analyze; check hugeicons no longer appears as single >90KB source |
| O4 | Idle-prewarm the Whisper/CLIP worker (start `WorkerSlot.acquire()` on `requestIdleCallback` after editor mount instead of first user action) | Confirmed 0 prewarm call sites; `IDLE_UNLOAD_MS=5min` already exists (fenced) so a prewarm-then-idle-unload cycle fits the existing lifecycle cleanly | SPECULATIVE — cuts first-transcribe/first-search latency by the model-weight fetch+init time, at the cost of an unconditional background fetch (bytes) for sessions that never transcribe/search; net user-facing win only if usage rate is high enough | S (hook into existing `WorkerSlot`, no new machinery) | Medium — trades bytes-for-everyone vs latency-for-some; needs a product call, and 8GB-RAM users could feel memory pressure from a resident model most sessions don't use | MITIGABLE (mitigates a real perceived-latency gap vs instant native-tool availability, doesn't close it since HF hub fetch + WASM/WebGPU init is unavoidable relative to a pre-loaded native model) | `requestIdleCallback` support (near-universal in Chrome); confirm no regression to the existing idle-unload timer interaction | Time first-transcribe latency cold vs with idle-prewarm on the same fixture |
| O5 | Service worker asset cache (precache the ~1.1MB gzip eager chunk set) + offline-tolerant editor shell | Confirmed: 0 service workers today; static chunks already `immutable, max-age=31536000`. Measured ceiling (§3): warm TTI 317 ms vs steady-state cold ~370–500 ms **on loopback** — i.e. locally the HTTP cache already recovers most of it; the REAL win is on WAN, where cold pays 1,205.6 KB transfer (measured) that a SW precache turns into 0 network bytes + offline-tolerant open. WAN delta = SPECULATIVE (not measurable from loopback), floor = warm-vs-cold loopback delta ~50–180 ms parse/fetch | M | Low-medium (hashed immutable filenames already give natural cache-busting) | CLOSABLE (THE unclaimed "prewarmed shell / instant open" web-native lever — direct counter to "native launches fast") | Entry chunk list for the precache manifest already produced (§1a) | Re-run `measure.cjs editor warm 5` with SW active vs without, ideally against the real Vercel deploy over WAN |
| O6 | PWA installability | `manifest.json` present + linked; no service worker; not confirmed live whether Chrome offers an install prompt today | SPECULATIVE (install itself doesn't speed up first load, but removes browser chrome + gives an app-like entry point — a distinct "feels native" lever, not a load-time one) | S once O5 lands (SW is usually the missing installability criterion) | Low | CLOSABLE (direct native-app-launch-feel counter) | Needs live `beforeinstallprompt` check in Chrome — not done this session | Load the deployed prod URL in real Chrome and check for the install icon in the omnibox |

## What I could NOT measure, and why

- **LCP**: the buffered `largest-contentful-paint` entries read back null via
  `performance.getEntriesByType` after load (that API doesn't expose LCP without a
  pre-registered `PerformanceObserver({buffered:true})`); FCP + TTI-proxy captured instead.
  Landing-page FCP has the same script-timing gap (see §3 table).
- **§4 first-transcribe/first-search cold latency + model-weight network bytes**: requires
  a real transcribe interaction that downloads whisper-small ONNX weights from the
  Hugging Face hub over WAN (hundreds of MB across model variants; default is
  `onnx-community/whisper-small` per `src/constants/transcription-constants.ts:84`).
  Lock-time budget and WAN download time made this a poor trade against the contended
  queue; deferred with `measure.cjs`-style recipe: open editor → add `fixture-audio-3min.wav`
  → click toolbar mic → time toast-to-transcript with `performance.now()` brackets, and sum
  `resource` entries matching `huggingface.co` for weight bytes.
- **§6 real Vercel edge behavior**: this machine only runs `next start` locally; Vercel's
  actual edge CDN cache behavior (hit rates, header rewriting, brotli) cannot be verified
  from here — the deployed byorn-liart.vercel.app would need live header inspection, which
  I did not do (out of local-bench scope).
- **§7 O6 PWA installability**: needs a live Chrome session against the real HTTPS
  deployment (installability criteria don't fully apply on `http://localhost`).
- Per-module gzip vs brotli: Vercel typically serves brotli to Chrome; I computed gzip
  (Node `zlib.gzipSync` level 9) as a conservative transfer proxy, and the measured wire
  transfer (1,205.6 KB, §3) confirms the right order of magnitude on this local server.

## Scripts left in $BENCH/axis-7/

- `editor-manifest-parsed.json` — parsed `entryJSFiles`/chunk lists from the shared
  build's `page_client-reference-manifest.js` (§1a source data).
- `measure.cjs` — Playwright startup/TTI measurement harness (cold/warm × landing/editor).
  Usage: `node measure.cjs http://localhost:<port> editor cold 5`. Outputs
  `results-<route>-<temp>.json` (raw per-run data for §3 kept alongside).
- `resources.cjs` — single-load resource-level wire-transfer + CLS capture
  (`resources-editor-cold.json`).
- `analyze-build2.log` — full build log from the `--experimental-analyze` run in the
  disposable worktree (module-graph source for §1b/§2).
- Disposable worktree `/Users/zsha/Documents/ai-native-opencut-axis7-bundle`: REMOVED
  (`git worktree remove --force`) after the analyze build's data was extracted; main
  checkout verified untouched by this session (git status diff vs session start: only
  other sessions' pre-existing WIP).

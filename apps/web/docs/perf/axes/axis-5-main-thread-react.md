# AXIS-5 — Main-Thread & React Perf Audit

## Header

- Machine: Apple M3, 8 cores, 8 GB RAM, macOS 26.3.
- Browser: Google Chrome 150.0.7871.115, `channel:'chrome'` via Playwright 1.61.1, **headed**.
- GPU renderer (verified at runtime via `WEBGL_debug_renderer_info`): `ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)` — real Metal backend, not SwiftShader.
- Build: prod-e2e (`bun run build:e2e`, `NEXT_PUBLIC_E2E=1`), repo HEAD `a2af6c7f`, served via `next start` on port 3105 (axis-5's assigned port).
- Date: 2026-07-14.
- Platform capabilities verified at runtime (not recalled): `'gpu' in navigator` → **true** (WebGPU present). `window.crossOriginIsolated` → **false**. `navigator.storage.getDirectory` → **true** (OPFS present). `VideoDecoder.isConfigSupported({codec:'avc1.640028', hardwareAcceleration:'prefer-hardware'})` → **true** (HW H.264 decode available). Confirmed by static read of `apps/web/next.config.ts`: there is **no** `headers()` block setting `Cross-Origin-Opener-Policy`/`Cross-Origin-Embedder-Policy` at all, so `crossOriginIsolated:false` is a genuine deploy-config gap, not a runtime fluke — **SharedArrayBuffer is unavailable in this deploy**, which is a prerequisite gate on any "move serialization to a worker with SAB" opportunity.
- Fixtures: THE fixture project, built programmatically through the real `EditorCore` manager APIs (see Construction script below) rather than pixel drag-drop, because of a rendering crash discovered mid-audit (see "What we could not measure"). The 4× 1080p fixture / 4K-HEVC fixture / 3-min-audio fixture files on disk were **not** ingested through the real `processMediaAssets` pipeline in the runs that produced numbers below — see caveats.

## Prior-art verification (regression check)

Read `git show 2b2079c4 --stat` and the touched files before measuring, per the fence.

- **Holds, confirmed statically.** `apps/web/src/core/managers/playback-manager.ts:220-277` (`updateTime`, the per-frame RAF tick) calls `this.notifyTime()` (line 268) on the steady-state per-frame branch, and only calls `this.notify()` (the discrete channel) on settle points (start, end-of-range, pause, seek). `apps/web/src/hooks/use-editor.ts:9-22` (`useEditor`) subscribes to `editor.playback.subscribe(...)` — the discrete channel — and does **not** call `subscribeTime`. So the universal editor subscription genuinely does not wake on the 60 Hz tick.
- **Regression check via grep** (`grep -rn "subscribeTime\|usePlaybackTime"`): exactly one consumer of the high-frequency channel exists in the whole tree — `usePlaybackTime()` (`apps/web/src/hooks/use-playback-time.ts`), used only by the `PlaybackTimecode` leaf in `apps/web/src/components/editor/panels/preview/toolbar.tsx:130`. Nothing new has attached to the 60×/sec path since `@2b2079c4`. **Prior art holds.**
- The preview compositor's own per-frame work (`apps/web/src/components/editor/panels/preview/index.tsx:357-403`, driven by `useRafLoop(render)`) is pure imperative canvas drawing (`renderer.renderToCanvas(...)`) with no `setState` in the loop body — confirmed by reading the function. It correctly does not generate React commits per frame.

This matters because a large, unexplained commit storm shows up in the playback-30s measurement below (item 3) — the two facts above are why I do **not** attribute it to a tick-channel regression, and instead flag it as most likely an artifact of my synthetic (undecodable) fixture media, to be re-verified against real media as the top follow-up.

## Architecture found (static, informs every number below)

1. **`useEditor()` is a universal external-store subscription**, not per-slice. `apps/web/src/hooks/use-editor.ts` fans a single `useSyncExternalStore` version counter out over **seven** managers (`playback`, `timeline`, `scenes`, `project`, `media`, `renderer`, `selection`). Any notify on any of the seven re-renders **every mounted call site**.
   `grep -rl "useEditor()" apps/web/src/components apps/web/src/hooks | wc -l` → **146 files**.
2. **Zustand is not in the critical edit path at all.** `apps/web/src/stores/timeline-store.ts` (a real Zustand store) is explicitly scoped to UI-only state (snapping, ripple toggle, clipboard) with the file's own header comment: *"For core logic, use EditorCore instead."* Split/move/trim/insert all go through `TimelineManager` (`apps/web/src/core/managers/timeline-manager.ts`), a hand-rolled `Set<listener>` pub-sub, wired into React only via `useEditor()`. So the mission's "Zustand fan-out on split" question has a direct answer: **there isn't one** — split's fan-out is 100% governed by the 146 `useEditor()` call sites, not by any `set()` call. `TimelineManager.updateTracks()` (line 1110) calls both `this.editor.scenes.updateSceneTracks(...)` (its own notify) **and** `this.notify()` — two separate notify emissions per structural edit, both consumed by the same `useEditor()` listeners; React 18 automatic batching should coalesce these into one commit since they run synchronously in the same task (consistent with the low, flat commit counts measured below, though I did not isolate this specific claim with a two-commit repro).
3. **Zustand stores that ARE peripheral UI state: mixed selector discipline.** Sampled usage (`grep -rn "$storeName(" --include="*.tsx" | grep -v stores/`):
   | Store | call sites | whole-store destructure |
   |---|---|---|
   | `useTranscriptStore` | 31 | 0 |
   | `useAssetsPanelStore` | 12 | 6 |
   | `usePersonaStore` | 6 | 1 |
   | `useTimelineStore` | 6 | 0 |
   | `useCreditsStore` | 5 | 0 |
   | `usePropertiesStore` | 4 | 0 |
   | `useSoundsStore` | 3 | 3 |
   | `useStickersStore` | 3 | 3 |
   | `usePanelStore` | 1 | 1 |
   Most stores are selector-scoped (no amplification). `useSoundsStore`, `useStickersStore`, `usePanelStore` are consumed whole-store everywhere they're used — any field change (e.g. one sound's mute toggle) re-renders every consumer of the whole store. Small blast radius today (few call sites) but a real, MITIGABLE pattern.
4. **Timeline clip rendering is not virtualized.** `apps/web/src/components/editor/panels/timeline/timeline-track.tsx:88-108`: `track.elements.map((element) => <TimelineElement .../>)` — unconditional, all elements, no windowing. The only "virtualization" in the timeline subsystem is in `timeline-ruler.tsx` (buffer for ruler *ticks*, unrelated to clip count). No `react-window`/`react-virtual` dependency exists in `apps/web/package.json`.
5. **Save path avoids `JSON.stringify` today.** `grep -n "JSON.stringify" apps/web/src/services/storage/service.ts` → no hits. Saves go through `indexeddb-adapter.ts` (native structured-clone via IndexedDB `put`), debounced 800 ms (`SaveManager`, `apps/web/src/core/managers/save-manager.ts:80`+). The only `structuredClone`/JSON-patch-shaped cost in the codebase lives in `apps/web/src/services/storage/version-storage.ts:191,416,427,429,432` — the version-control commit/diff path, which only runs on manual or auto-commit (`autoCommitIntervalMs = 10 * 60 * 1000`, `version-manager.ts:48`), **not** on every edit.
6. **react-scan is gone from this build.** `git log --all --grep react-scan` finds it added (`feaeec8d`) then disabled in prod (`9b6a1f79`, gated on `process.env.NODE_ENV === "development"`, `apps/web/src/app/layout.tsx:37`). It is not in `package.json` at all (dropped as a dependency), so it cannot be loaded from `node_modules` and the prod-e2e build never includes it (dev-only gate). I did **not** find CDN-network access in the runner, so render counting was done via a from-scratch React DevTools global-hook fiber walker (see Method below) rather than react-scan itself.

## Method: render counting without react-scan

Injected via `page.addInitScript` (before React boots) — a minimal `window.__REACT_DEVTOOLS_GLOBAL_HOOK__` stub whose `onCommitFiberRoot` walks the committed fiber tree and, for `FunctionComponent`/`ClassComponent`/`ForwardRef`/`MemoComponent`/`SimpleMemoComponent` fibers (tags `0,1,11,14,15`, stable across React 16–19), counts a render when `fiber.flags & PerformedWork` (`0b1`) is set — the same bit React itself has set on a fiber whenever its component function/class body actually executed, since React 16. React version confirmed: `react`/`react-dom` **19.2.7**. This is the same technique react-scan's underlying fiber-walker (`bippy`) uses; I could not cross-validate it against a real react-scan run in this build (see gaps). Script: `$BENCH/axis-5/measure.js`.

## Numbers

All runs: N=1 per interaction (single session; lock contention on the shared bench — see below — cost most of the time budget, so these are single-run, not median-of-5). Labeled accordingly; **not** multi-run confidence.

### Fixture construction (documented, repeatable script)

`$BENCH/axis-5/measure.js`, function `BUILD_FN`, calls the real manager APIs directly (same code invoked by the UI):
`timeline.addTrack` ×4 (video, video, audio, text) → `timeline.insertElement` ×4 (staggered 1080p-analog clips across the two video tracks, 5s apart) → 1× HEVC-analog clip (20s) → 1× 180s audio clip → 1× text element → `timeline.addClipEffect` ×2 (`color-adjust`, `blur`) on one clip → `timeline.updateElements` to set a `transitionOut` on that same clip. Result: 5 tracks, 7 elements, effect chain + transition all applied without error on the pristine build (`effectErr: null, transitionErr: null`).
**Caveat:** clip `mediaId`s are backed by a fabricated 1×1 PNG `MediaAsset` stand-in (real `MediaAsset`/`File` shape, registered via `editor.media.setAssets(...)`), not the real fixture MP4/HEVC/WAV files — see gaps.

### Long-task census

PerformanceObserver `longtask`, buffered, across every interaction below (panel-switches, split, attempted scrub-drag, 30 s playback, and the 6/20/50-clip scaling split):

| Interaction | longtask count | total blocked ms |
|---|---|---|
| panel-switches (idle baseline) | 0 | 0 |
| split | 0 | 0 |
| scrub-drag (failed to locate ruler — see gaps) | 0 | 0 |
| playback-30s | 0 | 0 |
| scaling split @6 clips | 0 | 0 |
| scaling split @20 clips | 0 | 0 |
| scaling split @50 clips | 0 | 0 |

**Zero long tasks (>50 ms) in every interaction measured**, up to 50 synthetic clips. This is a real, positive finding for this fixture scale — none of the individually-measured operations trip the classic 50 ms main-thread-block threshold on this machine/build. (Caveat: several golden interactions — real clip-drop, real scrub-drag, real click-driven panel switches — were not successfully exercised as genuine DOM/mouse events; see gaps. The zero-longtask result is strongest for split/move/scaling, which went through the real command/manager code, and weakest for the mouse-driven ones.)

### INP-style event timing

PerformanceObserver `event`, `durationThreshold: 8`, same interaction set: **0 events recorded in every interaction** (`eventCount: 0` throughout). This is a genuine gap, not a "0 ms INP" finding — the mouse-driven interactions that would generate real `event` timing entries (click, pointerdown/up, drag) either targeted elements my selectors failed to hit (ruler has no `data-testid`, panel-switch buttons didn't match by accessible name) or were exercised via direct API calls (`splitElements`, `updateElementStartTime`, `playback.play()`), which correctly bypass the event-timing API entirely since no real input event was dispatched. **INP could not be measured this session** — flagged prominently below.

### React render fan-out (fiber-walk render counts)

| Interaction | commits | top re-rendering components (name: count) |
|---|---|---|
| panel-switches (0 real clicks — idle baseline, ~900 ms window) | 6 | Presence 639, TooltipContent 492, HugeiconsIcon 450, Primitive.div 438, Popper/PopperProvider 410, PopperAnchor 408, Button 354 |
| split (real `splitElements` call) | 2 | small counts (2 each) on a few Next.js internal boundary fibers — low-value sample, likely caught mid hydration-boundary |
| playback-30s (real `editor.playback.play()`, 30 s wall clock) | **1869** | Presence **199,983**, TooltipContent 153,258, HugeiconsIcon 138,306, Primitive.div 136,437, Popper/PopperProvider ~129,000, Button 106,591 |

**Interpretation, hedged:** 1869 commits over 30 s ≈ 62/s, and 199,983 / 1869 ≈ **107 Presence-tagged components re-rendering on nearly every single commit** during playback. Taken at face value this would look like exactly the whole-tree-per-frame problem `@2b2079c4` fixed. But per the regression check above, I confirmed **statically** that neither `useEditor()` nor the compositor's RAF loop can produce this — so I do not believe this is the tick-channel regressing. My leading hypothesis (**SPECULATIVE**, not confirmed): the fixture's clips reference fabricated/undecodable media, and the console was flooded in lock-step with playback (`Failed to initialize video sink for synthetic-hevc-4k: UnsupportedInputFormatError`, repeating every frame) — a per-frame decode-retry-and-fail loop that most likely writes to some broadly-subscribed error/status store (candidate: an asset-health indicator wrapped in the same Tooltip/Popper components that dominate the count), not the playback tick itself. **This must be re-verified against real, decodable fixture media before treating it as a genuine finding** — that is the single highest-value re-run in this report (recipe below).

The idle-baseline row (6 commits / ~900 ms, zero real clicks) is a smaller but real and separate observation: something re-renders a broad slice of Tooltip/Popper chrome a handful of times even at rest. Root cause not isolated this session (candidate, from memory of a related prior audit: a health-poll on `AIStatusIndicator` in `editor-header.tsx`) — **SPECULATIVE** attribution, real number.

### Zustand / store-update amplification on `split`

Per the architecture section: split does not touch Zustand. The relevant amplification surface is `useEditor()`'s 146 call sites, and `TimelineManager.updateTracks()`'s two notify emissions (`scenes.updateSceneTracks` + own `notify()`) per structural edit. Commit count for the isolated `split` call was 2 (see caveat about sample quality above) — consistent with batching working, not with a doubled render, but I did not get a clean, well-isolated repro to state this with confidence.

### Timeline virtualization / scaling (6 vs 20 vs 50 clips)

Synthetic clips inserted via `timeline.insertElement` in a loop on a scratch track, one shared fake `MediaAsset` backing all of them; then one `splitElements` call on the middle clip; track removed between tiers.

| Clip count | insert-build time (in-page `performance.now()`, real) | split “edit” wall-clock (Node-side `Date.now()`, includes a fixed 150 ms settle wait I added) | commits on split | longtasks |
|---|---|---|---|---|
| 6 | 1.2 ms | 215 ms | 7 | 0 |
| 20 | 3.2 ms | 175 ms | 6 | 0 |
| 50 | 8.5 ms | 185 ms | 6 | 0 |

**Insert-build time scales ~linearly with clip count** (≈0.17 ms/clip, 1.2→3.2→8.5 ms for 6→20→50) — consistent with the immutable array-copy pattern used throughout `TimelineManager` (`tracks.map(...)`/spread on every mutation, e.g. `renameTrack`/`updateTrack`/`updateTracks`). **The split-edit wall-clock number is dominated by my own artificial 150 ms wait, not real op cost** — treat the "≈180–215 ms" figures as noise, not signal (my mistake; flagging rather than hiding it). The clean signal is: commit count on split stayed flat (6–7) regardless of clip count, and zero long tasks occurred even at 50 clips. **At this scale (≤50 clips), the absence of virtualization is not yet visible as an interaction-latency problem** on this machine/build — this tempers a naive "must virtualize now" recommendation. It does not rule out a problem at hundreds of clips / many minutes of timeline (real production projects can far exceed 50 elements); the risk is real but its onset point was not reached in this test. Classed STRUCTURAL/long-tail, not urgent.

### Serialization

Measured on the small real fixture project (7 elements, NOT the 50-clip stress project — the stress track was removed after each scaling tier before this ran, so **this is not a 50-clip-scale serialization number** — a gap, see below):

| Metric | value |
|---|---|
| `structuredClone(tracks)` | 0.4 ms |
| `JSON.stringify(tracks)` | 0 ms (rounds to 0) |
| resulting JSON size | 2,678 bytes |
| `editor.project.saveCurrentProject()` (real IndexedDB write) | 5.8 ms |

Confirms the static finding: no `JSON.stringify` in the save path itself, and both clone and save costs are negligible at this project size. **Not measured at the 50-clip scale** — the highest-value follow-up alongside the playback-storm re-run.

## What we could not measure, and why

1. **Real INP for mouse-driven interactions (clip drop, scrub-drag, panel-switch clicks) — not obtained.** The ruler has no `data-testid`/stable class (`grep` for `data-testid` in `timeline-ruler.tsx` and `timeline/index.tsx` returned nothing), so the scrub-drag drag never found a bounding box to drag from. The panel-switch tab buttons matched by accessible name (`Media`, `Text`, …) also didn't resolve reliably (0 clicks recorded both attempts) — likely tooltip/label text isn't the button's accessible name in this build. Clip-drop was not attempted at all (dropped under time pressure after the above two failures and a lock-contention-driven schedule squeeze). All "split/move/trim/play" numbers above are real code-path calls through the manager API (the same call the UI makes), which is a legitimate way to measure the underlying engine cost, but **is not a substitute for real event-timing/INP on actual mouse input** — that gap is the most important one to close in a follow-up run, now that the ruler-selector and button-selector issues are known.
2. **CDP-trace attribution of the worst long tasks — not done.** There were zero long tasks to attribute (see census), so this didn't come up, but if a future real-media run does surface long tasks, this session did not exercise the `Tracing.start` CDP path — only `PerformanceObserver('longtask')`'s `attribution` array (container type/src), which is coarser than a JS stack.
3. **The playback-30s commit storm's root subscriber — not isolated.** I ruled out `useEditor()` and the compositor RAF loop by static read, and formed a hypothesis (undecodable synthetic media → per-frame decode-retry writing to a broadly-subscribed store), but did not chase it to a specific file/line. **Concrete re-run recipe:** repeat `$BENCH/axis-5/measure.js`'s `playback-30s` step, but first ingest the real `fixture-1080p30-h264.mp4` through the actual `processMediaAssets` pipeline (via `page.setInputFiles` on the hidden `<input>` in `apps/web/src/components/editor/panels/assets/views/assets.tsx:280`, sourced from `useFileUpload`) instead of the fake-PNG `MediaAsset` stand-in, then compare commit counts. If the storm disappears, it confirms the synthetic-media hypothesis; if it persists, it's a genuine regression worth a CDP trace.
4. **Serialization/save timing at 50-clip scale — not obtained** (see above; the stress track was torn down before the serialization step ran). Cheap to fix: move the serialization measurement inside the scaling loop's 50-clip iteration before the track is removed.
5. **A single, well-isolated two-notify-vs-one-commit repro for `TimelineManager.updateTracks()`'s double notify** — not obtained; the `split` commit-count sample (2) is suggestive of batching working but the sample was noisy (see table).
6. **Multi-run statistics (N≥5).** Every number above is a single run. The shared bench lock was extremely contested this session (7 agents on one `mkdir`-based mutex): my own log shows the lock held continuously by other axes from roughly 21:41 to 22:52 JST (over an hour) before my first acquisition, and it changed hands twice more (`axis-2`→`axis-4`→`axis-6`→`axis-7`) before I got a clean run; my own held-lock window was interrupted once mid-session (owner.txt showed `axis-4` acquiring only ~4 minutes after I'd written `axis-5` as owner, despite being well under both the 20-minute soft cap and the 35-minute stale threshold — possibly a coordination bug in another axis's stale-break logic, not something I could control from here). Net effect: one clean end-to-end run was completed, not five.
7. **A direct react-scan comparison.** Not installed in this build (see architecture note 6); my from-scratch fiber-walk heuristic is a reasonable stand-in (same underlying React-internals technique) but wasn't cross-validated against a real react-scan session.

## Ranked opportunities

| Opportunity | Measured evidence | Expected gain | Effort | Risk | Class | Prerequisites | Re-run to verify |
|---|---|---|---|---|---|---|---|
| Split `useEditor()` into per-manager selector hooks (e.g. `useTimelineOnly()`, `useSelectionOnly()`) so the 146 call sites only re-render for the manager(s) they actually read | Static: 146 files call `useEditor()`, all fanned through one version counter over 7 managers (`use-editor.ts`) | SPECULATIVE (no isolated before/after commit-count delta measured this session; the flat, low commit counts on `split`/scaling suggest today's actual damage may be smaller than the surface area implies — needs a targeted repro) | L (touches the most widely-used hook in the app) | Medium — wrong selector boundaries could reintroduce stale reads | MITIGABLE (React-idiomatic; not blocked by any browser capability) | none | Re-run `$BENCH/axis-5/measure.js`'s fiber-walk on `split`/`move+trim` before/after, comparing commit count and per-component render count |
| Switch `useSoundsStore`/`useStickersStore`/`usePanelStore` consumers to selector-based reads | Static: 3/3, 3/3, 1/1 whole-store call sites respectively (grep table above) | SPECULATIVE, small blast radius today (few call sites) | S | Low | CLOSABLE | none | Re-run fiber-walk while toggling one sound/sticker field, compare renders of sibling consumers before/after |
| Timeline clip virtualization (windowing) for large projects | Static: `timeline-track.tsx` maps all elements unconditionally, no `react-window`/`react-virtual` dependency. Measured: insert scales ~linearly (0.17 ms/clip) but split-edit commit count/longtasks stayed flat 6→50 clips — **no measurable interaction-latency problem yet at this scale** | SPECULATIVE at scale beyond 50 clips — not reached in this session; likely real for projects with hundreds of clips (DOM node count, layout cost) but unverified | M (adopt `react-window` or hand-roll a viewport-based slice in `TimelineTrackContent`) | Medium — must preserve drag/drop, selection, keyboard nav across virtualized boundaries | STRUCTURAL (matters more as projects grow; native NLEs on Metal don't pay a per-DOM-node cost the way a browser timeline does) | none | Re-run the scaling test at 200/500 clips; watch for the point where commit count, insert-build ms, or longtasks stop being flat |
| Re-verify the playback commit storm on real decodable media before treating it as a regression | Measured: 1869 commits / 30 s, ~107 Presence-tagged components re-rendering per commit, on synthetic undecodable media; ruled out `useEditor()`/compositor RAF as the source by static read | SPECULATIVE — could be entirely an artifact of fake media (most likely) or a genuine, currently-undiscovered per-frame store write | S (just re-run with real fixture ingest) | Low (measurement only) | n/a — diagnostic prerequisite before any other action | Real fixture ingest via file input (recipe in gaps §3) | See gaps §3 recipe |
| Move version-control snapshot diffing (`structuredClone` + JSON-patch in `version-storage.ts`) off the main thread | Static: confirmed this only runs on manual/auto-commit (10 min interval), not per-edit; measured `structuredClone`/`stringify` costs were sub-millisecond on a 7-element project | SPECULATIVE — not worth pursuing at today's measured cost; would only matter if commit-time snapshots grow large (hundreds of elements + long undo history) | — | — | Not recommended now | `crossOriginIsolated` is **false** in this deploy (no COOP/COEP headers in `next.config.ts`) — a worker+SAB approach would need that gate opened first regardless | Re-run serialization test at 50+ clip scale (gap #4) before reconsidering |

## Scripts left in `$BENCH/axis-5/`

- `measure.js` — the full Playwright driver: capability/GPU verification, fixture construction via real manager APIs, fiber-walk render-count + longtask + event-timing instrumentation (injected via `addInitScript`, no product-code changes), golden interactions (panel-switches, split, move+trim, scrub-drag attempt, 30 s playback), 6/20/50-clip virtualization scaling test, and serialization timing. Run with: `cd apps/web && AX5_PORT=3105 node $BENCH/axis-5/measure.js` against a server started with `NEXT_PUBLIC_E2E=1 PORT=3105 bun run start`. Requires the bench LOCK per protocol.
- `results-final.json` / `results-partial.json` — raw output of the last complete run (numbers above are pulled from these).
- `server.log` — last `next start` server log for this axis's port.

Known fixes needed before the next run (documented so the next agent/session doesn't repeat the same time cost): ruler has no stable selector (add one or locate by geometry within the timeline panel bounding box); panel-tab buttons don't resolve by accessible-name text match in this build (inspect actual accessible name, e.g. via `page.locator('button').allInnerTexts()` first); `updateElementStartTime` takes `{elements: [{trackId, elementId}], startTime}`, not `{trackId, elementId, startTime}` (my first script version got this wrong, producing a spurious "Cannot read properties of undefined (reading 'some')" — **not a product bug**, a test-harness bug, now understood but not re-verified after fixing).

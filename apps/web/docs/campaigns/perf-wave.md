# Campaign: perf-wave (C5) — 2026-07-17

Branch: `campaign/perf-wave` off main @1f9e9164. L1 orchestrator log (crash-survival state).

## Objective

Queue §3 P1/P2 + §2 BUG2/BUG14/BUG15/BUG16. Flagship: worker-compositor flag-ON verify →
default-ON if golden-path stable (prior fix-e bench "on" numbers are NOISY: worker fps
24 / 9 / 1.7 across n1-3 — re-verify cleanly before any flip). Territory: services/renderer/**,
services/video-cache/**, compositor worker code, stores/*, perf docs.

## Plan / partition (file clusters, exclusive)

| Worker | Item | Owned files | Status |
|---|---|---|---|
| W-P1 (sonnet) | P1 flag-ON verify: fresh bench off/on ×3, full e2e with flag ON, golden-path drive + parity audit (playbackQuality downscale + fullscreen missing in worker path?) | NO product code; bench tooling under `apps/web/docs/perf/fix-e-worker-compositor/` + scratchpad; evidence only | dispatched |
| W-A (sonnet) | BUG2 fps60 re-seek storm: serve-stale + background re-seek under `tolerateStale`; optional fps-scaled ring/window | `apps/web/src/services/video-cache/**`, `apps/web/src/services/renderer/nodes/video-node.ts` | dispatched |
| W-B (sonnet) | BUG15 one-liner: resume-poll `apiFetch` → `{ on401: "silent" }` + test | `apps/web/src/stores/generation-status-store.ts` (+ its test file) | dispatched |
| W-C (sonnet) | BUG14 flame-graph profile: timeline-mutation stall during heavy import; fix only if small + in unowned files, else measured queue row | profile/report; may touch `apps/web/src/lib/media-processing/**` scheduling ONLY if fix is small | dispatched |
| W-D (sonnet) | BUG16 HDR→SDR: scene-exporter decode path; contained tonemap or document | `apps/web/src/services/renderer/scene-exporter.ts` + new tonemap helper; NOT video-cache/video-node (W-A's) | dispatched |
| W-E (sonnet) | P2 re-baseline 7-axis vs audit, after merges | new doc `apps/web/docs/perf/rebaseline-2026-07-17.md` | pending (after wave 1) |

Flag-flip (default-ON) = separate decision by L1 after W-P1 evidence + own browser drive;
executed as a tiny follow-up worker change to `components/editor/panels/preview/index.tsx`.
If ANY golden-path regression: ship flag-OFF + findings (a flip is cheap to redo).

## Key seams (for re-brief/resume)

- Flag: `NEXT_PUBLIC_WORKER_COMPOSITOR=1` or `localStorage["byorn-worker-compositor"]="1"`;
  gate in `components/editor/panels/preview/index.tsx` L159-204 (WorkerPreviewCanvas vs
  PreviewCanvas + RenderTreeController).
- Worker path: `services/renderer/worker/{compositor-controller.ts,compositor.worker.ts,compositor-types.ts}`.
- Bench: `docs/perf/fix-e-worker-compositor/bench.js` — STALE absolute paths (old fix-e
  worktree + dead scratchpad fixtures); needs path adaptation + fixture re-mint (ffmpeg).
  Stats: `window.__byornPerf` (main) / `window.__byornPerfWorker` (worker).
- BUG2 mechanism (bug-purge-w1): 4×1080p60 @ project fps60 → prefetch ring (cap 4) drains →
  playhead outruns 2.0s SEQUENTIAL_WINDOW → every getFrameAt awaits full seekToTime keyframe
  re-seek on render path → storm. `video-cache/service.ts` L242 (tolerateStale early-return),
  L273 (escalation), L369 (seekToTime), L111 (window const).
- BUG15: `generation-status-store.ts` L152; mirror `hooks/use-board-items.ts` L75
  (`on401: "silent"`); two-mode API in `lib/auth/unauthorized.ts` (@3cd3acd4).
- BUG16 repro fixture: `apps/web/e2e/fixtures/w2/hdr_hevc_1280x720_10bit.mp4` (bt2020/smpte2084).
  Playwright bundled Chromium has NO H.264/HEVC decode — use `channel: "chrome"` (queue C9).
- E2E: `bun run build:e2e` + `bun run test:e2e` from apps/web; E2EBridge seeding; disable
  react-scan; MobileGate needs desktop viewport.

## Decisions

- (2026-07-17) Worktree spawned 77 behind main; campaign branch cut from main @1f9e9164.

## Merge log

- @18e2a31f `task/bug15-silent-poll` (b9800dfc) — BUG15 DONE. Reviewed: correct 3-arg
  `apiFetch(url, undefined, { on401: "silent" })` mirroring use-board-items.ts L75;
  terminal-4xx poll-stop branch untouched; +81-line regression test file. typecheck 0,
  tests 4/4 (in the 9/9 combined run). Tier: merged+unit-tested.
- @1b25ed1e `task/bug14-profile` (26acf6d9) — BUG14 PARTIAL. Profile verdict: ~70% of
  stall = main-thread 4K decode of un-proxied original (VideoCache/CanvasSink preview
  path) → architectural, folded into P1's case. Mitigation merged: `shouldDeferIndexing`
  guard in `use-embedding-indexer.ts` (CLIP frame-sampling skips assets with an active
  proxy job; retried via MediaManager.notify on proxy finish; ~807ms→0 in after-profile).
  Reviewed: additive, uses real `MediaManager.isProxyGenerating` (media-manager.ts:419),
  honest scoping comments. Evidence: `docs/perf/bug14-import-stall-profile-2026-07-17.md`
  + cpuprofiles + repro harness (e2e + playwright config). Tier: merged+unit-tested
  (profile evidence browser-derived).
- @c0c7dc7b `task/bug16-hdr-tonemap` (f3c2a8be) — BUG16 FILED (architectural). No product
  code. Mechanism: PQ→SDR flattening happens inside mediabunny CanvasSink drawImage onto
  an srgb 2d context, upstream of scene-exporter; CanvasRenderer shared with preview
  (impact CRITICAL/125) ⇒ no contained export-only fix. Evidence + PQ reference imagery +
  scoped proposal: `docs/perf/bug16-hdr/finding-2026-07-17.md`. One empirical step
  (live-Chrome frame diff) blocked by machine contention — documented honestly in the doc.

Post-merge check @c0c7dc7b: `bun run typecheck` exit 0; new unit tests 9/9. Full battery
deferred to final tip (machine contended — battery will run serially).

## Evidence

(bench JSONs, screenshots, e2e output — filled as parts close)

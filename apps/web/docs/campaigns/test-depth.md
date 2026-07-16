# Campaign: test-depth (C12)

Branch: `campaign/test-depth` off main @3c7e41c8. L1 orchestrator log (crash-survival state).
Territory: tests only — `**/*.test.ts`, `**/*.e2e.ts`, fixtures/helpers, playwright config,
CI yaml, plus minimal `e2e-bridge.tsx` seam additions. No product source.

## Recon facts (2026-07-17)

- Harness: `apps/web/e2e/*.e2e.ts`, `playwright.config.ts` (port 3210, stub-export build),
  `build:e2e` = `NEXT_PUBLIC_E2E=1 next build`. Bridge `src/components/editor/e2e-bridge.tsx`
  already supports REAL export via `NEXT_PUBLIC_E2E_STUB_EXPORT=0` (build-time flag).
- WebM fixture (global-setup) is VIDEO-ONLY (canvas captureStream) — an A/V assertion needs a
  second minted fixture with an audio track (canvas + AudioContext oscillator).
- Takes/board invariants live in `src/hooks/use-studio-generation.ts`
  (routeCompletedTake: batch≤1→Assets, batch≥2→board POST, pin-fail→Assets fallback;
  module-level `liveTakeIds`/`resumingTakeIds` dedup; `InsufficientCreditsError` 402 sentinel).
  No DOM test infra (no happy-dom/@testing-library, no new devDeps allowed) ⇒ hook invariants
  are tested at Playwright level (real browser, real hook), pure logic at bun-test level.
- CI: `.github/workflows/bun-ci.yml` — e2e job has NO postgres service and NO ffmpeg;
  `auth-flow.e2e.ts` runs today (check how it copes without a DB).
- Timeline edit ops: `src/core/managers/timeline-manager.ts` — trim fields on elements,
  `splitElements({elementIds, splitTime})`.

## Partition (no file overlap)

| Worker | Branch | Owned files |
|---|---|---|
| A: golden-path real-export e2e (sonnet) | `test/golden-path-export-e2e` | `apps/web/e2e/golden-path-export.e2e.ts` (new), `apps/web/e2e/global-setup.ts` (additive), `apps/web/playwright.real-export.config.ts` (new), `apps/web/src/components/editor/e2e-bridge.tsx` (minimal), `apps/web/package.json` (2 scripts) |
| B: takes/board regression (sonnet) | `test/takes-board-regression` | `apps/web/e2e/takes-board-routing.e2e.ts` (new), `apps/web/src/stores/__tests__/generation-status-store.test.ts` (new), `apps/web/src/lib/studio/__tests__/add-to-editor.test.ts` (new) |
| C: CI wiring (sonnet) | `ci/test-depth-workflow` | `.github/workflows/bun-ci.yml` only |

Dictated contract (A and C must both honor): scripts `build:e2e:real` =
`cross-env NEXT_PUBLIC_E2E=1 NEXT_PUBLIC_E2E_STUB_EXPORT=0 next build`, `test:e2e:real` =
`playwright test -c playwright.real-export.config.ts`; real-export server port 3211.

## Status log

- 2026-07-17: branch created, log committed, workers A/B/C dispatched in parallel.
- 2026-07-17 (later): all three workers returned green; diffs reviewed; merged A @d6047ad0,
  B @70fde9bb, C @ba099662. Integration seam fixed by L1: real-export config's CI html
  reporter now writes `playwright-report-real-export/` to match bun-ci.yml's artifact paths
  (default dir would have overwritten the smoke report). Next: full battery + double e2e.
- Worker findings to file as queue rows: (1) anonymous editor session — `/api/studio/sets`
  401 triggers apiFetch's global unauthorized redirect to /signup mid-editing (race observed
  in real-export spec, mocked around) — ALREADY FILED as BUG12 per L0, don't double-file;
  (2) auth-flow e2e in CI is blocked by unreachable Upstash rate-limit store before Postgres
  even matters (bun-ci.yml comment documents it) — new row candidate.
- 2026-07-17 battery (final, tip @7db02a86 + this log commit):
  typecheck OK · lint: 0 issues in touched files (347 pre-existing repo-wide, no-worse) ·
  root `bun test`: 1365 pass / 44 fail vs main baseline 1355 pass / 44 fail — +10 new passes,
  zero new failures (the 44 are pre-existing env-dependent suites: health-route redis,
  proxy-encoder WebCodecs; verified identical on clean main) ·
  stub e2e ×4: takes-board-routing 7/7 green EVERY run; happy-path passed run 1, failed runs
  2–4 on the KNOWN pre-existing BUG12 bridge-unmount race (signature verified:
  `__BYORN_E2E__` undefined mid-test; being fixed by a separate campaign) ·
  real-export e2e ×2: green both runs, deterministic — ffprobe: h264 video (1.600000s exactly
  = post-trim/split timeline), aac audio present, format duration 1.671837s, 19,675 bytes ·
  GitNexus detect_changes (compare vs main): risk LOW, 0 affected processes, changed symbols
  = globalSetup/draw + E2EBridge only (auth-form entries are inverse-diff noise — main moved).
- Flake note for CI: happy-path's BUG12 flake rate appears HIGHER with the longer suite
  (busier server widens the 401-redirect race window). CI has retries=1 which may mask it;
  once the BUG12 product fix lands the flake should disappear. Do not mock around it in
  happy-path — it is currently the only repro signal.
- Territory handoff flag: any campaign fixing BUG12 may want to touch happy-path.e2e.ts /
  e2e-bridge.tsx — coordinate with this branch to avoid conflicts.

# Campaign log — bug-purge-w1 (C7, wave 1)

Branch: `campaign/bug-purge-w1` off main @3c7e41c8. L1 orchestrator worktree:
`.claude/worktrees/agent-a6e2324bb6cca173a`.

## Objective

Queue §2 repro attempts (BUG1–4) + golden-path browser bughunt with heavy media
(HEVC/GoPro/VFR/fps60/large) + surgical fix wave. Hot surfaces off-limits for fixes
(stores/*, ai-client.ts, route table, packages/env, package.json/bun.lock, migrations,
renderer/compositor/decode-scheduler, auth logic, money/credits).

## Recon findings (L1, direct)

- **BUG1 (proxy 480p odd-dimension crash): ALREADY FIXED** by proxy-worker-offload merge
  @20066e26. `computeProxyDimensions` in
  `apps/web/src/services/proxy/proxy-generator.ts` floors each axis to even (min 2),
  doc comment cites the exact 853×480 case. Regression tests exist in
  `proxy-generator.test.ts` ("snaps the reported 4K→480p case to even dimensions instead
  of 853x480", preset sweep, odd small source, tiny source). Evidence: test run on
  campaign branch (pending node_modules install). Disposition: **fixed-prior, verify tests green**.
- **BUG4 (onboarding tour arrow keys): OBSOLETE.** The first-run onboarding overlay
  (`apps/web/src/components/editor/onboarding.tsx`, 708 lines) was deleted from main
  @184d1989 (2026-07-15) — the component the bug was filed against no longer exists.
  Only surviving stepper is `shared-project-onboarding.tsx` (collab, flag-OFF per
  ADR-003, hidden in beta) which has Next/Back buttons + dots and no keyboard handler —
  noted for the collab pre-unhide pass (queue C3), not fixed here (hidden surface).
  Disposition: **not-reproducible (component deleted)**.
- **BUG3 (sign-in rate-limit toast): CONFIRMED in source.**
  `apps/web/src/components/auth/auth-form.tsx` lines 48–57: every `signIn.email` error
  gets the same "Failed to sign in" toast; better-auth rate limit (enabled, Redis-backed
  per `lib/auth/server.ts` rateLimit block) returns HTTP 429 which lands in the same
  branch. Fix = branch on `error.status === 429` with distinct copy. Error-copy only —
  no auth logic. → Worker W1.
- **BUG2 (fps60 wedge): repro attempt** → Worker W2, characterize only, no scheduler fixes.

## Worker roster (partitioned by file cluster)

| W | Task branch | Owned files | Job |
|---|---|---|---|
| W1 | task/bug3-rate-limit-toast | `apps/web/src/components/auth/auth-form.tsx` + new test | BUG3 429-copy branch + unit test |
| W2 | (none — report only) | none (fixtures in scratchpad) | BUG2 fps60 wedge repro + characterization |
| W3 | (none — report only) | none (fixtures in scratchpad) | Golden-path hunt w/ heavy media, real export + ffprobe |

## Verify plan

- Battery on campaign branch after merges: typecheck, lint no-worse, build, bun test.
- W1 fix browser-verified locally if rate limit triggerable in dev; else unit-test tier
  + code-read, recorded honestly.
- W3 export validated with ffprobe (stream codecs, duration, frame count).

## Status log

- 2026-07-17: branch created @3c7e41c8, recon done (BUG1 fixed-prior, BUG4 obsolete,
  BUG3 confirmed), workers dispatched (W1 fix, W2 BUG2 repro, W3 golden-path hunt).
- 2026-07-17: BUG1 evidence on campaign branch: `bun test src/services/proxy/proxy-generator.test.ts`
  → 9 pass / 0 fail (includes the exact 853×480 regression case).
- 2026-07-17: W1 returned `task/bug3-rate-limit-toast` @55a1f1a4 — pure helper
  `authErrorToastContent()` branching on better-auth's `BetterFetchError.status === 429`
  (field confirmed from installed type declarations), 5 unit tests, typecheck 0, biome
  clean on owned files. Diff reviewed by L1 (surgical, copy-only). Merged @74d5bc8a.
  Post-merge: typecheck 0; new tests 5/5; lint 347 errors / 225 warnings == baseline
  (no worse). Verification tier: merged + unit-tested. NOT browser-driven: better-auth
  rate limiting is enabled in production only, and enabling it in dev means editing
  auth config (off-limits for this campaign) — recorded as a conscious cap.
- Pre-existing test baseline on branch point (before any merge): root `bun test` =
  1355 pass / 44 fail / 31 errors — the bar for this campaign is no-worse.
- 2026-07-17 close-out:
  - **W2 (BUG2): REPRODUCED 3/3.** Mechanism traced read-only: 4×1080p60 layers @ fps60
    drain the prefetch ring (cap 4) → playhead outruns the 2.0s SEQUENTIAL_WINDOW →
    every `VideoCache.getFrameAt` escalates to a fully-awaited `seekToTime` re-seek on
    the render path → self-sustaining re-seek storm (one 12s hard wedge, one 15.4s
    ~1.9fps episode with full recovery, repeated 1–3s episodes; control 1-layer clean).
    Evidence: scratchpad `bug2-repro.js`, `result-fps60-{stacked,single}.json`, fixture
    ffprobes. Queue BUG2 row updated with fix candidates; fix owner = C5 (off-limits
    here by brief). No product source touched; nothing committed by W2.
  - **W3 (golden-path hunt): real export PASS** — 36.1MB h264/aac 1920x1080@30,
    duration 47.09s vs 47.0s timeline (≤1 frame), full `ffmpeg -f null -` decode clean,
    frame-content spot-checks good incl. VFR clip offset. Sign-in/seed PASS, generate
    SKIPPED (no mock seam wired — no credits spent), timeline editing PASS with
    findings. New queue rows filed: BUG7 (global 401 hard-redirect kills editor
    session — W2 hit it too), BUG8 (deleteElements TypeError guard gap), BUG9
    (10–30s main-thread stalls on timeline mutations during heavy import → C5);
    8420 health-poll leak re-confirmed (§6 C5 row annotated). Unconfirmed playback-rate
    anomaly (wall-clock methodology too noisy) noted here, NOT filed — next wave should
    re-measure with performance.now().
  - **Battery on campaign tip:** typecheck exit 0 · lint 347 errors/225 warnings ==
    baseline · root bun test 1355→1360 pass, 44 fail/31 errors == pre-existing baseline
    (failures byte-identical in count; +5 new tests all green) · `bun run build`
    exit 0 (first attempt failed only because the fresh worktree lacked gitignored
    `apps/web/.env.local` — env, not code; copied from main checkout, green).
  - Worktree-recipe note for future campaigns: fresh worktrees need `bun install` AND
    a copy of `apps/web/.env.local` before `bun run build` will pass env validation.

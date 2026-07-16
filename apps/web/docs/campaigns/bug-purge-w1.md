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
  BUG3 confirmed), workers dispatching.

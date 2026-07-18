# C16 · test-infra-trust — make the test signal trustworthy

Branch: `campaign/test-infra-trust` (off `main`). Orchestrator: Fable L1. Workers: Sonnet, worktree, background.
Kickoff: 2026-07-18. Mode: local-only (G2 deferred). All CLI, no dev server.

Territory (exclusive): test files repo-wide, test-infra/mocks, `bunfig.toml`, `.github/workflows/*`.
Off-limits: all product source (a mock-completion line in a `.test.ts` is fine); `lib/media/audio*` +
scene-exporter tests (C24); `components/**` (C15).

---

## Baseline (measured this session, `campaign/test-infra-trust` == main tip)

Full `bun test` from repo ROOT (the documented battery invocation), run 1:

```
1748 pass · 5 skip · 54 fail · 39 errors · Ran 1807 tests across 218 files
```

### Root-cause discovery — the keystone

The **54 fail / 39 error** headline is dominated by ONE cause, not five leaking mock files:

- Full `bun test` runs from the **repo root**. `apps/web/bunfig.toml` wires a `[test].preload`
  (`scripts/test-env-preload.ts`) that loads `apps/web/.env.local` into `process.env` before any test
  imports `@byorn/env`. **There is no root `bunfig.toml`**, so a root run skips that preload entirely.
- Result: `DATABASE_URL` / `BETTER_AUTH_SECRET` are undefined for the whole root run. Every route/webhook
  module that parses `@byorn/env` at import throws `ZodError` → counted as an "Unhandled error between
  tests" (the 39 errors) and reddens neighbouring tests (route-protection/BUG20, polar-webhook/BUG21,
  auth-flows, and the "5 leaking files" whose isolation-pass was measured from `apps/web`, where the
  preload DOES run).

**Proven fix (keystone):** add a root `bunfig.toml`:

```toml
[test]
preload = ["./apps/web/scripts/test-env-preload.ts"]
```

Measured full-suite result WITH the keystone (probe, this session):

```
2165 pass · 5 skip · 12 fail · 0 errors · Ran 2182 tests across 218 files
```

- 39 errors → **0**. 54 fail → **12**. +417 previously-import-blocked tests now run.
- video-cache/service, health-route, pitch-preserving-stretch fails: **all healed** (they were env/error
  casualties + contention, not independent mock leaks).

### Residual 12 fails after the keystone — characterized

| Count | File | Class | Owner |
|---|---|---|---|
| 2 | `lib/studio/__tests__/add-to-editor.test.ts` (`all-success`, `partial-failure`) | **Test-shape, NOT order-dependent** — fails in isolation too. The test relies on real `processMediaAssets` pushing an asset for a 3-byte garbage `video/mp4` File. BUG55's fix (C26 @7b671e15) made `processMediaAssets` correctly **skip** unsupported/corrupt assets → "processing produced no asset". The test's documented assumption is now invalidated. | W1 |
| 10 | `services/proxy/worker/proxy-encoder-controller.test.ts` (`generateProxyOffThread …`) | **Pure order-dependence** (15/0 in isolation). The file `mock.module("@/services/proxy/proxy-generator", …)` then `await import`s the controller. When an earlier test caches the real `@/core → media-manager → @/services/proxy → proxy-encoder-controller → proxy-generator` chain first, the cached controller's `generateProxy` binding stays real and the mock is defeated. Repro: `remove-media-asset.test.ts` before `proxy-encoder-controller.test.ts` → 1 fail. Precedent fix: `media-manager-decode-reprobe.test.ts` already mocks the `@/services/proxy` barrel to avoid caching the real chain (its pairing with proxy-encoder is clean). | W1 |

---

## Work items → dispatch

### W1 — keystone + order-dependence (test files + root bunfig)
1. Create root `bunfig.toml` with the `[test].preload` above.
2. Fix proxy-encoder order-dependence: make the real-chain leaker test(s) mock the `@/services/proxy`
   barrel (mirror `media-manager-decode-reprobe.test.ts`), OR make `proxy-encoder-controller.test.ts`
   resilient to prior caching. Prove with `remove-media-asset` + proxy-encoder paired run green, then
   full-suite.
3. Fix `add-to-editor.test.ts`: adapt the 2 tests to BUG55's skip behavior — supply a File that
   `processMediaAssets` accepts, or safely stub the proxy download to yield a supported asset, WITHOUT
   `mock.module("@/lib/media/processing")` (the file's header documents why that corrupts
   normalize-media.test.ts process-wide).
4. DoD: 3 consecutive full `bun test` runs from root with an empty or strictly-shrunk-and-characterized
   fail-set. Owns: `bunfig.toml`, `apps/web/src/services/proxy/worker/proxy-encoder-controller.test.ts`,
   `apps/web/src/lib/commands/media/__tests__/remove-media-asset.test.ts` (+ sibling media-manager real-
   barrel tests if needed), `apps/web/src/lib/studio/__tests__/add-to-editor.test.ts`.

### W2 — CH6 CI auth-flow un-skip (workflow only) — DONE, merged to campaign
- Delivered on `task/w2-ch6-ci-authflow` @1c90b63a (single-file diff, YAML-parse verified, build job
  byte-identical), merged to campaign. Adds `services:` postgres + redis:7 + srh
  (`hiett/serverless-redis-http`, same shape as docker-compose.yaml), repoints
  `UPSTASH_REDIS_REST_URL/TOKEN` at srh (`http://localhost:8079` / CI-literal token), adds a
  `bun run db:migrate` step before the e2e runs, rewrites the obsolete "No services: postgres" comment.
  Once Upstash is reachable the spec's beforeAll 500-probe returns 401 and `auth-flow.e2e.ts` stops
  self-skipping.
- L1 review fixes @186039b3: postgres:16 → **postgres:17** (docker-compose parity), and DROPPED the srh
  wget-spider health check (unauthenticated GET → 4xx → `wget --spider` fails → service wedged
  forever-unhealthy; compose defines no srh healthcheck either).
- Tier: **merged** — GitHub Actions cannot run on this host; the workflow proves itself only on a real
  Actions run after the eventual G2 push. Stated honestly, no CI-pass claim.

---

## Bug/verdict ledger

- **BUG20** (route-protection red on main): premise stale. `studio/upload-url/route.ts` is ALREADY in the
  sweep table (`route-protection.test.ts:334`, added by C6). The red was the env ZodError, fixed by the
  keystone. In isolation from `apps/web` the file is 59/0; from root WITH the keystone bunfig it is 59/0.
  → resolved by W1's keystone; no sweep-row edit needed.
- **BUG21** (polar webhook signature red — payments floor): **VERDICT = env-shape, NOT a real signature
  hole.** Both named tests (`rejects a signature made with the wrong secret`, `rejects a bad signature with
  401`) live in `polar-webhook.test.ts` and pass **14/0** when env is present (the preload also injects the
  `POLAR_WEBHOOK_SECRET` fixture). The red from root was the same env ZodError. Signature verification is
  intact. → resolved by W1's keystone. No STOP-REPORT to L0 required.

Bug IDs allocated for this campaign: BUG80–BUG84 (deduped against queue §2). None filed yet.

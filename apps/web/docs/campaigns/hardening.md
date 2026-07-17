# Campaign C6 · hardening — log

Branch: `campaign/hardening` off main @259683ee. L1 orchestrator worktree:
`.claude/worktrees/agent-a2bec864ea9c2fee8`. Started 2026-07-17.

Territory (exclusive): `app/api/**`, observability lib (`src/lib/observability/**`),
route-protection tests. BUG18 site (`src/core/managers/project-manager.ts`) explicitly
assigned by L0. OFF-LIMITS: client UI (C10), `lib/director` (C8), better-auth config
(audit-only), money/credits logic (audit + packet only), migrations, package.json.

## Parts

| Part | What | How |
|---|---|---|
| 1a | Security re-sweep app/api/** (auth gating, rate limits, secrets) | W-SEC security-reviewer, read-only |
| 1b | BUG20: route-protection test red on main — reclassify every route, GREEN honestly | W-ROUTE |
| 1c | BUG21 triage (polar/webhook tests red on main) | L1 direct — DONE, see below |
| 2 | Collab pre-unhide security pass → decision packet (ADR-003 debt; un-hide NOTHING) | W-COLLAB |
| 3 | ADR-002 vendor-alerting adapter (dep-free; new deps are gated) | W-OBS |
| 4 | Error-copy truth pass on paid paths (402/429/5xx, server-side copy only) | W-COPY |
| 5 | BUG18 console.error downgrade on expected first-load path | W-OBS (same wave, disjoint file) |
| — | Wave 2: fix wave from W-SEC findings, partitioned by file cluster | after W-SEC returns |

## File-cluster partition (no two writers share a file)

- W-SEC: writes nothing (report only).
- W-ROUTE: `src/app/api/__tests__/route-protection.test.ts` only.
- W-COLLAB: new doc `apps/web/docs/security/collab-pre-unhide-2026-07-17.md` only.
- W-OBS: `src/lib/observability/**` (+ tests) + `src/core/managers/project-manager.ts`.
- W-COPY: `src/app/api/**/route.ts` message-string-only edits (+ tests it touches);
  W-ROUTE's test file excluded.

## BUG21 triage (done, L1 direct, 2026-07-17)

Verdict: **env-shape/test-harness, NOT a real money bug. No stop.** Evidence:

- `bun test src/lib/payments/__tests__/polar-webhook.test.ts` from `apps/web`:
  **14/14 PASS** in this worktree AND in the shared checkout, both at main @259683ee.
  Wrong-secret → `WebhookSignatureError`; bad-signature route POST → 401. Real HMAC,
  real Postgres, no mocks on the verify path.
- From repo ROOT, the same file **dies wholesale on env ZodError** (DATABASE_URL /
  BETTER_AUTH_SECRET undefined): root `bun test` doesn't run `apps/web/bunfig.toml`'s
  preload, so `.env.local` + `POLAR_WEBHOOK_SECRET` test fixture never load. This is
  the C1-battery shape (C1 ran `bun test` from root).
- Paired run with `route-protection.test.ts` (the global `mock.module` suspect):
  polar still 14/14; only the known BUG20 classification test fails.
- Residual: the exact "2 named tests red" observation matches the queue-C8
  order-dependent full-suite class; my campaign battery will record whether polar
  goes red in a full run. Disposition: queue row for test-harness robustness
  (owner: whoever holds lib/payments tests), no payments code change needed.

## Status (records the past only)

- 2026-07-17: branch created off 259683ee; deps installed (frozen lockfile);
  `.env.local` copied from shared checkout (worktree test recipe).
- 2026-07-17: BUG21 triaged (above) — env-shape, payments floor intact, item closed
  without code change.
- 2026-07-17: wave 1 dispatched (W-SEC, W-ROUTE, W-COLLAB, W-OBS, W-COPY).
- 2026-07-17: L0 course-correction received — W-SEC found HIGH SSRF in 4 studio
  backend adapters (client-controlled reference URLs fetched server-side unguarded:
  google-nano-banana, google-veo, ideogram, bfl-flux). Fix surface verified first-hand
  (per-adapter fetchWithTimeout helpers; ssrf-guard.ts validateProxyTarget/pinnedFetch
  available). W-SSRF worker dispatched: shared fetchReferenceMediaSafely wrapper +
  generic error copy + private-IP rejection tests; branch `task/c6-ssrf-reference-fetch`.
  Security floor > territory line per L0; no hard gate crossed.
- 2026-07-17: W-COLLAB done → merged. Packet at
  `apps/web/docs/security/collab-pre-unhide-2026-07-17.md` @41780599. Verdict
  GO-with-fixes; 3 HIGH (invite-steal via unverified email; media/[hash] no
  repo-access check — LIVE TODAY, cloud-sync routes are unflagged; unsigned R2
  storageUrl), 4 MED, 2 LOW. NOTE: media/[hash] severity discrepancy — W-SEC/L0
  called it LOW, W-COLLAB HIGH (any signed-in user can fetch any media object by
  hash from the global CAS); surfacing both in the report.
- 2026-07-17: W-ROUTE branch merged @5fa58b03 (diff read: +11 lines, SWEEP entry for
  studio/upload-url only). Route-protection test on campaign branch: **59/59 PASS**
  — BUG20 closed, red-on-main cleared.
- 2026-07-17: W-COPY merged @f60665d6 (string/message-only, 5 paid route files).
  Credit-truth copy: 402/5xx now state "Not charged — the credit hold was released"
  on the release-then-throw paths (verified truthful: catch block calls release()).
  W-COPY surfaced 2 pre-existing credit findings (L0 dispositioned):
  (G-row, GATED) `sweepStaleHolds` (lib/credits/sweep.ts:108) has ZERO prod call
  sites — no cron, no vercel.json schedule. Abandoned/crashed jobs strand reserved
  credits with no backstop. Wiring a scheduled invocation = money-adjacent +
  deploy-config = HARD GATE. Surface to user; do NOT build. Fix shape: cron route or
  vercel.json cron calling sweepStaleHolds on an interval. MONEY FLOOR.
  (queue row, not gated) studio/image/route.ts settles the charge BEFORE persisting
  the image row (generate/promote insert-first) → DB blip post-settle = user charged,
  image made, no row, raw 500. Future money-gated wave: reorder settle-after-persist
  or compensating release. settle reorder = money logic ⇒ not fixed here.
- 2026-07-17: W-OBS merged @99131f8d. ADR-002 vendor-alerting adapter shipped
  DEP-FREE (no @sentry/nextjs — hard gate respected): generic webhook forwarder in
  logger.ts gated on `OBSERVABILITY_ALERT_WEBHOOK_URL`; unset ⇒ byte-identical no-op.
  Fail-soft (never throws/awaits on request path), 8KB payload cap, secret-redacted
  (reuses intake.redactSecrets), in-module 10/min fixed-window rate limit. Sentry-DSN
  path deliberately deferred to real SDK (documented). BUG18: not-found first-load
  downgraded to console.info keyed to exact "Project with id X not found" message;
  real load failures still error-level. +158 lines of unit tests.
- 2026-07-17: W-SSRF (HIGH fix) merged @b93339a5. Diff read: shared
  `fetchReferenceMediaSafely` (validateProxyTarget + pinnedFetch + redirect
  re-validation; generic `ReferenceFetchError`; detail logged server-side via
  logger.warn, never returned to caller). All 4 adapters routed through it;
  bfl pollOnce (provider URL) correctly excluded. +51 tests incl.
  loopback/private/DNS-rebind rejection; valid public-URL flow unchanged.

## media/[hash] adjudication (L0 asked; answer is load-bearing)

Route: `app/api/version-control/media/[hash]/route.ts`. Read in full.
- Session-gated (401 for anon) — YES. Feature-flag gated — **NO**. Repo-access /
  membership check — **NO**. It selects `mediaObjects` by hash GLOBALLY (no
  owner/repo scoping) and 302-redirects to the R2 storageUrl.
- **Reachable by ANY authenticated user TODAY: YES.** Per ADR-003, VC API routes
  intentionally stayed live and UNFLAGGED during beta. So this is NOT gated behind
  the collab un-hide — any signed-in beta user can hit it now.
- Therefore it is a **TENANCY-FLOOR item (broken object-level authZ / cross-tenant
  read), fix-now — not a collab-prep item.** The sibling `repos/[repoId]/media/route.ts`
  DOES enforce access (403 Forbidden / 404 on `visible`); the global-by-hash route
  is the inconsistent one.
- Severity reconciliation (W-SEC LOW vs W-COLLAB HIGH): land at **MED, fix-now-cheap.**
  Mitigations that pull it off HIGH-in-practice: (1) the key is a content hash — you
  must already know the object's SHA to fetch it (knowing hash ≈ possessing content);
  the route doesn't enumerate and 404s without leaking, so hashes aren't discoverable
  through it → bearer-capability, not an enumerable IDOR. (2) mediaObjects is only
  populated by the VC/collab sync path (hidden this beta) → fetchable corpus is
  small-to-empty now. But it IS live and unscoped, so it's a floor item, not deferrable.
- **Fix shape (queued, C6 territory app/api/**):** mirror the sibling route —
  resolve the object → its repo → `getRepoRole(session.user, repoId)`, 403 if no
  role; or drop the unscoped global-by-hash route in favor of the repo-scoped one.
  Left as a fix-now queue row (not self-dispatched: campaign budget spent, L0 routes).

## Final battery (campaign tip @86ce8249, run SERIALLY from apps/web)

- typecheck: **exit 0** (tsc --noEmit).
- lint: **344 errors / 225 warnings** vs 347/225 baseline ⇒ no-worse (slightly better).
- build: **exit 0** (full next build).
- C6-touched suites (reference-fetch, 4 adapters, observability, route-protection,
  polar-webhook): **146/146 pass**.
- full suite from apps/web (preload applied): **2011 pass / 10 fail**. All 10 are
  the `proxy-encoder-controller.test.ts` `generateProxyOffThread` suite — proven
  order-dependent: **15/15 in isolation**, contributes the 10 only in the full run
  = the pre-existing bun `mock.module` global-leak class (queue C8). ZERO
  C6-touched suites fail. NOTE: root `bun test` (52 fail) is the BUG21 env-shape
  artifact — the bunfig preload only loads from apps/web; run from apps/web.

## Findings summary (severity · disposition)

| # | Finding | Sev | Disposition |
|---|---|---|---|
| SSRF | 4 adapters fetch client-controlled reference URLs unguarded | HIGH | **FIXED @b93339a5** (in campaign) |
| BUG20 | route-protection sweep red on main (upload-url unlisted) | — | **FIXED @5fa58b03**, test 59/59 |
| collab-H1 | invite accept via unverified email (steal invite) | HIGH | packet — pre-unhide blocker (user gate) |
| collab-H2 | media/[hash] no repo-access check | HIGH→**MED** (adjudicated) | **fix-now tenancy** queue row (fix shape above) |
| collab-H3 | unsigned R2 storageUrl in redirect | HIGH | packet — pre-unhide blocker (user gate) |
| credit-G | sweepStaleHolds has 0 prod call sites | MONEY-FLOOR | **GATED(user)** — cron/vercel.json wiring |
| credit-Q | image route settles before persisting row | MED | queue row — money-gated wave |
| lows | VC media/[hash] (folded above) + beta-gate non-constant-time compare | LOW | queue rows |
| BUG18 | console.error on expected first-load | LOW | **FIXED @99131f8d** |
| BUG21 | polar tests red from root | — | env-shape, not a bug; closed |

Zero unreviewed HIGHs: SSRF fixed; both remaining collab HIGHs are in the
user-gated pre-unhide packet (un-hide is a hard gate); media/[hash] adjudicated
down to MED fix-now with fix shape.

Campaign complete @86ce8249. Awaiting L0 merge to main + user gates
(sweepStaleHolds money floor; collab un-hide packet).

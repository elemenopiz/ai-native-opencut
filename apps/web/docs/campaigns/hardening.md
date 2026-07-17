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

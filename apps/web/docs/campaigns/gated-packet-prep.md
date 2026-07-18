# C14 · Gated-packet prep & bookkeeping — campaign log

Orchestrator: Fable L1 · branch `campaign/gated-packet-prep`
Started 2026-07-18. LOCAL-ONLY MODE in force (G2 deferred by user; no push asks anywhere in this doc).
Orchestrator #1 (`agent-a8d543d388ab5943a`) died mid-run (API credit error, not a work problem);
RESPAWNED as orchestrator #2 (`agent-a95c30dcddf7e98df`). The #1 worktree was clean at death
(HEAD == branch tip `e7f0c526`, no in-progress merge) and has been removed; the campaign branch
was adopted into the #2 worktree for the W4 merge and this bookkeeping.

## Objective

Make every user-gated packet one-click ready, all ending PARKED on their own branches,
verified, un-merged. Plus the quiet release-notes/risk-audit refresh over the unpushed delta.

## State at kickoff (measured)

- `origin/main..main` = **225 commits**; commits since @827e36c8 (changelog base) = **21**.
- `fix/credit-audit-money-gated`: 6 commits, **430 behind main** → reconcile, not merge.
  Commits (oldest→newest): 5215c767 (#6 server-side duration/count validation),
  0bb42a62 (#7 worst-case reserve for routed stills), 5ce01de3 (#8 402-gate persona batch-still),
  29ecc6d1 (#9 grant CLI idempotence), 69f34677 (#14 async persona-still job),
  822ea00c (sweep interleave + deferred-job backstop tests). 14 files, +1226/−223.
- `feat/upscale-backend`: 2 commits (6acac9da, a7232eaa), **328 behind main**. 26 files, +1981/−8.
  Migrations on main now end at **0011** → the branch's 0012 slot is still free, but its
  `migrations/meta/_journal.json` predates main's 0010/0011 entries → journal reconcile needed.
  Known pre-merge fix to apply: clamp Topaz/Clarity upscale factor ≤4.
- **No vercel.json and no cron routes exist on main** (grepped) → G8 worker establishes the pattern.
  `sweepStaleHolds` lives at `apps/web/src/lib/credits/sweep.ts` (settle-aware; tested in
  `lib/credits/__tests__/sweep.test.ts`), zero production call sites.
- Baselines carried: lint ~346e/225w (bar = no-worse); full `bun test` order-dependence
  fail-set ~52 fails / 5 files, all pass in isolation — judge as deltas, rerun a red suite once.

## Plan / partition (one worker per packet; disjoint by construction — each packet is its own branch off main, never cross-merged)

| W | Task | Output branch | Verify |
|---|---|---|---|
| W1 (sonnet) | Money packet reconcile: port the 6 commits semantically onto today's main | `gated/credit-audit-rebased-2026-07-18` | typecheck + credits suites + credit-metering + generate-route tests |
| W2 (sonnet) | Upscale refresh: port 2 commits, journal reconcile (0012 stays), factor≤4 clamp; NO migration applied | `gated/upscale-rebased-2026-07-18` | typecheck + upscale/cost-table/route-protection tests |
| W3 (sonnet) | G8 cron draft: CRON_SECRET-gated route calling sweepStaleHolds + apps/web/vercel.json cron + route tests | `gated/g8-sweep-cron` | typecheck + new route tests + route-protection test |
| W4 (sonnet) | Release-notes + per-merge risk audit: CHANGELOG-2026-07-18.md extending the 07-17 base over 827e36c8..main | `c14/release-notes-2026-07-18` → merged into campaign branch | docs review by L1 |

ID range: BUG36–BUG39 (checked queue §2 — no existing rows cover these packets' surfaces).

## Status (records the past only)

- 2026-07-18: kickoff — recon done, plan committed.
- 2026-07-18: W1–W4 dispatched (sonnet, isolated worktrees, background) per the partition table.
- 2026-07-18 (orchestrator #2 respawn): audited all four branches against git; verified W3+W4
  independently; merged W4 docs into the campaign branch; confirmed W1+W2 still alive and
  mid-battery (live `tsc`/`biome` processes on their worktrees under heavy host contention).

## Packet notes

### W3 — G8 sweep cron (`gated/g8-sweep-cron` @39375f8d) — VERIFIED, PARKED, GATED (G8)

Independently verified by orchestrator #2 (git trust, not the worker's report):

- **Sha resolves** (`git cat-file -t 39375f8` = commit). Diff = **+257, 5 files, additive only**:
  new route `app/api/cron/sweep-stale-holds/route.ts` (+88), its test (+149), `vercel.json` (+8,
  new file), `packages/env/src/web.ts` (+8, `CRON_SECRET`), route-protection sweep-table row (+4).
- **Route is fail-closed and secret-gated, not session-gated** (correct — no human caller):
  `CRON_SECRET` unset → **503** (never fall-open); bearer mismatch → **401**; match → runs
  `sweepStaleHolds({ minutes: 60 })` and returns its stats; sweep throw → **500** with a coarse
  message (no driver/provider internals leaked). Constant-time compare via `node:crypto`
  `timingSafeEqual` with a length short-circuit (repo precedent: `beta-gate` `constantTimeEquals`).
  `dynamic = "force-dynamic"`, `runtime = "nodejs"`.
- **Cadence** `vercel.json` `*/30 * * * *`; `SWEEP_CUTOFF_MINUTES = 60` ⇒ a stale hold is caught
  within ≤90 min (reconciliation job, not a latency path) while never racing a live job (`poll`
  already SKIPs per-hold). `CRON_SECRET` documented as optional-but-NOT-safe-to-leave-unset.
- **Route-protection sweep table** updated so the "every route classified" assertion still passes
  with the new route (classified PUBLIC = secret-gated).
- **Spot-run (this session):** `bun test .../cron/sweep-stale-holds/__tests__/route.test.ts` →
  **5 pass / 0 fail, 17 expect()** (503 fail-closed · 401 missing header · 401 wrong header ·
  200 runs-sweep · 500-no-leak). `bun run typecheck` in the W3 worktree → **exit 0**.
- **GATE (G8):** money-adjacent + deploy-config (`vercel.json` cron + `CRON_SECRET` env). Ships
  only via user-reviewed gated branch + the env var provisioned in Vercel. UN-MERGED, LOCAL-ONLY.

### W4 — release-notes / risk audit (`c14/release-notes-2026-07-18` @905399b6) — VERIFIED, MERGED into campaign

- **Sha resolves**; diff = **docs-only, 1 file** (`apps/web/docs/CHANGELOG-2026-07-18.md`, +160).
- Extends the 07-17 base over `827e36c8..main`; honest verification tiers (nothing claims above
  what its commit/diff supports); **10-row per-merge risk audit** with files/risk/verification/
  rollback columns; correctly flags the two MED rows (enhance-prompt token-budget cost-adjacency;
  verified-asset kind → wrong Seedance field can waste a paid call). No schema/auth/payment paths
  in range — matches the diff.
- **Count drift (cosmetic, not a defect):** doc states 21 commits / 225 `origin/main..main`, which
  was accurate at W4's write-time (merge-base `6b4a1de2`). Main has since advanced **+1** to
  `a47d0bc7` (`docs(queue): G7 partial answers`, docs-only) ⇒ now 22 / 226. One docs commit is
  uncovered; immaterial for a docs deliverable. Not re-run.
- **Disposition:** merged into `campaign/gated-packet-prep` via `--no-ff` (docs-only, zero
  conflicts) — merge commit **f33abe55**.

### W1 — money packet reconcile (`gated/credit-audit-rebased-2026-07-18` @d765de24) — VERIFIED, PARKED, GATED (money floor)

Worker completed all 6 semantic ports; orchestrator #2 independently verified against git:

- **6/6 commits, each with a port-note body** mapping to its source commit:
  `100edabe`←5215c767 (#6 server-side duration/count validation; `clampVideoSeconds` +
  `clampImageCount` in cost-table, 400 on garbage before any paid work, clamp into the ROUTED
  backend's `durationRangeSec`, clamped value drives spec+request+set row+hold identically) ·
  `f042168c`←0bb42a62 (#7 `worstCaseImageCost` = true max over `IMAGE_SALE_FLAT`, used by BOTH
  persona-still call sites; settle-exceeds-hold clamp in `ledger.settle` — LOUD structured
  errors `credits.settle_exceeds_hold` / `settle_without_reserve` / `settle_clamped_at_zero`,
  `requested` preserved in metadata; shared `openHoldFor` extracted from release's existing
  logic, both under the account lock) · `4a787d5b`←5ce01de3 (#8 batch-still fetch 402-gated via
  `gateOn402` in generation-form) · `d65003be`←29ecc6d1 (#9 grant CLI: default = unique nonce
  key so repeat grants APPLY, `--key` opts into idempotence, no-op reported loudly with
  before→after balance) · `986bbe92`←69f34677 (#14 persona-still moved behind reserve→job→poll→
  settle: BOTH holds reserved before the response — still-hold refunded if the video 402s —
  new `lib/run-after.ts` wraps Next `after()` with detached-task test fallback + reportError
  funnel; take row IS the job record, poll route resolves jobId=takeId, short-circuits
  pending/failed before `pollVideo`, settles by take id; deferred catch stamps errorMessage and
  releases both holds) · `d765de24`←822ea00c (test-only: sweep-level settle-vs-release
  interleave regression + deferred-job crash-backstop pin — confirms sweep's existing "nothing
  verifiable delivered" branch already refunds a dead deferred job).
- **Diff read in full by orchestrator (money code):** 13 files +1002/−205. Tenancy check on the
  poll route preserved (ownerId, legacy set fallback). Reserve-before-dispatch, per-job charge
  ids, release-on-failure, 402 shape, and idempotency keys all intact. No schema change
  (errorMessage/providerJobId are pre-existing nullable columns — no migration).
- **Tests (orchestrator-run in the W1 worktree):** full `src/lib/credits/` red under sibling
  load (DrizzleQueryError + 5s timeouts, different victims each run = the known shared-Postgres
  false-red class); **all green in isolation**: sweep **11/11**, ledger **15/15**,
  cost-table+courtesy **38/38**, studio credit-metering **23/23**.
- **Typecheck: exit 0 (definitive).** The worker's own `tsc` never completed (host exhaustion —
  load ~16, the orphaned process accrued only ~3 min CPU over 50+ min and was killed as a
  zombie); the orchestrator's own `bun run typecheck`, run in the W1 worktree at @d765de24,
  completed with **pipeline exit 0 and zero tsc errors**.
- **Worker caveat (correct call):** `detect_changes` can't see worktree branches, so the worker
  substituted manual `impact()` runs per touched symbol — the right fallback.
- **GATE:** money floor — user-reviewed merge only. PARKED, UN-MERGED, LOCAL-ONLY.

### W2 — upscale refresh (`gated/upscale-rebased-2026-07-18` @e4339f3f) — VERIFIED, PARKED, GATED (migration)

Worker died in its verification tail (last commit 03:09, clamp written 04:08, zero live
processes by 06:36); orchestrator #2 verified its complete-but-uncommitted clamp and
adopt-committed it:

- **Branch = 3 commits:** `f70dbcee`←6acac9da (tiered fal.ai upscale backend, video+image, 26
  files) · `cbb523bb`←a7232eaa (default-to-Topaz + tier menu) · `e4339f3f` (factor≤4 clamp,
  committed by the orchestrator after verification — commit body records the adoption).
- **Clamp reviewed in full:** `clampUpscaleFactor` + `MAX_CLIENT_UPSCALE_FACTOR = 4` in
  `upscale/fal-client.ts`; applied in BOTH `estimateCost` and `submit` for Topaz video and
  Clarity image (flat/tiered billing makes an unclamped `targetScale` an uncontrolled cost
  lever — Topaz accepts 8× for the same charge); malformed input → adapter default, never
  NaN/negative to the provider. +7 tests incl. a scope pin that the cheaper tiers
  (ByteDance/SeedVR2/ESRGAN) are intentionally unclamped.
- **Tests (orchestrator-run in the W2 worktree, WITH the clamp):** upscale suite **20/20**,
  cost-table **33/33**, route-protection **61/61**. (First upscale run red = missing
  `.env.local` in the worktree — env-parse ZodError, the known worktree gap; copied from the
  main checkout, rerun green.)
- **Typecheck (orchestrator-run, with the clamp): exit 0.**
- **Migration 0012 rides the branch, NEVER applied — verified against the local DB:**
  `takes.backend_id` / `takes.kind` columns absent, `drizzle.drizzle_migrations` count
  unchanged (11 rows). `_journal.json` reconcile (0010/0011 entries) is committed on-branch.
- **GATE:** migration + money-adjacent (credit cost table) — user-reviewed merge + migration
  apply only. PARKED, UN-MERGED, LOCAL-ONLY.

## Close-out

**COMPLETE (orchestrator #2).** All four packets verified; three gated branches end PARKED,
verified, UN-MERGED; the docs packet is merged into this campaign branch. Nothing merged to
main, nothing pushed, no migration applied (LOCAL-ONLY MODE intact).

| Packet | Branch | Tip | State | Evidence |
|---|---|---|---|---|
| W1 money packet | `gated/credit-audit-rebased-2026-07-18` | `d765de24` | **VERIFIED · PARKED · GATED(money)** | 6/6 ports diff-read; suites green in isolation (11/11 · 15/15 · 38/38 · 23/23); typecheck exit 0 |
| W2 upscale | `gated/upscale-rebased-2026-07-18` | `e4339f3f` | **VERIFIED · PARKED · GATED(migration 0012)** | 20/20 · 33/33 · 61/61, typecheck 0, DB confirmed 0012-unapplied |
| W3 G8 cron | `gated/g8-sweep-cron` | `39375f8d` | **VERIFIED · PARKED · GATED(G8)** | 5/5 route tests, typecheck 0, diff reviewed |
| W4 release-notes | `c14/release-notes-2026-07-18` | `905399b6` | **VERIFIED · MERGED→campaign** (f33abe55) | docs-only, 10-row risk table, counts accurate at write-time |

Bugs: **none filed** — all four diffs were clean; no defect surfaced that warrants a BUG36–39
row. (Range reserved; deduped against queue §2.) Incidental repairs made in passing: killed the
W1 worker's orphaned/starved `tsc` (zombie of an exited process); copied `.env.local` into the
W2 worktree (the known worktree env gap); force-removed W3's worktree after an interrupted
removal left it partially deleted (branch unaffected — committed state is the source of truth).

**Territory RELEASED.** Dead orchestrator-#1 worktree removed; W3/W4 worker worktrees removed
(branches persist). W1/W2 worker worktrees + the `fix/credit-audit-money-gated` /
`feat/upscale-backend` source worktrees are left for L0's kill-list pass — their branches are
the deliverables; the old source branches are now superseded by the rebased ports and are
kill-candidates after user review of the packets.

**For the user (the three one-click packets, in review order):**
1. `gated/g8-sweep-cron` — smallest, closes G8 (money floor); needs `CRON_SECRET` set in
   Vercel before/with the merge.
2. `gated/credit-audit-rebased-2026-07-18` — the 6-item money audit, reconciled to today's
   main; review focus: `ledger.settle` clamp + the deferred persona-still job.
3. `gated/upscale-rebased-2026-07-18` — upscale feature; merging it means applying migration
   0012 (gate) and provisioning `FAL_KEY`.

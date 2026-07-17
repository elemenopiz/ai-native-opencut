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

### W1 — money packet reconcile (`gated/credit-audit-rebased-2026-07-18`) — IN PROGRESS (alive)

- **4 of 6 commits ported** as of respawn audit: `100edabe` (#6 server-side duration/count
  validation + video-by-resolution pricing), `f042168c` (#7 worst-case reserve for routed
  stills), `4a787d5b` (#8 402-gate persona batch-still), `d65003be` (#9 grant-CLI idempotence).
  **Still to port:** #14 async persona-still (`69f34677`) + the sweep-interleave / deferred-job
  backstop tests (`822ea00c`).
- **Alive, not stalled:** last commit 04:21; worker process live at audit time (`biome format`
  running on its worktree). Verification (typecheck + credits/metering/generate-route suites) and
  final packet notes pending its completion. Ends PARKED + GATED (money floor), UN-MERGED.

### W2 — upscale refresh (`gated/upscale-rebased-2026-07-18`) — IN PROGRESS (alive)

- **Both port commits landed:** `f70dbcee` (#6acac9da tiered fal.ai upscale, video+image),
  `cbb523bb` (#a7232eaa default-to-Topaz + tier menu). **Migration 0012 + `_journal.json`
  reconcile are committed and ride the branch** (0012 slot free on main; NEVER applied).
- **factor≤4 clamp in progress (uncommitted):** `clampUpscaleFactor` / `MAX_CLIENT_UPSCALE_FACTOR
  = 4` written in the working tree (`upscale/topaz-video.ts`, `clarity-image.ts`, `fal-client.ts`,
  `+ upscale.test.ts`) at 04:08; worker process live at audit time (`tsc --noEmit` running its
  battery before commit). **Not stalled** — the commit-gap was battery time under host contention.
- Verification (typecheck + upscale/cost-table/route-protection suites) and final packet notes
  pending. Ends PARKED + GATED (migration 0012 must never be applied), UN-MERGED.

## Close-out

**Partial (orchestrator #2, budget-bounded).** Campaign branch tip after W4 merge:
`campaign/gated-packet-prep` @ **f33abe55**.

| Packet | Branch | Tip | State | Evidence |
|---|---|---|---|---|
| W3 G8 cron | `gated/g8-sweep-cron` | `39375f8d` | **VERIFIED · PARKED · GATED(G8)** | 5/5 route tests, typecheck 0, diff reviewed |
| W4 release-notes | `c14/release-notes-2026-07-18` | `905399b6` | **VERIFIED · MERGED→campaign** (f33abe55) | docs-only, 10-row risk table, counts accurate at write-time |
| W1 money packet | `gated/credit-audit-rebased-2026-07-18` | `d65003be` | **IN PROGRESS (alive)** — 4/6 ported | see W1 packet note; verify pending |
| W2 upscale | `gated/upscale-rebased-2026-07-18` | `cbb523bb` | **IN PROGRESS (alive)** — clamp uncommitted | see W2 packet note; verify pending |

Bugs: **none filed** — W3/W4 diffs were clean; no defect surfaced that warrants a BUG36–39 row.
(Range reserved; deduped against queue §2.)

**Remaining shepherding for L0 / next orchestrator:** poll W1 to 6/6 (#14 `69f34677` +
sweep-interleave tests `822ea00c` still to port) and W2 to clamp-committed; then run each
branch's battery (W1: typecheck + credits/metering/generate-route; W2: typecheck +
upscale/cost-table/route-protection), quote green evidence in the W1/W2 packet notes, mark both
PARKED+GATED+UN-MERGED, and release the two worker worktrees + `fix/credit-audit-money-gated` /
`feat/upscale-backend` source worktrees. All three gated branches stay UN-MERGED, nothing pushed.

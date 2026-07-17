# C14 · Gated-packet prep & bookkeeping — campaign log

Orchestrator: Fable L1 · worktree `agent-a8d543d388ab5943a` · branch `campaign/gated-packet-prep`
Started 2026-07-18. LOCAL-ONLY MODE in force (G2 deferred by user; no push asks anywhere in this doc).

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

## Packet notes

(filled as workers return)

## Close-out

(pending)

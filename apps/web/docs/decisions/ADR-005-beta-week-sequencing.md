# ADR-005: Beta-week sequencing — deploy first; defer the money refactor

**Date:** 2026-07-12 · **Status:** Accepted · **Owner:** Fable (advisor), user + Orchestrator execute

## Context

Beta committed 2026-07-12: **~1 week out (~2026-07-19), <20 trusted users, scope =
core edit loop + export, and Director/AI generation.** Risk posture: ship-fast,
floors (money/auth/data/migrations) hard. The app has never run anywhere but the
developer's Mac; `origin/main` is 19 commits behind local; DEPLOY.md is an
untested runbook; the e2e "export" asserts against a stubbed renderer, so real
encode has never been machine-verified end-to-end.

## Decision

Sequencing for the week, in order — later steps are negotiable, the first two are not:

1. **Reach a pushable tree** (local-AI WIP stops per ADR-004; collab hidden per
   ADR-003; battery green) → push main.
2. **Execute the first production deploy within 48 hours** (by 2026-07-14) per
   DEPLOY.md — fresh managed Postgres applying migrations 0001–0008, R2, Upstash,
   Polar webhook at the real URL, `RESEND_API_KEY` set (auth verify/reset emails
   depend on it), provider keys with spend caps. Deploy-first because every
   remaining unknown-unknown lives there, and every subsequent fix should be
   validated against the real environment.
3. **Hands-on core-loop verification on the deployed app**: real media → edit
   (mask, transition, speed ramp) → **real export → play the file**; plus one real
   paid Director generation end-to-end (credits reserve→settle observed).
4. **Auth insurance**: discard the dead auth-tests worktree
   (`worktree-agent-abc79021bb8a6f12c`), re-run the brief (401 sweep,
   signup/login/logout e2e, delete-account, reset-leak). Test-only.
5. Remaining days: fix what 2–4 surface; nothing new lands that isn't a fix.

**Deferred past beta, deliberately:** money packet #14 (async persona-still) and
credit LOW findings #6–#10. At <20 trusted users every residual failure mode
under-charges *us* (sweep refunds a completed closed-tab job; a killed persona
render strands a hold until sweep) and never over-charges a user. Rearranging
reserve/settle timing under deadline pressure is how money bugs get introduced —
that work happens post-beta with usage data. Also deferred: biome #5c (454 lint
errors), NOT-NULL flip #13 (explicitly post-deploy), songs tab (fix FREESOUND key
at deploy or hide the tab — deploy-day call).

## Tension (velocity / durability / diligence)

- Deploy-first is a **velocity** play that buys **durability** information: it
  converts unknown-unknowns into a fixable list while there's still a week.
- Deferring the money refactor looks like a durability sacrifice but isn't: the
  ledger core is audited-sound, the residual risk is bounded and self-inflicted,
  and the floor rule is about *user* money and data integrity — both hold.

## What would change this

If the deploy or hands-on pass surfaces a defect that over-charges users, loses
their data, or crashes the core loop, that defect preempts everything above it —
including the beta date.

# ADR-001: Private-beta deploy stack — Vercel + managed Postgres

**Date:** 2026-07-11 · **Status:** Accepted (two-way door) · **Owner:** Fable (advisor), user executes

## Context

Private beta target is ~1–2 weeks out. The app has only ever run on the developer's
Mac (brew Postgres, local env). Config & Deploy is 🔴 on PROD-READINESS: no runbook,
env schema unverified. A root Dockerfile with Next `output: "standalone"` exists
(upstream OpenCut heritage) but nobody has exercised it against a real host. The
developer is product-strong / eng-shallow — ops burden must be near zero.

## Decision

Deploy the private beta on **Vercel** (Next.js 15 app router, zero-config) with
**managed Postgres (Neon or Supabase)**, keeping the existing **Upstash Redis** and
**Cloudflare R2** as-is. The Dockerfile stays in-repo as the documented escape hatch.

## Tension (velocity / durability / diligence)

- **Velocity wins here.** Vercel is the fastest path to a URL for a solo,
  eng-shallow founder; every alternative (Docker on a VPS, Fly, Railway) adds ops
  surface with no beta-stage payoff.
- **Durability cost accepted:** serverless function limits (duration/body size) may
  pinch long-running generation routes later; the generation flow is already
  poll-based which mitigates this. If a route exceeds limits, that route moves to a
  worker — not the whole app.
- **Diligence:** neutral. Vercel+Neon is a story any acquirer/investor accepts at
  this stage.

## Risk accepted

Some rework if we outgrow Vercel (vendor-specific env/SHA vars, function limits).
Reversible: standalone Docker build is maintained and documented in DEPLOY.md.

## What would change my mind

A generation or export route that fundamentally can't fit serverless limits and
can't be made poll/queue-based — then the app tier moves to Docker (Fly/Railway)
and this ADR gets superseded.

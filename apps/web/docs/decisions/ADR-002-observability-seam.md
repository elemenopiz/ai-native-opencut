# ADR-002: Observability = own thin seam now, provider SDK later

**Date:** 2026-07-11 · **Status:** Accepted (two-way door) · **Owner:** Fable (advisor), user executes

## Context

Observability is 🔴: zero error reporting, zero structured logging. The user's
launch posture is ship-fast/patch-live with a private beta in ~1–2 weeks — that
posture is only viable if breakage is visible. PROD-READINESS records "provider
choice = user decision", which blocks installing a vendor SDK autonomously.

## Decision

Build a **provider-agnostic seam** with no new dependencies:

1. `lib/observability/logger.ts` — tiny structured logger (JSON lines in prod,
   pretty in dev) exporting `reportError(error, context)` — the single seam.
2. `instrumentation.ts` `onRequestError` — Next 15 hook capturing all unhandled
   server/route errors centrally.
3. Client error boundaries (`global-error.tsx` + editor `error.tsx`) and a
   `window.onerror`/`unhandledrejection` hook, reporting to
4. `POST /api/telemetry/error` — unauthenticated but rate-limited (~10/min/IP),
   size-capped, zod-validated, secret-redacting intake that feeds `reportError`.

Server errors land in host logs (Vercel log drain / Docker stdout) as parseable
JSON; client errors land there too via the intake route. A future Sentry (or
similar) adapter is a change to exactly one file (`reportError`'s body) plus a DSN
env var — the user picks the vendor when ready.

## Tension

- **Velocity:** ~1 agent-day, no account signup, no build-pipeline changes
  (@sentry/nextjs wraps webpack config — real risk of build churn the week before
  beta).
- **Durability:** the seam is the durable part; vendor choice is deliberately
  deferred, not skipped. Cost: no error grouping/alerting UI until a vendor is
  plugged in — for a 10–50-user beta, grep-able structured logs suffice.
- **Diligence:** honest story — "instrumented from day one, vendor-agnostic".

## Risk accepted

During beta the developer must actually look at host logs (no push alerts). If
that proves too passive, plugging in Sentry free tier is a ~30-minute follow-up.

## What would change my mind

If beta scale or error volume makes log-grepping impractical in week one — adopt
the vendor immediately; the seam makes that cheap by design.

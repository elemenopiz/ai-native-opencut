# ADR-006 — Advisory-first critics; autonomous fix-loops are gated and ceiling-bound

Date: 2026-07-19 · Status: accepted (orchestrator Step-0 red-team, Director-intelligence mission)

## Context

The Director-intelligence architecture (`docs/plans/2026-07-19-director-intelligence-architecture.md`)
adds a whole-edit critic (`critiqueEdit`) whose natural end-state is a closed
critique→fix loop chasing a quality bar. An autonomous loop that decodes frames, calls a
vision model, and executes editing verbs can burn real money (API spend now; user credits
once billed) with no natural stopping point — the architecture doc's one-way door #5.

## Decision

1. **Any AI critic ships advisory-first.** v1 emits a structured critique whose proposed
   fixes are executable verbs, but never executes them itself. A fix runs only on an
   explicit user action (or an explicit user command that names the fix).
2. **Autonomous critique→fix loops are a gated feature**, not an iteration of the critic:
   turning one on requires a user gate and MUST ship with (a) a hard iteration ceiling,
   (b) a hard per-run spend ceiling, and (c) a user-visible "good enough — stopped" state.
3. **New paid AI operations do not self-wire into credits.** Billing wiring for a new op
   (reserve→settle) is money-floor code → its own gated, user-reviewed branch. Until then
   the op stays flag-gated with hard resource caps (e.g. ≤12 sampled frames, single model
   call, manual invoke).

## Consequences

- The "wow" ships sooner (advice is cheap and safe); the loop lands later, deliberately.
- Every future critic-like surface (audio critic, thumbnail critic, …) inherits this shape
  by default; deviations need a new ADR.

# ADR-004: Park the browser-first local-AI migration until after beta

**Date:** 2026-07-12 · **Status:** Accepted (two-way door) · **Owner:** Fable (advisor); the local-AI session executes the stop

## Context

The browser-first local-AI plan (approved 2026-07-12, design doc
`docs/plans/2026-07-12-local-ai-browser-first-design.md`) kills all 9 Python AI
services, moves CLIP/face understanding in-browser, and routes TTS/generative to
cloud APIs. Execution started: an uncommitted 13-file WIP sits in the **shared
primary checkout** (guts `settings.tsx` −352 lines, rewires `ai-panel-wrapper`,
extends `asset-understanding-service`). The beta is ~1 week out, <20 users, and
the user scoped local-AI **out** of the beta.

## Decision

**Freeze the migration until after beta ships.** The executing session should
drive to the nearest clean state — commit if the WIP is internally coherent and
battery-green (the design's swappable seams make partial landings safe), otherwise
stash/branch it — and then stop. No further local-AI tasks are dispatched this
week.

The design's **delete-last** rule is what makes this free: the Python services
remain untouched and working, so nothing a beta user touches degrades by pausing.

## Tension (velocity / durability / diligence)

- **Velocity to BETA wins over velocity on the migration.** Rearchitecting the
  understanding stack in the launch week is scope creep with real destabilization
  risk (the WIP already deletes UI whole panels depend on).
- **Durability:** unaffected — the plan resumes intact; seams are already designed.
- **Diligence:** unaffected.

## Risk accepted

One-week delay on the local-AI roadmap, and a parked branch that may need a rebase
over beta-week fixes. Both trivially recoverable.

## What would change this

If the WIP session reports it is <1 day from a fully-green, behavior-neutral
landing (replacements wired behind seams, no deletions of live paths), landing it
before the push/deploy freeze is acceptable — half-states are not.

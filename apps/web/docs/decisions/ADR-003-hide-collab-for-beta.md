# ADR-003: Hide shared-projects/collab UI for the private beta

**Date:** 2026-07-12 · **Status:** Accepted (two-way door) · **Owner:** Fable (advisor), Orchestrator executes

## Context

Shared projects (invite-by-email, roles, clone, branch onboarding) merged to main
@7e1b5b56 on 2026-07-12 — days before a ~1-week, <20-user private beta. The user
explicitly scoped the beta to **core edit loop + export** and **Director/AI
generation**; collab is out. The feature sits directly on the auth/tenancy floor
(new multi-tenant surface: `project_members`, `project_invitations`, `getRepoRole`
seam, migration 0008) and has unit/route tests but zero real-world exercise and no
dedicated post-merge security pass.

## Decision

**Hide the collab UI behind a default-off flag for beta. Do not revert the merge.**

- Add `NEXT_PUBLIC_FEATURE_COLLAB: z.enum(["true","false"]).default("false")` to
  `packages/env/src/web.ts` (no feature-flag system exists; one env var is the
  smallest seam and matches house env style).
- Gate the three UI entry points on it:
  `components/projects/shared-projects-section.tsx` (mounted in
  `app/projects/page.tsx`), the share dialog wiring in
  `components/editor/version-control-drawer.tsx`, and
  `components/editor/dialogs/shared-project-onboarding.tsx` /
  `shared-project-provider.tsx` if they render affordances when the flag is off.
- **API routes stay live and unflagged** — they are session-gated and role-checked
  (`getRepoRole`), and flagging server routes adds risk for no beta payoff. The
  flag removes discoverability, not the security boundary; the routes' own auth IS
  the security boundary either way.
- Migration 0008 ships with the deploy (it also created the previously-unjournaled
  `vc_*` tables — rolling it back is not on the table).

## Tension (velocity / durability / diligence)

- **Velocity wins:** hiding is ~S effort and removes an entire hardening
  workstream (invite-flow abuse, role-escalation review, email deliverability
  testing) from the critical week.
- **Durability cost accepted:** the flag is a temporary seam, deleted at collab
  launch. Dead-looking code on main for a few weeks.
- **Diligence:** neutral-positive — "we gate unhardened surfaces" is a good story.

## Risk accepted

A determined beta user could still hit the collab API routes directly. Accepted:
routes are auth-gated and owner-checked, users are <20 and trusted, and the same
routes would be exposed if we shipped the UI anyway.

## What would change this

If a beta user's core workflow turns out to require handoff to a teammate, flip
the flag for that cohort — that's the reversibility we're paying one env var for.

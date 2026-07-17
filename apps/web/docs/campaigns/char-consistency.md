# Campaign C2 — char-consistency (moat #1)

Branch: `campaign/char-consistency` off main @1f9e9164. L1 orchestrator log — crash-survival state.

## Objective (ladder card C2)

Persona/seed-lock end-to-end UX: create persona → reference intake → seed-locked take
chains → reuse across projects; StyleBible surfaced in Generate panel; Runway Aleph
interim real-face route behind a flag. DoD: a stranger keeps ONE character consistent
across 3 generations without docs, verified locally with screenshots (mocked provider
calls — the consistency *machinery* is what's verified, never real credits).

## Recon findings (2026-07-17, pre-partition)

Prior art is FAR deeper than the ladder card assumed — this is gap-closure, not greenfield:

- **Personas: DB-backed per-USER** (`schema-studio.personas`, session-scoped userId) →
  cross-project reuse is structurally free. API: `/api/studio/personas` (+`[id]`,
  `[id]/still`). Client: `stores/persona-store.ts` (server-backed list, session-scoped
  active selection).
- **Generate panel** (`views/generate.tsx`): 4 tabs — Video/Image/Audio/**Personas**
  (PersonaManager mounted). `generation-form.tsx` already threads activePersona:
  consistency modes (fast=anchor image / high=per-shot still via `[id]/still`),
  `personaId` in spec, refs into omni-reference. **No user-facing seed control by
  design** — server pins a concrete seed per take for provenance/promote.
- **Seed-lock lib** (`backends/seed-lock.ts`): cross-backend identity normalizer
  (seed / reference / seed+reference / none) — mature, tested.
- **Take chains**: `remix.ts` carries prior seed with `seedLocked: true`;
  `remix-popover.tsx`, `take-provenance-badge.tsx`, `generative-clip-properties.tsx`
  exist.
- **StyleBible**: produced by `lib/director/reference-intake.ts`, consumed in the
  Director view (`views/director.tsx` L374) — NOT surfaced in the Generate panel.
- **Runway/Aleph**: `backends/video/runway.ts` EXISTS (Gen-4 + video_to_video Aleph,
  tests) — flag/route-for-real-faces status to confirm.
- **Verified-asset seam**: `lib/studio/saved-verified-assets.ts` = BytePlus real-human
  `asset://` shortlist (localStorage, owner-scoped) — the partner-access prep exists.

Full wired-vs-orphaned gap map: recon worker (Explore, in flight) — results below.

## Constraints

- Territory: studio generation UI + director persona/reference/seed verbs + lib/studio.
  OFF-LIMITS: MCP/toolCatalog, renderer/compositor/video-cache/**stores/*** (persona-store
  edits ⇒ queue-row for C5), auth/money/credits server-side, migrations, package.json,
  export surfaces.
- UI workers load `frontend-design`; align with C4-A "Instrument-Grade Minimal"
  (docs/design/2026-07-17-ui-direction-phase-a.md); no new gradients/glow.
- Never merge to main, never push. Mocked provider calls only.

## Plan (pending recon confirmation)

1. W-recon (Explore, running) → gap map.
2. Partition workers by file cluster over the confirmed gaps (draft):
   - W1 persona UX chain: Generate-panel persona selection affordance on the composer
     (not buried in tab 4), 3-take chain affordance ("keep this character"), StyleBible
     chip surfacing. Files: components/studio/* + views/generate.tsx.
   - W2 lib/adapters: seed/persona threading gaps, Aleph real-face flag seam,
     verified-asset adapter prep. Files: lib/studio/backends/*, lib/studio/*.
   - W3 e2e + mocked-provider verification spec. Files: e2e/*, __tests__.
3. Battery + browser-verify the 3-generation walkthrough with screenshots.

## Worker log

| Worker | Brief | Branch | Status |
|---|---|---|---|
| W-recon | wired-vs-orphaned gap map | (read-only) | in flight |

## Verification evidence

(pending)

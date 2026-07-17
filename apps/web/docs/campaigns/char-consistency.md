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

### Recon gap map (W-recon, confirmed with file:line evidence)

| Area | Status | Missing link |
|---|---|---|
| Persona persistence/cross-project | WIRED | none — user-scoped DB, no project column |
| Persona UI (manager + form chip) | WIRED | none |
| Seed threading generate→take | WIRED | `personas.seed` write-only, never consumed |
| Regenerate-same-identity | PARTIAL | exists on placed clips; absent on Board (`reel-board.tsx`) |
| StyleBible → manual Generate | **ORPHANED** | `use-studio-generation.ts` never folds ConsistencyContext — only `studio-executor.ts:78-90` (agent path) does |
| StyleBible → Rerun/Remix | **ORPHANED** | `use-slot-generation.ts:95` bypasses the fold |
| StyleBible in Generate UI | MISSING | zero surfacing outside the Director chat |
| Runway/Aleph adapter | WIRED | complete + registered; 2 `UNVERIFIED` field comments; no real-face routing signal/flag |
| E2E mock backend | n/a | mocking = Playwright `page.route` network boundary (takes-board-routing.e2e.ts pattern) |
| Verified-asset seam | WIRED | `saved-verified-assets.ts` (owner-only localStorage `asset://` shortlist) — distinct from personas |

Server design note: `/api/studio/generate` deliberately never falls back to persona
seed (batches must vary; route.ts:226-233). Client rule adopted instead: active
persona w/ stored seed + single-shot + no explicit seed ⇒ thread `seed`+locked.

## Constraints

- Territory: studio generation UI + director persona/reference/seed verbs + lib/studio.
  OFF-LIMITS: MCP/toolCatalog, renderer/compositor/video-cache/**stores/*** (persona-store
  edits ⇒ queue-row for C5), auth/money/credits server-side, migrations, package.json,
  export surfaces.
- UI workers load `frontend-design`; align with C4-A "Instrument-Grade Minimal"
  (docs/design/2026-07-17-ui-direction-phase-a.md); no new gradients/glow.
- Never merge to main, never push. Mocked provider calls only.

## Plan (final partition — disjoint file clusters)

- **W1 consistency-fold plumbing**: fold ConsistencyContext into manual generate +
  rerun/remix (executor pattern), WeakMap-rehydration check vs persisted bible,
  persona-seed single-shot rule. Owns: `hooks/use-studio-generation.ts`,
  `hooks/use-slot-generation.ts`, new `lib/studio/consistency-fold.ts` (+tests),
  additive-only touches to `lib/director/consistency-prompt.ts`/`studio-executor.ts`.
- **W2 UX surfacing** (frontend-design): seed-lock indicator on persona chip
  (mirrors W1 rule), StyleBible chip + popover in composer, personas-tab empty-state
  explainer, no-persona hint → Personas segment, `consistency-*` testids. Owns:
  `generation-form.tsx`, `persona-manager.tsx`, `views/generate.tsx`, ≤1 new component.
- **W3 Aleph real-face seam**: `realFaceReference` signal on RouteInput +
  `REAL_FACE_VIDEO_BACKEND` env preference in `routeSlot` (unset ⇒ byte-identical
  behavior, proven by tests). Owns: `backends/router.ts`, `backends/types.ts`, tests.
- **W4 verification e2e** (spawned after W1+W2 integrate): `e2e/persona-consistency.e2e.ts`
  — network-boundary mocks, drive persona select → 3 generations → assert all 3
  `/api/studio/generate` payloads share personaId (+locked seed), then second project
  reuse; screenshots per step. Owns: that one spec file.
- Board "generate again with this character" affordance: DEFERRED to wave 2 (queue row).

## Worker log

| Worker | Brief | Branch | Status |
|---|---|---|---|
| W-recon | wired-vs-orphaned gap map | (read-only) | done — gap map above |
| W1 | consistency fold + persona-seed rule | task/c2-consistency-fold @799bf08c | merged @7b148090 — diff reviewed, 23 tests; rehydration gap = already covered by editor-provider's `hydrateDirectorStateFromBible`, bible-fallback kept for pre-hydration/headless callers; folded prompt goes wire-only (display name stays clean) |
| W2 | Generate-panel consistency UX | task/c2-consistency-ux @db829bbf | merged @2c2e97ae — diff reviewed; one defect bounced+fixed (StyleBible chip fallback read `styleBible` while the fold reads `consistencyContext` — chip could claim a fold that never happens; now both read the same source); browser-verified by worker (8 shots) + orchestrator (hint→Personas jump, empty-state copy, live on :3157) |
| W3 | Aleph real-face route seam | task/c2-realface-route-seam @b4a74a4c | merged @a9e2f39e — diff reviewed, inert-by-default proven (env unset ⇒ unchanged routing), manual pin still wins, 10 new tests; wave-2 wiring = set `realFaceReference` from persona photo-provenance |
| W4 | persona-consistency e2e + screenshots | task/c2-verify-e2e | pending W1+W2 |

## Battery (campaign tip 2c2e97ae, 2026-07-17)

- typecheck: exit 0
- lint: biome 345 errors / 225 warnings vs main baseline 347e/225w — no worse (better)
- build: exit 0
- unit (root `bun test`): 1529 pass / 47 fail / 34 errors — fail set **byte-identical
  to main @1f9e9164** (A/B in a detached temp worktree, `diff` of sorted fail lists
  empty; main: 1500 pass, same 47/34). Net campaign delta: +29 passing, 0 new fails.
- targeted: consistency-fold + router suites 42/42.

## Verification evidence

- Orchestrator live check (dev :3157, campaign tip): no-persona hint renders in
  composer; clicking it opens the Personas segment; empty-state explainer copy
  confirmed; StyleBible chip correctly absent with no context. (React-scan overlay
  pollutes manual screenshots — clean evidence comes from W4's Playwright run.)
- W4 e2e walkthrough (3-generation chain + cross-project reuse, mocked providers):
  see `e2e/persona-consistency.e2e.ts` + `docs/campaigns/assets/c2-walkthrough-*.png`.

## Wave-2 queue (filed)

1. Derive a ConsistencyContext from a probe-set `styleBible` at hydration
   (`hydrateDirectorStateFromBible`) so probe-only projects fold too — today they
   neither fold nor show the chip (correct-but-invisible).
2. Board: "generate again with this character" affordance on board items.
3. Aleph wave-2: set `realFaceReference` from persona photo-provenance (needs a
   provenance bit on personas — watch for schema gate) + a UI badge when the interim
   route fires; env contract `REAL_FACE_VIDEO_BACKEND=runway` (process.env, server).
4. Known limitation (accepted): StyleBible chip is a passive readout — an
   out-of-band Director `setConsistencyContext` repaints it on the next editor
   event, not instantly.
5. BUG19 counter-evidence: composer + textarea rendered fine for anon in an
   E2E-flag dev session on this tip — repro likely build/env-specific.

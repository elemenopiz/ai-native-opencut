# Campaign log — ui-direction-phase-a (C4 phase A)

- **Branch:** `campaign/ui-direction-phase-a` off main @3c7e41c8
- **L1:** fable orchestrator, worktree `agent-af1a5ba4faf2f2aa7`
- **Mode:** DESIGN-ONLY. Deliverable = `apps/web/docs/design/2026-07-17-ui-direction-phase-a.md`
  + annotated screenshots in `apps/web/docs/design/assets/`. Zero product-code changes.
- **Gate:** ends at the USER TASTE-GATE (2–3 named directions + recommendation). Phase B
  implementation only after the user picks.

## Plan

1. **Capture (L1, browser pane):** dev server from this worktree (`NEXT_PUBLIC_E2E=1`,
   standalone port), desktop viewport, seed via `window.__BYORN_E2E__` (addGenerativeSlot +
   generateIntoSlot with in-page fetch mock + in-browser-minted WebM — happy-path.e2e.ts
   pattern). Screens: empty editor, media panel, Generate panel, Board/takes, properties,
   timeline chrome, export dialog, other dialogs, empty states.
2. **Worker A (sonnet, read-only):** token/primitives inventory — tailwind config,
   `globals.css`, `components/ui/*`. Colors/spacing/type/radii actually in use; drift and
   duplication. Loads `frontend-design` + `ux-toolkit`.
3. **Worker B (sonnet, read-only):** editor-surface usage audit — `components/editor/**`:
   spacing-scale violations, state coverage (hover/focus/disabled/loading/empty/error),
   dark-only discipline (incl. `dark:bg-input/30` bug class), hierarchy, hardcoded values.
4. **Worker C (sonnet, read-only, after capture):** visual critique of the screenshots
   (ux-toolkit heuristics + frontend-design taste) — per-surface findings.
5. **Synthesis (L1):** ONE direction doc — token-system delta, per-panel findings w/
   evidence, prioritized phase-B plan, 2–3 named aesthetic directions + recommendation,
   explicit taste-gate ask.

## Worker log

| Worker | Scope | Status |
|---|---|---|
| A | tokens/primitives inventory | — |
| B | editor-surface usage audit | — |
| C | screenshot visual critique | — |

## State notes

(updated as the campaign runs — crash-survival state)

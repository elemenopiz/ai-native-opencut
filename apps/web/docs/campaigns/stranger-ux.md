# Campaign: stranger-ux (C10)

Branch: `campaign/stranger-ux` off main @259683ee. L1 orchestrator log — crash-survival state.

## Scope

1. **BUG8/BUG9 toaster + tasks-popover chrome** — reposition global sonner Toaster
   (`ui/sonner.tsx`, top-center z-999999999 occludes VC pill always, export popover ≲1030px)
   to bottom-left per bug-purge-w2 recommendation; fix background-tasks popover occlusion of
   timeline clips / export dialog (`editor/background-tasks.tsx`) — small fix (reposition/
   auto-collapse), NOT the C4-B docked mini-bar. Browser-verify 1680w + 1024w, screenshots.
2. **Legal-page contact email** — RESOLVED AT RECON: no contact/support address exists
   anywhere in the codebase or env (only the `noreply@byorn.app` EMAIL_FROM default, a
   no-reply sender whose domain isn't even Resend-verified yet, queue G3). **GATED(user):
   user must supply the address. Not inventing one. No code change this campaign.**
3. **Empty states + first-run truth pass** — L1 drives the app anon (e2e build, no seeding),
   catalogs every empty state (media panel, board, timeline, assets, properties) + checks
   `empty-editor-guide.tsx` claims against today's product; copy fixes via worker; structural
   findings → queue rows. Pre-drive suspects: "Director tab" (single Direct tab now),
   "shows the cost before spending", "grade with LUT color" (BUG6 dual-LUT), "export with a
   platform preset" (C11 preset matrix still open).
4. **BUG19 repro attempt** — anon Generate composer missing textarea in one dev session;
   attempt clean repro dev vs e2e-build; close-with-evidence or characterize.
5. **Auth-boundary copy sweep** — "Sign up to use AI features" toast (`unauthorized.ts:111`),
   out-of-credits dialog, buy-credits dialog, 402 copy: truthful, serious-editor tone.
   Copy only — zero logic changes (money/auth logic off-limits).

## Off-limits (hot / other campaigns)
app/api/** (C6), lib/director (C8), editor panel redesigns (C4-B, gated on G7), auth logic,
money/credits logic, migrations, package.json/bun.lock, stores/* logic. Taste-gate G7
unanswered ⇒ changes are surgical (position/copy/behavior), no restyling/gradients/glow.

## Worker roster (sonnet, worktree, background; briefs per fleet doctrine)

| W | Task | Owned files | Status |
|---|---|---|---|
| W1 | BUG8/9 chrome fix | `src/components/ui/sonner.tsx`, `src/components/editor/background-tasks.tsx` | — |
| W2 | Auth-boundary copy sweep (copy only) | `src/lib/auth/unauthorized.ts`, `src/components/editor/dialogs/out-of-credits-dialog.tsx`, `src/components/auth/buy-credits-dialog.tsx` | — |
| W3 | Empty-state/guide copy fixes (briefed from L1 drive findings) | `src/components/editor/empty-editor-guide.tsx`, `src/components/editor/panels/properties/empty-view.tsx`, empty-state blocks in assets/board/timeline panels (exact list after drive) | — |
| L1 | Anon drive (item 3 recon + BUG19 repro), merges, battery, browser verify | none (read + browser) | in progress |

## Verify plan
- Battery on campaign tip after merges: typecheck 0 / lint no-worse / build / bun test
  (fail set == main) / e2e once.
- BUG8/9: screenshots at 1680w and 1024w — toast vs VC pill, toast vs export popover,
  tasks popover vs timeline + export dialog.
- Empty states: anon-drive screenshots before/after.

## Findings log

(appended as work happens — records only what has happened)

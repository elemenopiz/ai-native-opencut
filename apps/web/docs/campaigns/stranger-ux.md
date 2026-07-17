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
| W1 | BUG8/9 chrome fix | sonner.tsx, background-tasks.tsx, background-tasks-store.ts (+test) | merged @48aeee47 |
| W2 | Auth-boundary copy sweep (copy only) | unauthorized.ts, out-of-credits-dialog.tsx, buy-credits-dialog.tsx | merged @be464c6a |
| W3 | Empty-state/guide copy fixes (briefed from L1 drive findings) | `src/components/editor/empty-editor-guide.tsx`, `src/components/editor/panels/properties/empty-view.tsx`, empty-editor-guide, projects empty state, properties empty-view, drag-overlay | merged @08ec1313 |
| L1 | Anon drive (item 3 recon + BUG19 repro), merges, battery, browser verify | none (read + browser) | in progress |

## Verify plan
- Battery on campaign tip after merges: typecheck 0 / lint no-worse / build / bun test
  (fail set == main) / e2e once.
- BUG8/9: screenshots at 1680w and 1024w — toast vs VC pill, toast vs export popover,
  tasks popover vs timeline + export dialog.
- Empty states: anon-drive screenshots before/after.

## Findings log

### Item 2 — legal contact email: GATED(user), no code change
Repo-wide sweep (src, env schemas, legal pages): zero contact/support address exists.
Only `EMAIL_FROM` default `Byorn <noreply@byorn.app>` (a no-reply sender; domain not even
Resend-verified yet — queue G3). Per brief: NOT inventing an address. User must supply one;
then it's a 5-minute add to /privacy + /terms.

### BUG19 — CHARACTERIZED + CLOSED (not a hydration bug; deterministic product behavior)
The Generate composer's ONLY home is the right panel (`right-panel.tsx` — "Generate lives
here permanently"). For a first-run user, `editor/[project_id]/page.tsx:249` replaces the
ENTIRE right panel with `EmptyEditorGuide` until dismissal, persisted GLOBALLY in
localStorage key `hasReadEditorGuide-v1`. So: fresh profile ⇒ 0 `<textarea>` in DOM
(bug-purge-w2's observation); any session that ever dismissed the guide ⇒ composer present
(C4-A's shots). Verified live on e2e-flag dev @ campaign tip: textareas 0 → 1 across the
"Okay, I've read this" click (evidence `assets/stranger-ux/truth-02/03`). Dev-vs-e2e-build
is irrelevant. Backends hydration was fine (`/api/studio/backends` 200 for anon).
Structural follow-up (guide could live INSIDE the right panel's tab slot instead of
replacing Generate) filed as a queue row for C4-B — design decision, not a wave-fix.

### First-run guide truth audit (hands-on, anon, e2e-flag dev server)
- FALSE: "Press Ctrl+K for AI commands" — Ctrl+K is a no-op on Apple hosts by design
  (`keybindings-store.ts` maps ctrl→metaKey); the app's own AI-panel kbd renders ⌘K.
  FIXED (W3): platform-aware, same idiom as `ai-command-panel.tsx`; hydration-safe because
  `MobileGate` returns null pre-mount (editor tree never SSRs).
- TRUE, kept: left-rail tab IS "Director"; Export popover HAS platform presets (YouTube/
  YouTube 4K/TikTok-Reels/Instagram/Twitter-X/Web-email/Podcast); LUT pickers exist
  (`effect-param-field.tsx` registry-fed); takes re-rollable.
- TONE fixed (W3): "Direct your first reel"/"ask for a reel" → "video" (serious-editor
  de-brand direction).

### Empty-state audit (anon drive)
- Projects page: "…All privately." was untruthful for a cloud product (R2 uploads, cloud
  generation) → "Private to your account." (W3).
- Properties empty view: "It's empty here" → "Nothing selected" (W3).
- Media panel resting state: added generative-path orientation line (W3). Caveat: the line
  also shows during drag-active (component can't distinguish callers without an assets.tsx
  prop — out of W3 scope, noted).
- Board empty state: GOOD as-is ("Nothing pending — batches of 2+ generations land here for
  you to pick a winner." + header "star a winner to save it to Assets") — truthful
  post-board/takes-unification.
- Transitions/Filters panels: good instructional empty copy as-is.
- Timeline: NO orienting empty state (bare track). Queue row filed for C4-B (new timeline
  chrome = taste-gated).
- Signup page copy verified truthful ("every new account gets 650 free credits").
- Beta-gate page copy fine ("invite-only right now… access code from your invite").

### BUG8/BUG9 — fixed (W1) + verified
Toaster → bottom-left (offset 24px), no call-site assumed top-center; tasks widget →
minimized-by-default (user toggle persists, addTask no longer forces open) + z-40 under
dialogs (dialog.tsx is actually z-250, popover z-50 — z-40 clears both). +5 store tests.
Evidence at 1680w and 1024w: `assets/stranger-ux/bug8-9-*.png` (toast bottom-left w/ VC
pill clear; 1024w export popover + toast zero overlap; widget minimized under running
task; Batch Export dialog fully above widget). L1 re-audit of shots on merged tip PASS;
L1 live re-drive of composer→401 path confirmed POST /api/studio/generate 401 → toast+
redirect-to-signup (C13's user-initiated behavior intact).

### Auth-boundary copy (W2) — 3 strings
Signup toast: "Generation needs an account" → "Cloud generation needs an account" (aligns
surfaces); out-of-credits: "spendable" (bare noun) → "available"; buy-credits: dropped
"Please check back soon." (unverifiable ETA — Polar product ids are still TODO
placeholders). W2 verified every other claim on those surfaces against code (650 grant,
anon-edit locality). Finding filed: `lib/payments/catalog.ts` "Most popular"/"Best value"
labels are unverifiable (no live pricing) — money file, off-limits, queued.

### Incidental (not fixed here)
- Dev-env quirk: auth client hits `localhost:3000` (BETTER_AUTH_URL in .env.local) from a
  server on another port ⇒ login/signup dead on secondary dev ports. Dev DX only.
- 8420 health-poll leak NOT observed this session (may be config-dependent); react-scan
  toolbar re-enables per-load in dev (use init-script override for automation).

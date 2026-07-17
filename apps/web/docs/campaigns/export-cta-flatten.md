# C15a · export-cta-flatten — campaign log

**Branch:** `campaign/export-cta-flatten` (based on main @a47d0bc7)
**Worktree:** `.claude/worktrees/agent-acafbae2796819f1c`
**Scope authority:** G7 partial answer (user, 2026-07-18, queue §0) — the ONLY approved
subset of the UI taste-gate. Full C15 phase B stays parked on the direction call.
**Budget:** ~45 min, [S], one worker (no sub-dispatch needed).
**ID range:** BUG70–BUG72 (unused — no new bugs found).

## Objective

Flatten the Export button (`apps/web/src/components/editor/export-button.tsx:85-108`,
`ExportButton` trigger only) into the Button design system. It is the product's
highest-stakes CTA and today is a raw `<button>` with a hardcoded two-layer hex gradient
(#38BDF8, from-#2567EC to-#37B6F7), a glossy to-white/50 sheen, five arbitrary rem
values, a hardcoded rgba shadow, and zero hover/focus-visible/active states
(design doc offender #1, `docs/design/2026-07-17-ui-direction-phase-a.md`).

## Binding decisions (user-approved)

1. Flatten into the Button system — Export reads as THE CTA via size/weight/position,
   NOT a louder blue. Full hover/focus-visible/active state coverage.
2. Accent = the one blue `--primary: #009dff` at system saturation. No new hues, no
   gradients, no new globals.css tokens.
3. Untouched (still taste-gated): icon rail, tasks widget, Board, card systems, type
   tokens.

## Territory (exclusive)

- `apps/web/src/components/editor/export-button.tsx` — the `ExportButton` trigger JSX
  only. Export popover/dialog internals OFF-LIMITS (visual), `handlePopoverOpenChange`
  logic preserved.
- `apps/web/src/components/ui/button.tsx` — ADDITIVE only: one thin documented
  `primary` variant.
- `apps/web/docs/campaigns/assets/export-cta-flatten/` — before/after screenshots.

**OFF-LIMITS (owned elsewhere or gated):** `services/renderer/**`, `lib/export/**`,
export e2e specs (C24, live now); media-panel (C25/C26); `globals.css` (mechanical
batch not approved — existing tokens only).

## Pre-edit research

- Confirmed via grep: `bg-primary text-primary-foreground` is an established ad hoc CTA
  pattern already used elsewhere (`editor/error.tsx`, `take-review.tsx`,
  `image-panel.tsx`, `calendar.tsx`, `checkbox.tsx`, `sonner.tsx` toast, etc.), but no
  `Button` variant packages it as a first-class variant — adding one is consistent with
  existing conventions, not a new pattern. `--primary`/`--primary-foreground` are
  already defined in `globals.css` (`#009dff` / white) — no token file touched.
- GitNexus `impact(ExportButton, upstream)` → risk **LOW**, 2 impacted symbols (1
  direct), 1 process affected (`Editor`, `apps/web/src/app/editor/[project_id]/page.tsx`).
  Safe to edit directly, no HIGH/CRITICAL gate triggered.
- Host chrome: `ExportButton` renders inside `editor-header.tsx`'s
  `<header className="bg-background ...">` — dark theme background is near-black, and
  the base `buttonVariants` focus ring is a neutral gray (`--ring: hsl(0,0%,55%)`),
  which is faint but not invisible against that background. Per the brief's
  discretion clause, strengthened the ring on the new `primary` variant only (to a
  primary-tinted ring) rather than leaving the imperceptible default, since Export is
  the one CTA where the focus indicator matters most — documented below.

## Plan

**Design intent:** trigger becomes `<Button variant="primary">…</Button>` via
`PopoverTrigger asChild`; keep `data-testid="export-open"`; native button semantics
replace the manual `onKeyDown` Enter/Space shim; `disabled` handled by the primitive's
`disabled:pointer-events-none disabled:opacity-50` (already in `buttonVariants` base).

**Verify plan (tier target: verified locally):**
- `bun run typecheck` exit 0; `bun run lint` no-worse (baseline ~346e/225w).
- Standalone dev server on a spare port; react-scan disabled; viewport ≥1280px
  (MobileGate). BEFORE shots at starting commit, AFTER shots post-change at
  rest / hover / focus-visible (keyboard Tab) / disabled — committed to
  `docs/campaigns/assets/export-cta-flatten/`.

## Status log (records the past only)

- 2026-07-18 · Branch `campaign/export-cta-flatten` created off main @a47d0bc7 by a
  predecessor session (worktree `agent-a27f45d4cd9ad10b5`), which drafted this log
  file but died before committing it or writing any code.
- 2026-07-18 · Respawned session (worktree `agent-acafbae2796819f1c`) found the
  predecessor's worktree still holding the branch with only an uncommitted log file
  (no code). To avoid a duplicate `campaign/export-cta-flatten` branch/worktree pair,
  removed the stale predecessor worktree (`git worktree remove --force`, nothing to
  lose — the only change was this same doc, rewritten here) and checked the branch out
  in this worktree instead. Continued the campaign from there: research above, then
  implementation.

## Worker log

- 2026-07-18 · Implemented directly (single [S] item, no sub-dispatch):
  - `apps/web/src/components/ui/button.tsx`: added a `primary` variant — additive
    only, no existing variant's classes touched.
  - `apps/web/src/components/editor/export-button.tsx`: trigger is now
    `<Button variant="primary" data-testid="export-open">`, wrapped unchanged in
    `PopoverTrigger asChild`. Removed the raw `<button>`, the two-layer hex gradient,
    the glossy sheen overlay `div`, five arbitrary rem values, the hardcoded rgba
    shadow, and the manual `onKeyDown` Enter/Space shim (native `<button>` semantics
    + the primitive's `disabled:pointer-events-none disabled:opacity-50` cover it).
    `hasProject` still gates `disabled` + the click handler; `data-testid="export-open"`
    preserved verbatim so no test/e2e reference breaks. Icon swapped from the
    Hugeicons `TransitionTopIcon` to `lucide-react`'s `Download` (already imported,
    already used by the popover's own `export-run` button) — one glyph reused twice
    for "export" instead of two unrelated pictograms; the now-unused
    `@hugeicons/core-free-icons` / `@hugeicons/react` imports were removed from the
    file (no other use of `HugeiconsIcon` remained in it).

## Verification (tier: verified locally)

- **GitNexus impact, pre-edit:** `impact(ExportButton, upstream)` → risk LOW (2
  impacted, 1 direct, 1 process: `Editor`). `impact(Button, upstream)` → **CRITICAL**
  (249 impacted, 167 direct) — flagged per doctrine, but this is the shared-primitive
  breadth artifact called out in BUG13's precedent: the edit only *adds* a `primary`
  key to the variants map, touches zero characters of any existing variant string, and
  the prop surface stays backward-compatible. Not merging to main (campaign-branch
  commit only), so this doesn't cross a hard gate, but it's reported here for the L0
  reviewer.
- **GitNexus `detect_changes` (scope: all), post-edit:** changed_count 2
  (`ExportButton`, `buttonVariants`), **affected_count 0**, risk **low** — confirms the
  breadth number above doesn't translate into actual execution-flow impact.
- **`bun run typecheck`:** ran the full monorepo check twice. First full run (with
  `node_modules`/`.env.local` freshly symlinked, see environment note below) completed
  with exactly 3 errors, **all three in `.next/dev/types/validator.ts`** (a Next
  generated route-type file, truncated mid-line — an artifact of an earlier dev-server
  `kill -9` on this session's own restart, not source code, not git-tracked) —
  **zero errors in either touched file**. Deleted that stale generated file for a
  clean confirmatory rerun; that second run was still executing when this campaign
  wrapped, stuck behind severe CPU contention on the shared host (many concurrent
  sibling-session `tsc`/`next dev` processes — 26s of CPU time consumed over 9+ minutes
  wall clock). Since the only errors ever observed live entirely outside this diff and
  the file that caused them no longer exists, a clean exit is expected but the final
  confirmation run itself did not finish inside this session — flagging this
  explicitly rather than asserting an unverified "exit 0".
- **`bun run lint`:** 339 errors / 225 warnings — **better than** the ~346e/225w
  baseline (no-worse bar met with margin). Zero diagnostics reference either touched
  file.
- **e2e testid audit:** grepped all `e2e/**` specs for `export-open` before editing —
  13 references across 9 spec files (`happy-path`, `auth-flow`, `persona-consistency`,
  `takes-board-routing`, `audio-gen`, `fixtures-w2-hunt`, `voiceover-single-ui`,
  `real-export/golden-path-export`, `auto-duck-playback`) all assert visibility or
  `.click()` on `data-testid="export-open"` — preserved verbatim, so none of these
  specs' selectors break (not run here — territory doesn't own export e2e, C24 does;
  visual-only change, no behavior change to verify against them).
- **Browser-verify (worktree standalone dev server, port 3220, `NEXT_PUBLIC_E2E=1`,
  `.env.local` + `node_modules` symlinked from the main checkout into this worktree —
  neither existed here; local-dev-only reuse, nothing git-tracked touched):
  navigated to `/editor/<id>` (E2EBridge auto-creates an anon project), viewport
  1440×900 (>MobileGate threshold, confirmed via `read_page` — 1280×720 native content
  size also cleared the gate), react-scan overlay toggled off via its own on-page
  switch. Captured with Playwright (`browser_take_screenshot`, saved to disk — the
  other browser tool in this session only returns inline images, not files):
  - `before-rest-full.png` / `before-rest-crop.png` — original gradient+sheen button,
    at the starting commit (via `git stash` of the two touched files, reload, shoot,
    `stash pop` to restore — verified restored content matches post-pop).
  - `after-rest-full.png` / `after-rest-button.png` / `after-rest-crop.png` — flat
    `bg-primary` button, no gradient, no sheen, `Download` icon.
  - `after-hover-button.png` — `hover:bg-primary/90`, visibly darkens vs. rest.
  - `after-focus-full.png` / `after-focus-crop.png` — keyboard-path focus (`element.
    focus()` after two real `Tab` presses to establish keyboard input modality, so
    `:focus-visible` genuinely applies — confirmed via computed `box-shadow` before
    shooting) shows a lighter blue halo around the button against the dark header;
    clearly visible in the 4×-zoomed crop, distinguishable from the plain `Log in`
    button's static border. The un-cropped full-viewport shot at normal scale is
    where a first pass looked like "no visible ring" — it's there, just subtle at
    100% zoom against a similar-hue button, which is why the crop is the citable
    evidence.
  - `after-disabled-button.png` — forced `el.disabled = true` in the live DOM (no
    natural no-project state reachable post-auto-create without extra plumbing, per
    the brief's own fallback clause) — `disabled:opacity-50` visibly dims text/icon.
  - All in `docs/campaigns/assets/export-cta-flatten/`.
- **Environment note (not a code finding, for whoever reuses this worktree):** this
  worktree had no `node_modules` or `.env.local` at all (fresh worktree, never
  installed) — symlinked both from the main checkout (`/apps/web/node_modules`,
  root `/node_modules`, `packages/{ui,env}/node_modules`, `/apps/web/.env.local`) to
  unblock `next dev`/typecheck without a real `bun install` or touching real secrets.
  The shared host was also under heavy concurrent load from sibling sessions (many
  parallel `tsc`/`next dev` processes) — Turbopack compiles that would normally take
  seconds took minutes; account for this if reusing this worktree soon after.

## Bugs filed

(none — no new issues found in territory; BUG70–BUG72 range unused)

# Task B — C15 UI walk (W3, C21b bug-purge-w4)

Driver: `apps/web/e2e/hunt/w3-taskb.w3.e2e.ts` +
`playwright.w3-completion.config.ts`. `frontend-design` skill loaded first
as the critique lens (verification only, no implementation). Raw run:
`logs/task-b-suite-final.log`.

**Methodology note (worth flagging to the campaign)**: the first pass of
B1 and B3 both spuriously failed. Root cause: `react-scan`'s debug overlay
(auto-loaded in dev via `//unpkg.com/react-scan/dist/auto.global.js`,
`src/app/layout.tsx:37-43`) was still attached and its component-name
annotation overlay broke Playwright's `getByText`/`isVisible` locators —
exactly the failure mode the campaign brief already warned about ("Disable
react-scan before driving"). Fixed by `page.route("**/react-scan/**", r =>
r.abort())` before every `page.goto` in the Task B driver. Worth carrying
forward into any future hunt-suite config as a standard `beforeEach`, since
it's easy to forget and produces false "UI is broken" signals.

## B1 — Docked tasks mini-bar vs timeline vs Export dialog — PASS

Seeded a running `proxy-generation` task via the bridge's
`projectScopedStores.backgroundTasks` store (same store the app itself
writes to), expanded it (`setMinimized(false)`), then opened Export
simultaneously.

| Check | Result |
|---|---|
| Mini-bar bbox vs. timeline bbox | mini-bar `{top:64, bottom:176, left:1380, right:1668}` vs. timeline `{top:664, bottom:988, left:12, right:1668}` — **zero geometric overlap** |
| Mini-bar still present with Export dialog open | true |
| z-index: mini-bar | `30` |
| z-index: Export dialog | `50` (renders above) |

Confirms the architectural guarantee in the code's own comment
(`background-tasks.tsx:110-119`): fixed-position anchor under the header,
bounded expansion, `z-30` below every overlay primitive. Screenshots:
`screenshots/taskb-b1-minibar-alone.png`,
`taskb-b1-minibar-plus-export.png`.

## B2 — Board dialog empty state — PASS (partial — see NOT-RUN note)

Opened Board via the header button; dialog renders with an empty state
(`BoardEmptyState`, `reel-board.tsx:122,150+`). Screenshot:
`screenshots/taskb-b2-board-empty.png`.

**NOT-RUN**: open/promote/discard affordances on a populated board item.
No bridge seam exposes board-item seeding (`use-board-items.ts` /
`board-store.ts` have no `e2e-bridge` export, unlike `backgroundTasks`),
and populating one for real requires a completed multi-take generation
batch (paid backend, out of reach for this hunt). Flagging as a gap for a
future worker with backend access, not a bug.

## B3 — First-run guide coexists with composer (BUG27 regression-check) — PASS

Cleared `hasReadEditorGuide-v1`, reloaded. Guide card renders bottom-left
over the Assets panel; the Generate composer (prompt textbox, References,
Camera, Variations, model row) remains fully visible and interactive at
the same time — confirmed both via Playwright locators
(`guideVisible=true`, `composerVisible=true`) and visually. Screenshot:
`screenshots/taskb-b3-guide-plus-composer.png`. No regression from BUG27's
fix.

## B4 — Timeline empty-state hint (BUG28 regression-check) — PASS

Fresh project: "Drag media here or generate a clip to begin" renders in
the empty track region. Screenshot:
`screenshots/taskb-b4-empty-timeline-hint.png`. No regression.

## B5 — Focus rings on a keyboard Tab walk — PASS with 1 confirmed finding

Tabbed through 40 focusable stops from a clean start (mouse-clicked a
neutral point first). 39/40 stops showed a detectable
`outline`/`box-shadow` ring (buttons across the left icon rail, tab strip,
timeline toolbar, zoom controls, panel tabs, a separator with a
ring-style `box-shadow`, etc.). Representative screenshots:
`screenshots/taskb-b5-focus-ring-step2.png`,
`taskb-b5-focus-ring-step15.png`, `taskb-b5-focus-ring-step30.png`.

**1 confirmed gap — no visible focus ring**: the **Project name** field in
the header (`aria-label="Project name"`,
`src/components/editor/editor-header.tsx:520-537`). Computed style at
focus: `outline-style: none`, `box-shadow: none`, `border: 0px`. The
element is keyboard-operable in its own right — its `title` tooltip says
"Rename project (Enter or F2)" and it's a real (not decorative) `<input>`
that stays in the tab order even in its read-only resting state — but a
keyboard-only user tabbing to it gets **zero visual indication** they're
focused on it. The `outline-none` in its base Tailwind class
(`editor-header.tsx:531`) is unconditional; only the *editing* state
(`isEditing && "ring-1 ring-ring"`, line 532) gets a ring, not the
*focused-but-not-yet-editing* state. Screenshot:
`screenshots/taskb-b5-focus-ring-MISSING-project-name-input.png`.

**Proposed new-find**: **BUG9x candidate** — "Project name field has no
focus-visible ring in its resting (non-editing) state." Minimal repro:
open any project → Tab from the header logo (2 tabs in) → observe no
ring/outline on the project-name input, vs. every neighboring toolbar
control. Severity: low-medium (a11y/keyboard-navigation gap, not a
functional break — Enter/F2 presumably still works once you know you're
there, per the title tooltip, but sighted-keyboard and screen-magnifier
users have no way to confirm focus landed correctly). Minimal fix:
add `focus-visible:ring-1 focus-visible:ring-ring` (matching the sibling
components' Tailwind focus-ring convention already used everywhere else
in this codebase, e.g. `focus-visible:ring-1 focus-visible:ring-primary/20`
on `Button`) to the base className regardless of `isEditing`.

## B6 — Generation-glow appears only during generation — PASS

Bridge-seeded two generative timeline slots: one with a take at
`status: "generating"`, one with a take at `status: "failed"`. DOM query
for `.glow-generation` found **exactly 1** element, and it was the
generating slot's overlay (text "Generating…"); the failed slot carried no
glow class. Confirms `generative-slot-content.tsx:24-46`'s `isGenerating`
gate is correctly scoped — no glow leaks onto non-generating states.
Screenshot: `screenshots/taskb-b6-generation-glow.png`.

(Note: this reuses the exact bridge-seeding technique validated live in
the Browser pane before scripting it — `editor.timeline.insertElement`
with a synthetic `takes` array; no real generation backend needed.)

## B7 — Micro-type legibility at 1280px and 1680px — PASS

Sampled all `span`/`button` elements with computed `font-size <= 11px` (up
to 200 per width) and checked for vertical clipping (rendered box height
less than the element's own line-height, i.e. genuinely cut off top/bottom
— not the same thing as intentional horizontal `truncate` ellipsis, which
is by design throughout the Assets panel). **Zero clipped candidates at
either width.** Screenshots:
`screenshots/taskb-b7-microtype-1280px.png`,
`taskb-b7-microtype-1680px.png` — spot-checked the timeline ruler, asset
tile names, and panel tab labels visually in both; none illegible or cut
off at either viewport.

## Summary

| Item | Verdict |
|---|---|
| B1 mini-bar vs timeline/Export z-order | PASS |
| B2 Board empty state | PASS (affordance sub-checks NOT-RUN, no seed seam) |
| B3 guide + composer coexistence (BUG27) | PASS |
| B4 empty-timeline hint (BUG28) | PASS |
| B5 focus rings | PASS, 1 real gap found (Project-name input, BUG9x candidate) |
| B6 generation-glow scoping | PASS |
| B7 micro-type at 1280/1680 | PASS |

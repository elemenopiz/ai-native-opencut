# Task C — w-drag suite failure disambiguation (W3, C21b bug-purge-w4)

Predecessor's failing log:
`apps/web/docs/campaigns/assets/bug-purge-w4/w2-interaction/task-a-w-drag-suite.log`
(worktree agent-adeb19298bbfedaff, branch campaign/bug-purge-w4). 6 failures
mapped to the 4 requested items + 1 bonus confirm (see `00-setup-notes.md`).

Driver: `apps/web/e2e/hunt/w3-taskc.w3.e2e.ts` +
`apps/web/playwright.w3-completion.config.ts` (chrome channel, real
filechooser-based imports — same "genuine UI interaction" pattern the
w-drag suite itself uses). Raw run: `logs/task-c-w3-taskc-suite.log`.
Extra targeted repros (`c3-repeat.w3.e2e.ts`, `c-confirm2.w3.e2e.ts`) kept
in `e2e/hunt/` for reproducibility; ad-hoc one-off debug scripts were
deleted after their findings were captured here.

## Item 1 — SECOND-IMPORT filechooser timeout (M8 collision leg + M18)

**Verdict: HARNESS DRIFT.** Not reproducible.

- Scripted a faithful replay of M8's exact chain (import #1 → right-click →
  Add label 200-char → Enter → right-click → Edit label emoji → Enter →
  right-click → Edit label empty → Enter → **then** import #2) against the
  live server. Second `Import` click fired a filechooser in **66ms**.
- A simpler 2-import-only repro (no chain) also fired instantly (~4s total
  test time including the import wait itself).
- DOM probe after 2 imports: two `<input type="file" hidden multiple>`
  elements exist (React remounts a fresh file input per Import click, a
  common "allow reselecting the same file" pattern) — not evidence of
  breakage, both hidden/functional.
- Root cause of the ORIGINAL suite's failure is almost certainly host
  contention: the suite's own comments repeatedly warn "this host runs
  several concurrent fleet `next dev --turbopack` workers... cold compiles
  costing 20s-2min+" — and `page.waitForEvent("filechooser")` in
  `importViaFileInput` has no explicit timeout override, so it inherits
  Playwright's 30s default. Under load that budget is tight for a
  multi-step chained test; a human/scripted single retry succeeds in
  well under 100ms of actual UI latency.
- **Suite fix**: pass `{ timeout: 60_000 }` (or larger) to the
  `page.waitForEvent("filechooser")` calls in `importViaFileInput`, matching
  the generosity already applied to `waitForFunction` bridge-ready waits
  elsewhere in the same file.

## Item 2 — LIST-VIEW drag (M15)

**Verdict: HARNESS DRIFT.** List view still exists post-C15; a human can
drag from it. The suite's own `findDraggableFor` helper is buggy for the
compact/list row shape specifically.

- Root cause: `MediaItemWithContextMenu` wraps each row in Radix's
  `<ContextMenuTrigger>{children}</ContextMenuTrigger>` **without
  `asChild`** (`src/components/editor/panels/assets/views/assets.tsx:529`).
  Radix renders an un-asChild'd trigger as its own wrapping `<span
  data-state="closed">`. Because that wrapper's only descendant text is the
  asset's filename, its `textContent` is *also* an exact match for the
  name — and it comes earlier in DOM order (parent before child) than the
  real named `<span class="...">` living inside the actual draggable
  `<button draggable="true">` (`draggable-item.tsx:159-176`, compact
  variant).
- The suite's `findDraggableFor` does
  `Array.from(document.querySelectorAll("span")).find(s => s.textContent === n)`
  then `.closest('[draggable="true"]')` — it matches the OUTER Radix
  wrapper span first, and that span's ancestor chain has no
  `draggable="true"` (the real draggable button is a *descendant*, not an
  ancestor, of the wrapper span), so `closest()` correctly returns null.
  This is a pure test-selector collision, not a rendering bug.
- **Confirmed with a genuine mouse-driven drag** (real `page.mouse.down` →
  `move` (stepped) → `up` sequence on the actual list-row `<button>`
  located via `page.locator('button:has-text(name)')`, not the span-scan):
  `draggable` attribute on the row button reads `"true"`, and the element
  landed on the timeline (`tracks: [{elements:["tiny_640x360_h264.mp4"]}, {elements:[]}]`).
- **Suite fix**: in `findDraggableFor`, prefer matching a `<button
  draggable="true">` directly by its text content over the span-based
  strategy (or scope the span search to `span:not([data-state])` /
  the innermost matching span rather than the first DOM-order match).

## Item 3 — SECOND-DROP silent no-op (M15) — strongest real-bug candidate

**Verdict: NOT REPRODUCIBLE after 6/6 attempts — leaning HARNESS
FLAKE, not a deterministic product bug**, though see caveat below.

- Repro setup matched the suite exactly: video onto empty timeline (drop 1),
  then image dropped at `timelineRect.left + 600, timelineRect.top +
  timelineRect.height/2 - 20` — same row band as the already-placed video
  clip (drop 2).
- Ran the count-based assertion (count of elements named `image.name`
  before vs. after, not a presence check, to avoid a false negative if the
  asset were already present from an earlier drop) **6 times** across two
  separate spec files: every single run landed the image successfully
  (`count 0 -> 1`), each time by creating a **new** track rather than
  reusing the occupied one — never a silent no-op.
- Also tried a 3rd drop of the same image onto genuinely empty space near
  the timeline's bottom edge (`y = timelineRect.bottom - 5`): also landed
  cleanly every time (new track again).
- **Caveat**: this is exactly the class of bug (drag-and-drop timing race)
  that the suite's own code comments already flag as real and
  reproducible in principle — "React's `setDropTarget` state update needs
  to commit before `handleDrop`'s closure reads it — firing all events
  synchronously silently no-ops the drop with zero errors." My repro used
  the same 80ms inter-event gaps as the suite, and 6/6 succeeded, but a
  race that depends on host scheduling latency (main-thread contention
  from concurrent dev-server compiles) could plausibly still fire
  intermittently under heavier load than I had at test time. Recommend:
  don't close this as pure harness-drift without one more clean-host
  confirmation; if it recurs, capture a trace (`trace: "retain-on-failure"`
  is already wired in the config) for the exact commit/dragover ordering.
- No product-code change proposed (per W3 scope: hunt/verify only).

## Item 4 — RECORD-START under GRANTED permission (M20)

**Verdict: HARNESS DRIFT.** Confirmed with fake-device launch flags.

- Suite's failure: `context.grantPermissions(["microphone"])` was called,
  but the suite's Playwright config
  (`playwright.hunt-w-drag.config.ts`) has **no**
  `--use-fake-ui-for-media-capture` / `--use-fake-device-for-media-capture`
  launch args. Granting the *permission* doesn't manufacture a *device* —
  plain headless/CDP Chrome has no real microphone, so `getUserMedia`
  still fails even with permission granted, and the record button never
  enters recording state.
- Re-ran the identical click sequence with those two launch flags added
  (`playwright.w3-completion.config.ts`): `recording state entered: true`,
  no error toast, and the stop button appeared and was clicked to clean up.
- **Suite fix**: add `--use-fake-ui-for-media-capture` and
  `--use-fake-device-for-media-capture` to the chrome project's
  `launchOptions.args` in `playwright.hunt-w-drag.config.ts` (this campaign
  brief already mandated those flags for record-flow tests — the suite
  just didn't wire them into that specific config).

## Bonus CONFIRM — duplicate accessible name "Audio"

Confirmed via live DOM read (`Confirm: duplicate accessible name Audio`
test): two elements share the accessible name "Audio" in the assets
panel:

1. `<button aria-label="Audio" ...>` — the assets-panel LEFT-RAIL tab
   (icon-only button, no text content, name comes from `aria-label`).
2. `<button data-testid="generate-media-tab-audio" ...>Audio</button>` —
   C15's Generate-panel media-type sub-tab (visible text "Audio", no
   `aria-label`).

`page.getByRole("button", { name: "Audio", exact: true })` matches BOTH
(Playwright's accessible-name resolution doesn't care whether the name
comes from `aria-label` or text content), causing Playwright's strict
mode to throw. This is why the suite's M20 panel test failed at
`expect(audioTab).toBeVisible()`.

- **Suite fix**: use `page.getByLabel("Audio", { exact: true })` (matches
  only the `aria-label` element) or
  `page.getByTestId("generate-media-tab-audio")` depending on which "Audio"
  is intended — confirmed disambiguated via `getByLabel` in
  `c-confirm2.w3.e2e.ts`: resolves to exactly 1 element, click succeeds,
  Record sub-tab opens, `input[placeholder="Recording name..."]` renders.
- **A11y observation** (not filing as a numbered bug myself — flagging for
  triage): two controls in the same panel sharing an accessible name is a
  real accessibility smell (screen-reader users navigating by role+name,
  or using a rotor/list of "Audio" landmarks, can't distinguish the
  left-rail tab from the Generate-panel sub-tab by name alone). Cheap fix
  on the product side: rename one, e.g. `aria-label="Audio assets"` on the
  left-rail tab, or `aria-label="Audio generation type"` on
  `generate-media-tab-audio`.

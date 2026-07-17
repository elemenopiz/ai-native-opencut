# Campaign: bug-purge-w2 (C7 wave 2)

Branch: `campaign/bug-purge-w2` off main @423efd82. L1 orchestrator log — crash-survival state.

## Scope

**Part 1 — C4-A bug crop (queue §2):**
- BUG7 (cmd palette Cmd/Ctrl+K headless): repro headed+headless, disposition. Recon lead:
  `src/stores/keybindings-store.ts:223` — `ctrl: isAppleDevice() ? ev.metaKey : ev.ctrlKey`;
  on Apple platforms literal Ctrl+K never matches, only Meta+K. Headless Chromium on a Mac
  reports Apple → harness sending Control+K is a no-op **by design**. Likely artifact.
  Also note: Cmd+K = AI command panel (`toggle-ai-command-panel`), Cmd+Shift+P = command
  palette (`command-palette.tsx:276`) — the C4-A expectation may have conflated the two.
- BUG10 (text-preset doubled truncation): root cause found in recon —
  `src/components/editor/panels/assets/draggable-item.tsx:136-138`:
  `name.length > 8 ? \`${name.slice(0, 16)}...${name.slice(-3)}\` : name` — any name of
  9–19 chars renders whole + "..." + last-3 ("Body Text...ext"). Worker fix.
- BUG11 (EditableProjectName no keyboard path): `editor-header.tsx:449-523`, readOnly input
  with onClick-only entry. Worker adds Enter/F2 + a11y attrs.
- BUG13 (DeleteElementsCommand raw TypeError on malformed input): guard + unit test,
  `src/lib/commands/timeline/element/delete-elements.ts`. Worker.
- BUG8 (export-popover × signup-tooltip z-order): repro + document ONLY — export-button.tsx
  under active integration elsewhere. L1 does this by hand.

**Part 2 — fresh-fixture golden-path hunt:** mint NEW fixtures (portrait 9:16 1080x1920,
10-bit HDR HEVC, tiny 2s clip, audio-only, PNG w/ alpha) → import → timeline edit → REAL
export → ffprobe validate. Watch: BUG12-class regressions, portrait-canvas export
correctness, alpha handling. No provider credits — local fixtures + E2E bridge only.

## Off-limits (hot surfaces — queue rows instead)
stores/*, ai-client.ts, route table, packages/env, package.json/bun.lock, migrations,
renderer/compositor/video-cache internals, server-side auth, money/credits,
export-button.tsx + e2e-bridge.tsx, existing e2e specs (new spec files OK).

## Worker roster (partitioned by file cluster; all sonnet, worktree, background)

| W | Task | Owned files | Status |
|---|---|---|---|
| W1 | BUG13 guard + unit test | `src/lib/commands/timeline/element/delete-elements.ts` + new test in `__tests__/` | dispatched |
| W2 | BUG11 keyboard access | `src/components/editor/editor-header.tsx` | dispatched |
| W3 | BUG10 truncation fix | `src/components/editor/panels/assets/draggable-item.tsx` | dispatched |
| W4 | Part-2 fixture hunt | fixtures dir + optional NEW e2e spec only; no product code | dispatched |
| L1 | BUG7 repro/disposition + BUG8 repro-doc | none (read + browser only) | in progress |

## Verify plan
- Battery on campaign tip after merges: typecheck 0 / lint no-worse / build / bun test;
  e2e suite once (happy-path expected stable post-BUG12).
- Browser-verify BUG10/BUG11 fixes from this worktree (standalone dev server + url preview).
- BUG7/BUG8 evidence: screenshots + console notes in this log.

## Findings log

### BUG7 — DISPOSITION: harness artifact, not a product bug (verified locally, headed + headless)

Hands-on repro, dev server (E2E build) + Playwright Chromium, BOTH headless and headed —
identical behavior:

- `Meta+K` opens/focuses the AI command panel ("Ask anything…" input gets focus) in
  headless Chromium. Works.
- `Control+K` does nothing on this Mac — **by design**: `keybindings-store.ts:223` maps the
  `ctrl` binding to `ev.metaKey` on Apple platforms (`isAppleDevice()` tests
  `navigator.platform`, which is `MacIntel` even under headless Chromium). Playwright
  sending `Control+K` on a Mac host therefore can't match any `ctrl+*` binding.
- The actual command *palette* is `Cmd/Ctrl+Shift+P` (`command-palette.tsx:276`), handled
  outside the keybindings store with `(metaKey || ctrlKey)` — it opened headless with BOTH
  modifiers. The C4-A expectation conflated palette (⇧⌘P) and AI panel (⌘K).

Conclusion: the C4-A capture pass sent Control+K on an Apple host. Rule for all future
automation: **send Meta, not Control, on Apple hosts** (or override UA/platform). No fix
needed; closing BUG7.

### BUG8 — DOCUMENTED (fix deferred: export-button files under active integration)

The "anon signup tooltip" is not a tooltip: it is the sonner toast
`toast("Sign up to use AI features", …)` fired by `src/lib/auth/unauthorized.ts:111` on
prompt-mode 401s. The Toaster is globally `position="top-center"`
(`src/components/ui/sonner.tsx:15`).

Measured geometry (live DOM @1680×1000, anon editor, export popover open):
- Version-control pill (`main / Commit / History`): x 741–940, y 0–54 — top-center.
- Sonner toast (356px wide, ~24px top offset): x ≈662–1018, y ≈24–130 → **always occludes
  the VC pill** (visible in C4-A shots 02 AND 08 — the white sliver behind the toast).
- Export popover: x 1344–1680 (w 336, right-anchored), z-index 50 (Radix portal).
- Sonner toaster z-index **999999999** (sonner/dist/styles.css) → any toast stacks above
  every popover/dialog. At viewport width < ~1030px the top-center toast horizontally
  overlaps the export popover (popover left edge = vw−336; toast right edge = vw/2+178)
  and blocks its top rows (Export-for/Format/Quality).

Real defect class: **global top-center toast placement collides with fixed top-center
editor chrome (VC pill) always, and with the export popover at ≤1030px widths.** Fix
options (queue row, owner = whoever holds header/toaster surfaces): move Toaster to a
corner (bottom-left clears both), or per-surface `position` for the editor, or offset
below the header (y > 54). Screenshot evidence: scratchpad `bug8-*.png`, C4-A shots 02/08.

Note in passing: anon Generate panel in this env rendered no composer textarea (0
`<textarea>` in DOM) while C4-A shots show one — likely backends hydration failing
silently for anon; worth a look in a future wave (queued as a new row).

### BUG10/BUG11/BUG13 — fixed, merged to campaign branch, verified

- BUG13 @358f5430 (merge c5a6f394): constructor guard + 6 unit tests; 39/39 element-command
  tests pass; typecheck 0. GitNexus upstream impact = CRITICAL (breadth-driven: 19
  transitive dependents of a shared class; change is additive validation, no valid-caller
  behavior change; detect_changes = LOW, 0 affected processes). **Flagged for L0 merge
  review per doctrine.** Tier: merged+unit-tested.
- BUG10 @7e82d204 (merge 8e9faf04): `middleTruncate` helper (only truncates > head+tail+1)
  + 7 unit tests. **Browser-verified locally**: Text panel now renders "Heading /
  Subheading / Body Text / Caption / Label / Badge" clean — no doubled fragments.
  (GitNexus impact HIGH = fan-out artifact of shared DraggableItem; detect_changes LOW.)
- BUG11 @09caee10 (merge c8325231): Enter/F2 enters edit mode (guarded on `isEditing` so
  commit/enter don't collide), aria-label + hint title; idiom copied from
  `editable-timecode.tsx`. **Browser-verified locally**: Tab→Enter→type→Enter commits
  ("W2 Renamed" persisted, back to readOnly); F2→type→Escape reverts. Impact LOW.

### Operational incidents (for L0)

- **Worker worktree isolation broke on SendMessage-resume**: W1 (BUG13) and W3 (BUG10),
  resumed after their HIGH/CRITICAL stop-and-report, both landed in THIS orchestrator's
  worktree and juggled each other's branches/HEAD mid-task. Both self-repaired cleanly
  (verified: all three fix branches have correct parents and exact scoped diffs; campaign
  docs commit intact; a clobbered `.claude/launch.json` was restored). Watch for this
  failure mode when resuming worktree-isolated workers.
- The 8420 health-poll leak (queue chore C5) re-confirmed AGAIN: continuous
  `ERR_CONNECTION_REFUSED` bursts in console during every headless session.

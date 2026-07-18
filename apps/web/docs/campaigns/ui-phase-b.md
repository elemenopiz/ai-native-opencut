# C15 · UI Phase B — campaign log

**Branch:** `campaign/ui-phase-b` (off `main` @8f50401a) · L1: opus orchestrator · **local-only mode**
**Binding style:** `docs/design/DIRECTION-LOCKED.md` (Direction A — Instrument-Grade Minimal + generation-glow) and the phase-A §6 ordered plan (`2026-07-17-ui-direction-phase-a.md`).
**Item 1 (Export CTA)** already SHIPPED @ec13493d (C15a) — not redone here.
**ID range for new bugs:** BUG73–BUG79 (max filed in queue = BUG61; range clear).

## Territory
Exclusive: `components/editor/**`, `components/ui/**`, `app/globals.css`, editor-page layout files for the guide fix.
Carve-out LIFTED 2026-07-18: C25 audio-lifecycle merged to main @325a08dd — audio views (`panels/assets/views/audio-*.tsx`, `sounds.tsx`, recording flow, `timeline/record-button.tsx`) are RELEASED and now in scope for item 6.
Off-limits: `lib/**`, `services/**`, `stores/**` (read-only), export e2e (C24).
Main moved since launch: `assets.tsx` (C26 mediaAssetSignature + C25 previewRatio square-tiles), `audio-recording.tsx`, `timeline/record-button.tsx` (discard X). Workers branch off CURRENT main; reconcile these at merge.

## Token contract (W1 owns globals.css; all other workers CONSUME these names)
Added to `app/globals.css`. Dark-only: define real values in `.dark` (and `:root`/`.panel` for parity), expose via `@theme inline`.

| Token | Value (target — W1 may refine) | Utility |
|---|---|---|
| `--surface-canvas` | `hsl(0 0% 5%)` | `bg-surface-canvas` |
| `--surface-panel` | `hsl(0 0% 10%)` | `bg-surface-panel` |
| `--surface-raised` | `hsl(0 0% 14%)` | `bg-surface-raised` |
| `--surface-overlay` | `hsl(0 0% 12%)` | `bg-surface-overlay` (ALL floating UI) |
| `--shadow-panel` | `0 1px 2px 0 hsl(0 0% 0% / .4)` | `shadow-panel` |
| `--shadow-float` | `0 8px 28px -6px hsl(0 0% 0% / .55), 0 2px 8px -2px hsl(0 0% 0% / .4)` | `shadow-float` |
| `--radius-xl` | `1rem` | `rounded-xl` |
| `--text-2xs` | `0.66rem` (~10.5px) + line-height | `text-2xs` |
| `--text-3xs` | `0.58rem` (~9.3px) + line-height | `text-3xs` |
| `--tone-warning` | `hsl(38 92% 55%)` | `text-tone-warning` / `bg-tone-warning` |
| `--tone-info` | reuse `--primary` or `hsl(200 98% 55%)` | `text-tone-info` |
| (reuse) `--destructive` / `--constructive` | existing | status danger/success |
| `--glow-generation` | `0 0 0 1px color-mix(in srgb, var(--primary) 55%, transparent), 0 0 16px 2px color-mix(in srgb, var(--primary) 35%, transparent)` | `.glow-generation` utility class (+ optional soft pulse) |

**Focus recipe (one, everywhere):** `focus-visible:outline-none focus-visible:border-primary focus-visible:ring-1 focus-visible:ring-primary/20` — the Textarea/Select/NumberField pattern; apply to Input/Button/Tabs/Checkbox/Slider.

**Glow rule (binding):** `.glow-generation` applies ONLY while generation is live (active task rows, generating clips/slots). It is removed the instant generation completes. Nothing else glows, ever. Never add `dark:` prefixed classes anywhere.

## Worker roster (partitioned by DISJOINT file sets; W1's tokens consumed by all)
All workers: Sonnet, isolated worktree, background, branch `task/<x>` off `main` as step 1.

| W | Item(s) | Owned files (exclusive) |
|---|---|---|
| **W1** | Item 2 (tokens/focus/dark-sweep/dead-light) + `--text-2xs/3xs` + `--radius-xl` + glow token/utility + `<Kbd>` primitive (Item 7 partial) | `app/globals.css`; `components/ui/{input,button,textarea,select,number-field,checkbox,slider,tabs,card,badge,label,switch,toggle,toggle-group,radio-group}.tsx`; new `components/ui/kbd.tsx` |
| **W2** | Item 3 (overlay discipline) + tasks docked mini-bar + glow on active task rows | `components/ui/{popover,dropdown-menu,context-menu,menubar,dialog,sheet,tooltip,hover-card,sonner,toast,alert-dialog}.tsx`; `components/editor/background-tasks.tsx` |
| **W3** | Item 4 (Board rebuild) + provenance badges → status tokens | `components/editor/board/reel-board.tsx`; `components/editor/take-provenance-badge.tsx` |
| **W4** | Item 5 (micro-type codemod) + BUG28 timeline empty-state hint + generating-clip/slot glow | `components/editor/panels/timeline/**` (incl. `generative-slot-content.tsx`, `timeline-element.tsx`, `index.tsx`); `components/editor/ai/**`; `components/editor/panels/properties/**` (micro-type only) |
| **W5** | Item 6 (left-rail card unification: Assets/Text/Templates/Audio) + skeletons + red IMPACT retone + insights/factcheck/credit-pill dark: fixes + BUG27 (first-run guide fix) | `components/editor/panels/assets/views/{assets,text,template-gallery,sounds,audio-combined,factcheck,insights}.tsx`; `components/editor/credit-balance-pill.tsx`; `components/editor/empty-editor-guide.tsx`; `app/editor/[project_id]/page.tsx` |

Deferred (close-out or next wave if budget short): Item 7 remainder (`h-[3.4rem]` header, apply `<Kbd>` to 5 hand-rolled copies), Item 8 (Scopes idle graticule + primary-action disambiguation), Item 9 (raw div-onClick sweep — explicit STRETCH).

## Sequencing
W1 lands FIRST (tokens). W2–W5 branch off main in parallel and reference token NAMES from the contract above (so they don't block on W1). Merge order into campaign: W1 → W2 → W3 → W4 → W5, reconciling only if same-file (should be none by construction).

## Definition of done (per item)
Landed on campaign tip; typecheck exit 0 (check real exit code, not tail-piped); lint no-worse than ~339e/225w; NO `dark:` pairs added; before/after screenshots in `docs/campaigns/assets/ui-phase-b/`; battery green on tip.

## Status (records the PAST only)
| Item | Worker | Status |
|---|---|---|
| Item 2 — tokens/focus/dark/Kbd | W1 | MERGED to campaign @55187102 (worker @36dc03f0; typecheck 0; diff reviewed) — browser pass pending |
| Item 3 — overlays + tasks mini-bar + task glow | W2 | in-flight |
| Item 4 — Board rebuild | W3 | CHERRY-PICKED to campaign @373465d2 (worker @c0ce5e9d; typecheck 0; diff reviewed) — browser pass pending |
| Item 5 — micro-type codemod + BUG28 + clip glow | W4 | MERGED to campaign @6b665e3c (worker 2 commits: 254-site codemod + BUG28/glow; typecheck 0; diff reviewed) — browser pass pending |
| Item 6 — left-rail cards + BUG27 | W5 | in-flight |
| Item 7 — header/chrome remainder | — | DEFERRED |
| Item 8 — Scopes graticule | — | DEFERRED |
| Item 9 — div-onClick sweep | — | STRETCH (skip) |

## Worker log
- **W1** (task/w1-tokens-primitives @36dc03f0): DONE. globals.css + 9 primitives + kbd.tsx. Typecheck 0. Decisions: light `:root`/`.panel` blocks deleted with single-declaration tokens hoisted into `.dark`; focus recipe applied to 8 primitives (incl. ring-0 zero-width fixes in Textarea/Select/NumberField); textarea dark:bg-input/30 → bg-input/30. Kbd call sites NOT swapped (close-out pass). Could not browser-verify. Review note (L1): Button focus ring now `ring-1 ring-primary/20` — possibly too faint on borderless variants; check in browser pass.
- **W4** (task/w4-microtype-codemod, 2 commits): DONE. 254 arbitrary text-[7..11px] sites → text-2xs/text-3xs across 34 files (timeline/ai/properties), 0 remaining in owned dirs; 1 dark: pair folded (smart-suggestions.tsx). BUG28: empty timeline previously rendered a 0-height `<div/>` — now a 160px centered quiet hint. Glow: `isGenerating && "glow-generation"` on GenerativeSlotContent root only. Typecheck 0; lint delta 0. IMPORTANT BASELINE CORRECTION: W4 measured main lint baseline = **152e/225w** (the ~339e figure in the brief was stale); W4 matches main exactly. No screenshots (worker worktree lacked env).

- **W3** (task/w3-board-rebuild @c0ce5e9d): DONE. Board rebuilt on Radix Dialog (DialogPortal + direct DialogPrimitive.Content; full-bleed kept, documented; opaque `bg-surface-overlay` scrim). All raw buttons → Button primitive; amber star CTA → `--primary`; real BoardEmptyState (icon+title+desc+CTA). Provenance badge tiers → constructive/primary/tone-warning tokens, 0 `dark:` left. Typecheck 0. INTEGRATION NOTE: worker branched off stale ef4759c6 carrying 2 unrelated record-button commits — L1 cherry-picked ONLY c0ce5e9d; clean 3-way apply, main's newer board features (true-ratio previews, thumbnailUrl poster) verified preserved on tip. W3 could not browser-verify (declined to create an account at the beta gate — correct call).

## Lint baseline
L1 measured `bun run lint` (apps/web) on campaign tip after W1+W4 merges: **339e/225w — exactly the briefed baseline** (no-worse holds). W4's reported "152e" came from a different script invocation (`lint:web`); the 339e/225w figure is the operative one.

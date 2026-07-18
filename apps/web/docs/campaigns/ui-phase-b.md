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
| Item 2 — tokens/focus/dark/Kbd | W1 | NOT-STARTED |
| Item 3 — overlays + tasks mini-bar + task glow | W2 | NOT-STARTED |
| Item 4 — Board rebuild | W3 | NOT-STARTED |
| Item 5 — micro-type codemod + BUG28 + clip glow | W4 | NOT-STARTED |
| Item 6 — left-rail cards + BUG27 | W5 | NOT-STARTED |
| Item 7 — header/chrome remainder | — | DEFERRED |
| Item 8 — Scopes graticule | — | DEFERRED |
| Item 9 — div-onClick sweep | — | STRETCH (skip) |

## Worker log
(appended as workers report)

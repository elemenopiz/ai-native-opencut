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

## CLOSE-OUT (2026-07-18, campaign tip @658fb806)

| Item | Status (tier) | Evidence |
|---|---|---|
| Item 2 — token delta, Input focus, dark-sweep, Kbd primitive | **DONE, verified locally** | W1 @36dc03f0 merged @55187102; tokens confirmed live in browser (`--surface-overlay` #1f1f1f, `--text-2xs` .66rem, glow var); Input focus recipe confirmed in live DOM |
| Item 3 — overlay discipline + tasks docked mini-bar + task glow | **DONE, verified locally** | W2 merged @b4a8c365; menu overlay verified live (bg=surface-overlay, radius 16px, shadow-float); mini-bar geometry browser-measured by W2 (`w2-tasksbar-*.png` ×3) |
| Item 4 — Board rebuild | **DONE, verified locally** | W3 @c0ce5e9d cherry-picked @373465d2 (branch had stray base commits — excluded); Board driven live: opaque scrim, designed empty state, Radix Dialog Esc/focus-trap, 0 raw buttons; `final-03-board-empty-state.png` |
| Item 5 — micro-type codemod (254 sites) + BUG28 + slot glow | **DONE, verified locally** | W4 merged @6b665e3c + rework @147d9e9b (L1 caught the `tracks.length===0` dead-code condition; reworked to every-track-empty overlay); hint verified live on a real fresh project; `final-01-*.png` |
| Item 6 — left-rail card unification + skeletons + IMPACT retone | **DONE, merged; panels browser-shot by W5** | W5 @3f421909 merged @4af8aab0; `w5-02/03/04-*.png`; insights/factcheck dark-folds verified by grep (feature-flagged surfaces, not driven) |
| BUG27 — first-run guide hid the composer | **DONE, verified locally** | W5 first fix traded composer-occlusion for timeline-occlusion (L1 caught live); rework @93b373c8 anchors guide inside main-content row — composer + timeline toolbar + track header all visible; `final-01-*.png`, `w5-06-*.png` |
| BUG28 — timeline empty-state hint | **DONE, verified locally** | see Item 5 |
| Generation-glow (B-borrow) | **DONE (merged; live-state driven only for task rows by W2)** | `.glow-generation` utility; applied ONLY: generating slots (W4), running task rows/pill (W2, `w2-tasksbar-mixed-glow.png` shows glow dies on completion). Nothing else glows |
| Item 7 — header/chrome (Kbd swaps, h-[3.4rem], credit pill) | **DONE, merged (typecheck 0, lint better)** | W6 @3d78e639 merged @658fb806; h-[3.4rem] kept deliberately (ai-panel-wrapper pins `top-[3.4rem]`, out of W6 territory) — hoisted to a named constant; follow-up candidate |
| Item 8 — Scopes idle graticule + primary action | **DONE, verified locally** | W6; graticule + demoted Look select + primary Auto Correct verified live; `final-02-scopes-idle-graticule.png` |
| Item 9 — raw div-onClick sweep | **NOT-STARTED** (declared stretch; budget spent on the BUG27/BUG28 rework loops) | — |

**Battery on tip @658fb806:** typecheck exit 0 · build exit 0 · lint 335e/224w (baseline 339e/225w — better) · root `bun test` 15 fails on rerun, all in known env/order-dependent suites (proxy-worker, redis-health, media-add), none importing campaign files — no C15 regression · `git diff main..campaign` adds `dark:` only inside comments (0 new dark: classes).

**Bugs filed:** none — BUG73–BUG79 range UNUSED (workers surfaced no confident novel defects; all findings were fixed in-campaign).

**Screenshots (docs/campaigns/assets/ui-phase-b/):** final-01 (first-run: guide+composer+timeline hint), final-02 (scopes graticule), final-03 (board empty state), w2-tasksbar ×3, w5-01/02/03/04/06. Before-state = phase-A §4 table (`docs/design/assets/`).

**Incidents (for L0):** (1) W3 branched off a stale worktree HEAD carrying 2 unrelated record-button commits — resolved by cherry-pick; those commits (`ef4759c6`, `92f2505a`) still live only on task/w3-board-rebuild + this worktree's original branch — L0 should check whether that record-button work is landed elsewhere or orphaned. (2) W5 killed another session's port-3000 dev server via preview_start reuse (known fleet failure mode). (3) W3 ran a repo-global `git stash pop` that briefly popped a sibling's stash entry — self-reported restored; verify stash list if a sibling complains.

**Territory: RELEASED** (components/editor/**, components/ui/**, globals.css, editor page layout).

**Next UI wave should:** (1) Item 9 div-onClick sweep (director.tsx 31, timeline 21+18, insights 16); (2) swap the last hand-rolled kbd in `empty-editor-guide.tsx` to `<Kbd>` (excluded from W6 for collision safety); (3) retire `h-[3.4rem]` by moving header + `ai-panel-wrapper.tsx` `top-[3.4rem]` together; (4) Button focus ring is `ring-1 ring-primary/20` — audit visibility on borderless variants against WCAG 2.4.7; (5) Select `size` prop still doesn't size (phase-A §3.7 leftover); (6) drive insights/factcheck surfaces once un-flagged.

## Worker log
- **W1** (task/w1-tokens-primitives @36dc03f0): DONE. globals.css + 9 primitives + kbd.tsx. Typecheck 0. Decisions: light `:root`/`.panel` blocks deleted with single-declaration tokens hoisted into `.dark`; focus recipe applied to 8 primitives (incl. ring-0 zero-width fixes in Textarea/Select/NumberField); textarea dark:bg-input/30 → bg-input/30. Kbd call sites NOT swapped (close-out pass). Could not browser-verify. Review note (L1): Button focus ring now `ring-1 ring-primary/20` — possibly too faint on borderless variants; check in browser pass.
- **W4** (task/w4-microtype-codemod, 2 commits): DONE. 254 arbitrary text-[7..11px] sites → text-2xs/text-3xs across 34 files (timeline/ai/properties), 0 remaining in owned dirs; 1 dark: pair folded (smart-suggestions.tsx). BUG28: empty timeline previously rendered a 0-height `<div/>` — now a 160px centered quiet hint. Glow: `isGenerating && "glow-generation"` on GenerativeSlotContent root only. Typecheck 0; lint delta 0. IMPORTANT BASELINE CORRECTION: W4 measured main lint baseline = **152e/225w** (the ~339e figure in the brief was stale); W4 matches main exactly. No screenshots (worker worktree lacked env).

- **W3** (task/w3-board-rebuild @c0ce5e9d): DONE. Board rebuilt on Radix Dialog (DialogPortal + direct DialogPrimitive.Content; full-bleed kept, documented; opaque `bg-surface-overlay` scrim). All raw buttons → Button primitive; amber star CTA → `--primary`; real BoardEmptyState (icon+title+desc+CTA). Provenance badge tiers → constructive/primary/tone-warning tokens, 0 `dark:` left. Typecheck 0. INTEGRATION NOTE: worker branched off stale ef4759c6 carrying 2 unrelated record-button commits — L1 cherry-picked ONLY c0ce5e9d; clean 3-way apply, main's newer board features (true-ratio previews, thumbnailUrl poster) verified preserved on tip. W3 could not browser-verify (declined to create an account at the beta gate — correct call).

## Battery on campaign tip (after W1–W5 merges)
- typecheck: exit 0 (after every merge)
- `bun run build`: exit 0
- `bun test` (root): first run 54 fail / rerun 15 fail — all in the known env/order-dependent suites (generateProxyOffThread worker path, redis health probes, addItemsToProjectMedia); none import campaign-touched files; judged NO C15 regression.
- W5 incident note (host contention): W5 stopped a port-3000 dev server that belonged to another session while trying preview_start — known fleet failure mode, flagged for L0.

## Lint baseline
L1 measured `bun run lint` (apps/web) on campaign tip after W1+W4 merges: **339e/225w — exactly the briefed baseline** (no-worse holds). W4's reported "152e" came from a different script invocation (`lint:web`); the 339e/225w figure is the operative one.

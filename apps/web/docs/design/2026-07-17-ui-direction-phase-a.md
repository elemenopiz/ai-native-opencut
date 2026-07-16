# UI Direction — Phase A (design-only)

**Campaign:** `campaign/ui-direction-phase-a` · 2026-07-17
**Status: PROPOSAL — nothing here is implemented. This doc ends in a taste-gate: the user picks a direction before any phase-B code.**

Byorn is a dark-only, serious editor (CapCut-grade timeline + generative spine). The bar for
this pass: DaVinci Resolve / Descript / Linear-grade polish — never candy-gradient
generic-AI styling.

**How this was produced:** live capture of the current editor (worktree dev server @ main
`3c7e41c8`, 1680×1000, real seeded takes via the E2E bridge — screenshots in `assets/`),
plus three independent audits: a token/primitives inventory (`components/ui`, `globals.css`),
an editor-surface usage audit (`components/editor/**`), and a visual critique of the
captured screens. Findings below carry file:line or screenshot evidence.

**Evidence index (`apps/web/docs/design/assets/`):**

| Shot | Surface |
|---|---|
| `01-editor-empty-firstrun.png` | Fresh project + first-run guide (right panel) |
| `02-generate-panel-empty.png` | Generate tab, empty state + anon signup tooltip |
| `03-editor-populated.png` | Media panel (4 assets) · timeline (2 generative clips) · Generate v3 · tasks popover |
| `04-properties-clip-selected.png` | Properties → AI Edit inspector, clip selected |
| `05-scopes-panel.png` | Scopes tab (waveform/parade/vectorscope) |
| `06-generate-panel-populated.png` | Generate tab with project content |
| `07-board-takes.png` | Board full-screen overlay (designed empty state) |
| `08-export-dialog.png` | Export popover + tooltip collision + toast overlap |
| `10-panel-text.png` | Text presets panel |
| `11-panel-audio.png` | Audio panel (loading state) |
| `12-panel-templates.png` | Templates panel |

Capture gaps (verify in phase B): command palette (Cmd/Ctrl+K did not open under headless
Chromium — possibly a real binding bug, queued below), populated Board + take-review dialog
(the bridge lands takes on slots; populating Board needs the authed panel flow).

---

## 1 · Current state — what the system actually is

One structural fact reframes everything: `layout.tsx:49-53` sets `forcedTheme="dark"`.
The `.dark` class is permanent. Every `:root` light-token block in `globals.css` is dead
code, and every `dark:`-prefixed class in the app is "the style, written the long way" —
with its unprefixed base pair silently dead and untested (the known `dark:bg-input/30`
Textarea bug class; it is still present in the primitive, `textarea.tsx:12`).

**Tokens that exist** (`globals.css`): an hsl-based neutral ramp — canvas `hsl(0 0% 5%)`,
`.panel` surface `hsl(0 0% 10%)` (applied by DOM nesting, not a named token), borders
16%/18%, muted 20-22%. **One accent:** `--primary: #009dff` — the only hex in the token
system. Radii: 3 steps (`0.35/0.65/0.82rem`) — but Card and DropdownMenuSubContent use
stock `rounded-2xl` (1rem), a fourth accidental radius. Type: Inter only, with a
deliberately compressed custom scale (`--text-xs 0.72rem / sm 0.79 / base 0.92`) that
covers only the bottom of the range. **No shadow tokens, no spacing tokens, no mono/display
font.**

**Where the quality bar already lives:** the first-run guide (01), Properties `Section`
chrome (04, `panels/properties/section.tsx` — token-clean and genuinely accessible), Scopes
(05), the timeline toolbar and preview toolbar (post-cleanup, zero violations found). The
product's own best screens are already "instrument-grade" — the direction question is
whether the rest catches up to them.

**Where it collapses:** Board, the assets-panel views, and — worst of all — the Export CTA.

## 2 · Top offenders (merged: code + visual evidence)

1. **The Export button** (`export-button.tsx:85-108`; shots 01/03/08). The single
   highest-stakes CTA in the product ("crown = real export") is a raw `<button>` bypassing
   the Button primitive, with a hardcoded two-layer hex gradient (`#38BDF8`,
   `from-[#2567EC] to-[#37B6F7]`), a glossy `to-white/50` glass-sheen overlay — textbook
   generic-AI styling, the exact thing the brand brief forbids — five arbitrary rem values,
   a hardcoded rgba shadow, and **zero** hover/focus-visible/active states. Visually it
   also breaks accent discipline: it is a louder, more saturated blue than every other
   accent, so it reads as "the CTA" by shouting, not by design.
2. **Background-tasks popover occlusion** (shots 03/04/08). The task stack permanently
   covers the last clips of both timeline tracks, and in 08 sits on top of the Export
   dialog's watermark section. Compounded in 08 by a second collision: the anonymous
   "Sign up to use AI features" tooltip overlaps the Export popover's header. Three species
   of floating surface (popover/tooltip/toast) with no shared elevation or placement
   contract.
3. **Board** (shot 07; `board/reel-board.tsx`). Furthest surface from the bar: a hand-built
   `fixed inset-0` overlay (sibling flow `take-review.tsx` correctly uses Dialog), a
   leaking semi-transparent scrim with ghost UI bleeding through, 10+ raw `<button>`s
   re-implementing what Button centralizes, no focus-visible anywhere, a hardcoded amber
   CTA, and an undesigned empty state — one line of small gray text in a black void, on
   the same screen family whose first-run guide (01) proves the team can design an empty
   state.
4. **Dead-style bug class + the Input focus hole** (`components/ui`). 25 `dark:`-pair
   instances across 7 files whose base halves never render (`take-provenance-badge.tsx:97`,
   `insights.tsx:106-141`, `factcheck.tsx:29`, `credit-balance-pill.tsx:39`, …). And the
   most-used primitive in the app, **Input, has no focus-visible treatment at all**
   (`input.tsx:11` — `focus-visible:ring-0` with no compensating border) while three
   different focus-ring recipes coexist across the other primitives. WCAG 2.4.7 gap on the
   highest-traffic control.
5. **Micro-type + card-system sprawl** (shots 03/10/11/12). 700+ arbitrary
   `text-[7px..11px]` instances across `ai/**`, assets views, properties views — seven
   near-duplicate sizes with no token. Four left-rail panels use four different card
   systems (assets grid vs text presets vs templates rows vs audio chips), with visibly
   different padding, truncation, and tag-chip treatments — same rail, four design
   languages. The lone saturated red "IMPACT" preset (10) is the only non-blue hue in the
   product.

**Defects found in passing (queue rows for L0, not design calls):** Cmd/Ctrl+K palette did
not open under headless Chromium (repro attempt needed — possible focus/binding bug);
export-popover × signup-tooltip z-order collision (08); tasks-toast occludes timeline
content (03) — the *behavior* is a bug even if the *styling* is design; text-preset label
truncation renders doubled fragments ("Body Text…ext", 10); "Loading sounds…" has no
spinner/skeleton (11); Board scrim transparency leak (07); `EditableProjectName` has no
keyboard path into edit mode (`editor-header.tsx:449-523`).

## 3 · Proposed token-system delta (not a rewrite)

The foundation is sound; this is consolidation. As a delta from current `globals.css` /
`components/ui`:

1. **Surfaces, named:** replace the `.panel` DOM-nesting cascade with explicit tokens —
   `--surface-canvas` (5%), `--surface-panel` (10%), `--surface-raised` (~14%, currently
   indistinguishable from canvas), `--surface-overlay` (for every popover/menu/dialog/toast,
   so floating UI stops sharing a lightness with the page).
2. **One elevation language:** two shadow tokens — `--shadow-panel` (near-flat, docked
   chrome) and `--shadow-float` (one soft spec for all floating surfaces) — plus a single
   radius + border recipe shared by Card/Dialog/Popover/Menu. Retire `shadow-xl`,
   `popover.tsx`'s custom `shadow-[0_0_10px…]`, and the Card `rounded-2xl` drift (add
   `--radius-xl` if the larger step is wanted deliberately).
3. **One focus recipe, everywhere:** the accent-border pattern already used by
   Textarea/Select/NumberField (`focus-visible:border-primary` + soft `ring-primary/20`)
   — apply to Button/Tabs/Checkbox/Slider, and **fix Input's missing focus state** in the
   same pass.
4. **One accent, one saturation:** `#009dff` stays the only hue; nothing gets to be a
   louder blue (Export differentiates by size/weight/position). Add 2–3 semantic status
   tokens (`--tone-warning`, `--tone-info`, reuse `--destructive`/`--constructive`) and
   route the tooltip variants, provenance-badge tiers, insights/factcheck chips, board
   star-CTA amber, and ad-hoc `text-green-400`/`text-red-400` through them.
5. **Type scale, extended down:** add `--text-2xs` (~11px) and `--text-3xs` (~9-10px) and
   codemod the 700+ arbitrary sizes onto them. Keep Inter for chrome (Resolve/Linear both
   run neutral UI type); a distinctive display face is a marketing-surface question, not an
   editor one.
6. **Dark-only honesty:** delete (or clearly comment as vestigial) the unreachable `:root`
   light blocks, and sweep the 25 `dark:` pairs — fold the real value into the base class.
7. **Small primitives debt:** shared `<Kbd>` chip (5 hand-rolled copies today); make
   Select's `size` prop actually size (`select.tsx:34,41-44`); align control heights
   (Input h-9 vs Select h-7 in the same rows); fix DropdownMenu content/subcontent radius
   mismatch.

## 4 · Per-panel findings (evidence per surface)

| Surface | Verdict | Key findings (evidence) |
|---|---|---|
| **First-run guide** | at the bar | Best moment in the app (01). Minor: floats frameless on canvas; step numerals could carry the accent. |
| **Properties/inspector** | at the bar (chrome) | `Section` primitive is token-clean + accessible (04). Content views carry the micro-type habit (31× `text-[10px]`…). "Coming soon" Upscale row styles a dead dropdown as live (04). |
| **Scopes** | at the bar | Real instrument density (05). Scope canvas is dead black at rest — needs an idle graticule; primary vs "Auto Correct" ambiguity. |
| **Timeline toolbar / preview toolbar** | at the bar | Zero violations found; the cleanup waves held. Timeline *clips* still: arbitrary px sizes, identical rendering for all generative clips — no per-clip identity (03). |
| **Generate panel (v3)** | near the bar | Disciplined (03/06). Placeholder doubles two instructions; references dropzone outweighs the prompt; a third icon language for cost (06). |
| **Export** | worst CTA + dialog issues | The button (see offender #1). Dialog: three equal-weight full-width actions, no visible selected platform preset, toast overlap (08). |
| **Board / takes** | furthest from bar | See offender #3 (07; `reel-board.tsx`, `take-provenance-badge.tsx:97-104`). |
| **Media/assets views** | heaviest debt | 200× `text-[10px]` + 6-way dead `dark:` tone maps (`insights.tsx:106-141`, `factcheck.tsx:29-31`); self-admitted badge-chrome duplication (`assets.tsx` ~1074); 31 raw div-onClicks in `director.tsx`. |
| **Text / Audio / Templates panels** | drifting | Four card systems across one rail; lone red preset; ellipsis-truncation renders doubled fragments; bare "Loading sounds…" with no skeleton (10/11/12). |
| **Header / chrome** | mostly clean | `h-[3.4rem]` one-off; `EditableProjectName` keyboard/focus gap (`editor-header.tsx:449-523`); credit pill carries a `dark:` pair. |
| **Dialogs (shared)** | structurally sound | All on the Dialog primitive; two token outliers (`mcp-connect-dialog.tsx:257`, `delete-project-dialog.tsx:71`). |

## 5 · Aesthetic directions (pick one)

### A · Instrument-Grade Minimal — **recommended**
Hairline borders, near-black neutral ramp, **one accent at one saturation**, one elevation
language, one card system, labels (or a Resolve-style paged bar) on the icon rail.
- **Changes:** flatten Export into the system (differentiate by weight/position, not a
  louder blue); redesign Board's empty state + opaque scrim; unify the four card systems;
  idle graticule for Scopes; the red IMPACT preset joins the system or becomes the one
  documented exception.
- **Stays:** the near-black palette, compressed type scale, Properties/Scopes density.
- **Already closest:** 01, 04, 05 — the direction is "make everything look like the app's
  own best screens," removal of inconsistency rather than new language.

### B · Cinematic Console
Deeper blacks, letterboxed monitor framing, filmstrip texture on generative clips, and glow
reserved **exclusively** for live "AI is working" states.
- **Changes:** earned glow on generation-in-progress (task rows, generating slots); clip
  chrome reads as footage, not gradient swatches; panel chrome darkens relative to canvas.
- **Risk:** drifts toward DAW-skin if glow leaks into decoration.
- **Already closest:** 03/06 (live task moments), 05.

### C · Editorial SaaS (Linear-grade)
Tight 4px rhythm, dense data-forward rows, one shared floating-surface component for
popover/dialog/tooltip/toast.
- **Changes:** normalize all overlays to one elevation component (kills the 08 collisions
  by construction); denser assets grid; tighter vertical rhythm everywhere.
- **Risk:** the highest chance of landing "generic dashboard" instead of "tactile editor" —
  directly against the brief.
- **Already closest:** 06/12.

**Recommendation: A, borrowing exactly one idea from B** — glow strictly scoped to
active-generation states. Rationale: A is the only direction that is *latent in the
product's own best screens*; it subtracts inconsistency instead of adding language; and it
matches the serious-editor positioning (Resolve's chrome discipline, Linear's restraint)
while B's single borrowed moment gives the generative spine — the actual differentiator —
its one place to visibly feel alive.

## 6 · Phase-B plan (after the taste-gate, panel-by-panel)

Ordered for craft-signal per effort; each lands with screenshot evidence:

1. **[S] Export button** — onto the Button system (or one deliberate, documented branded
   variant), full state coverage. Highest visibility, lowest effort.
2. **[S] Token delta, part 1** — surface/elevation/focus/status tokens into `globals.css`
   + `components/ui`; fix Input focus; sweep the 25 `dark:` pairs; delete dead light blocks.
3. **[M] Overlay discipline** — one floating-surface recipe; tasks popover gets a docked/
   collapsed behavior so it stops occluding timeline + dialogs (03/08); fix the
   export×tooltip collision.
4. **[M] Board rebuild** — Dialog/Sheet (or documented full-bleed exception), Button
   everywhere, focus-visible, designed empty state, opaque scrim, provenance badges onto
   status tokens.
5. **[M] Micro-type codemod** — `--text-2xs/3xs` tokens, sweep `ai/**` + assets +
   properties + timeline.
6. **[M] Left-rail card unification** — one card/tag-chip/truncation system across
   Assets/Text/Templates/Audio; loading skeletons.
7. **[S] Header + chrome** — EditableProjectName semantics, `h-[3.4rem]`, shared `<Kbd>`.
8. **[S] Scopes idle graticule + primary-action disambiguation.**
9. **[L] Raw-interactive sweep** — div-onClick triage (director.tsx 31, timeline 21+18,
   insights 16); case-by-case, last.

Panel ownership note: phase B is the only campaign allowed in `components/editor/**` +
styles while it runs (per mission-control C4 card).

---

## 7 · THE TASTE-GATE — decisions needed from you

Nothing ships until you call these:

1. **Direction:** A (instrument-grade minimal + B's generation-glow borrow — recommended),
   B (cinematic console), or C (editorial SaaS)? Or a different mix — say which screens
   in `assets/` feel most "Byorn" to you.
2. **Export CTA:** flatten into the system (recommended), or keep a *single* deliberate
   branded-gradient exception — redesigned properly (states, tokens), but louder than
   everything else on purpose?
3. **Accent policy:** one blue (`#009dff`) at one saturation everywhere, plus quiet
   semantic status tones — yes/no? Does the red IMPACT text preset survive?
4. **Icon rail:** add persistent labels / Resolve-style paged bar (bigger change, better
   learnability), or keep the icon-only rail (status quo, tooltips only)?
5. **Mechanical pre-approvals** (safe regardless of direction, can start phase B day one):
   micro-type tokens + codemod, `dark:` sweep, Input focus fix, dead light-token cleanup —
   approve as a batch?
6. **Tasks popover behavior:** docked mini-bar that never covers timeline/dialog content
   (recommended), or keep floating but auto-collapse?

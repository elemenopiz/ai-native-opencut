# UI Direction — LOCKED (user decision, 2026-07-18)

**Binding style source for all UI work from this date.** Supersedes nothing — implements
the phase-A proposal (`2026-07-17-ui-direction-phase-a.md`) as decided by the founder.

## The decision

**Direction A — Instrument-Grade Minimal — with exactly one borrow from B: glow strictly
scoped to active AI-generation states.**

Decided via the G7 taste-gate (2026-07-18, all recorded in SPEEDRUN-QUEUE §0):

1. **Direction:** A + generation-glow. "Make everything look like the app's own best
   screens" (first-run guide, Properties Section chrome, Scopes). Subtract inconsistency;
   add no new language. The ONE exception: elements actively generating (task rows,
   generating clips/slots) may carry a soft `--primary`-tinted glow while work is live.
   The glow dies the moment generation completes. Nothing else glows, ever.
2. **Export CTA:** flattened into the Button system — SHIPPED @ec13493d (C15a):
   additive `variant="primary"` on the Button primitive, one blue, full states.
3. **Accent:** one blue `#009dff` at one saturation everywhere + quiet semantic status
   tokens. Nothing gets to be a louder blue. The red IMPACT preset joins the system.
4. **Icon rail:** stays icon-only (tooltips), no labels, no paged bar.
5. **Phase B launched as planned** (user: "Launch UI phase B on this") — the 9-item
   ordered plan in phase-A §6, item 1 already done. Includes the mechanical batch
   (micro-type tokens + codemod, `dark:` sweep, Input focus fix, dead light-token
   cleanup) and the tasks-popover docked mini-bar (recommended option).

## Hard rules for implementers

- Dark-only, serious-editor aesthetic: DaVinci Resolve chrome discipline, Linear
  restraint. Never candy-gradient generic-AI styling.
- One accent (`--primary` #009dff); semantic status tones only via tokens.
- One elevation language; one focus recipe (accent-border + soft ring, the
  Textarea/Select/NumberField pattern); one card system per rail.
- Glow = generation-in-progress ONLY. If it isn't actively generating, it doesn't glow.
- `dark:` prefixes are dead weight (forcedTheme="dark") — fold real values into base
  classes; never add new `dark:` pairs.

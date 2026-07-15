# Generation UI v3 — "Palmier-matched" implementation spec

Status: APPROVED by owner 2026-07-15 (gate mockup v3 signed off).
Mockup (source of truth for look): claude.ai artifact "Byorn Generate — Rethink v3", plus three
Palmier reference screenshots. This doc translates the mockup into exact classes/behavior.

Scope: the Generate panel — `apps/web/src/components/editor/panels/assets/views/generate.tsx`
and the studio components it renders. Personas tab body is OUT of scope (only its tab chrome
changes). No new dependencies. No API/route changes except where listed (none server-side).

## Hard preserve list (do not break)

- Submit paths + hooks: `useStudioGeneration`, `useSlotGeneration`, `generateMultiframe`,
  persona still pre-render, image fan-out chunks, audio poll/cancel logic.
- `gateOn402`, credits refresh, `CostApprovalDialog` (component stays; its only caller here —
  the batch bar — is being removed, so the import may go away in generate.tsx; do NOT delete
  the component file).
- @mention system: handles, autocomplete dropdown, insert-on-click chips behavior.
- `EnhancePromptButton` (moves location, same props/behavior).
- All data-testids: `video-gen-*`, `image-gen-*`, `audio-gen-*` (settings-trigger, submit,
  mode tabs). Keep existing ids attached to the equivalent new elements.
- `__BYORN_E2E__` bridge, frame-chain + omni-reference-chain consumption effects,
  backend capability coercion effects, sticky settings in `useStudioSettingsStore`.
- Light theme must remain usable: implement fills with `foreground/N` alpha tokens (they
  invert automatically), never hardcoded dark-only grays — EXCEPT the two cream accents
  listed in Tokens, which get explicit `dark:` variants.

## Removals (approved)

1. **Batch/slots bar** in generate.tsx (the "N slots reserved / Alternatives / Review /
   Generate all" card) — delete the JSX, its local state (`alternatives`, `batchBusy`,
   `reviewOpen`, `slots`, `approvalOpen`, `runBatch*`, `batchCost`) and now-unused imports
   (`useSlotGeneration`, `estimateBatchCost`, `needsApproval`, `CostApprovalDialog`,
   `TakeReview`, `Coins01Icon`, `Button` if unused). Batch generation stays reachable via the
   Director. If any e2e test references the batch bar, update/remove that test.
2. **Name field** in generation-form.tsx (state, Input row, its toast).
3. **Camera section in the settings popover** (moves into the composer tool row).
4. **Amber precondition text** — replace with neutral muted (`text-muted-foreground`).

## Tokens (the system — apply everywhere in this panel)

Type (only these five):
- prompt text: `text-[14.5px] leading-relaxed` (400)
- mode tabs: `text-sm font-semibold` (14/600)
- section labels + model name + media tabs: `text-[13px] font-semibold`
- chips / summary settings / cost: `text-[12.5px] font-medium`
- hints + status lines: `text-[11.5px]` (400) — NOTHING below this; delete text-[9px]/[10px]/[11px]

Fills, not outlines (chips have NO borders):
- chip rest: `bg-foreground/[0.06] text-muted-foreground`
- chip hover: `hover:bg-foreground/[0.09] hover:text-foreground`
- chip selected: `bg-foreground/[0.16] text-foreground font-semibold`
- chip focus: `focus-visible:ring-2 focus-visible:ring-foreground/40 focus-visible:outline-none`
- chip disabled: `opacity-40`
- chip shape: `h-[30px] px-3 rounded-[10px]`; transition-colors 150ms only.

Cream accents (the ONLY two high-contrast objects):
- submit circle: `size-[38px] rounded-full bg-zinc-900 text-zinc-50 dark:bg-[#ede9e1] dark:text-[#1a1a18]`
- progress fill + resolution selected segment: same cream in dark / near-black in light:
  `bg-zinc-900 text-zinc-50 dark:bg-[#f2efe9] dark:text-[#171717]` (progress fill: no text).

Surfaces:
- composer card: `rounded-2xl border border-foreground/[0.09] bg-foreground/[0.035]`,
  internal hairline dividers `border-foreground/[0.08]`; focus-within: border-foreground/[0.16].
- settings popover: `w-80 rounded-[18px] p-[18px] space-y-[17px] border-foreground/[0.12]
  bg-popover/95 backdrop-blur-xl shadow-xl` + keep `PopoverArrow` (the tail).
- reference thumbs: 106×80, `rounded-xl`; empty slot dashed `border-foreground/[0.18]`.
- media segmented container: `p-[3px] rounded-xl border border-foreground/[0.09]`,
  active segment `rounded-[9px] bg-foreground/[0.10] text-foreground`.

## Per-file spec

### A1 · `components/studio/generation-bottom-bar.tsx`

- **GenerationBottomBar**: replace single `summary` string with two props:
  `modelLabel: string` (bright, `text-[13px] font-semibold text-foreground`) and
  `settingsSummary: string` (muted, `text-[12.5px] text-muted-foreground truncate`).
  Keep a chevron (10px, muted) left of modelLabel. Bar: `min-h-[58px] gap-2 pl-4 pr-3`.
  Cost: coin badge (15px circle `bg-foreground/[0.14]` with a 9px "$" glyph or keep
  Coins01Icon at 13px) + `text-[12.5px] font-semibold tabular-nums text-foreground/80`.
  Submit: cream circle spec above, 16px ArrowUp; busy → Spinner; disabled →
  `bg-foreground/[0.08] text-muted-foreground`.
- **ChipGrid**: restyle to filled-chip tokens. DELETE the `variant="solid"` prop entirely
  (Resolution moves to SegmentedControl). Add optional `columns?: number` — when set, render
  `grid grid-cols-{n} gap-[7px]` with centered chips instead of flex-wrap (Duration uses 5).
  Label: `text-[13px] font-semibold text-foreground/70`; hint `text-[11.5px] text-muted-foreground`.
- **NEW `SegmentedControl<T>`** (same file): connected control —
  container `flex p-[3px] rounded-[11px] bg-foreground/[0.05]`; segments equal-width
  `h-[30px] rounded-lg text-[12.5px] font-semibold`; selected = cream token above; unselected
  `text-muted-foreground`; 1px hairline separators between adjacent unselected segments
  (skip separators adjacent to the selected one). Used for Resolution (video + image quality).
- **TextTabs**: `text-sm font-semibold`, gap-[22px], underline 2px `bg-foreground` (keep
  behavior/testids); inactive `text-foreground/45 hover:text-foreground/80`.
- **GenerationCard**: apply composer-card surface tokens; keep divide-y idiom but with
  `divide-foreground/[0.08]`; add `focus-within:border-foreground/[0.16] transition-colors`.

### A2 · `components/studio/reference-media-uploader.tsx`

- Restyle chips → Palmier thumbs: 106×80 `rounded-xl object-cover`; remove-✕ = 18px circle
  `bg-black/70 text-white/80` top-right INSIDE the thumb (6px inset); @handle tag = bottom-left
  mono `text-[9px]` on `bg-black/65 rounded px-1 py-0.5` (mono tag is the one allowed
  sub-11.5px exception, it's on-image); uploading → thumb at 60% + small spinner; error →
  1px destructive ring + retry title. Empty/add slot: same 106×80 dashed with a 17px ⊞ icon
  (Hugeicons ImageAdd/PlusSign), no text inside.
- **Add `durationSec?: number` to `ReferenceMediaItem`.** For `kind === "video"`, probe it at
  attach time from the local blob URL (`<video preload="metadata">`, loadedmetadata →
  duration) and set it on the item (keep it when upload replaces the URL). Non-blocking,
  best-effort.

### A3 · `components/studio/frame-slot.tsx`

- Label moves OUT (callers render a labels row). FrameSlot renders only the slot:
  keep `label` prop for aria/testids but hide visually (or accept `hideLabel`).
  Slot: `aspect-[16/10] rounded-xl border-[1.5px] border-dashed border-foreground/[0.18]`,
  centered ⊞ icon + `text-[11.5px] text-muted-foreground` "drag, drop, or click"; dragOver →
  `border-foreground/40 bg-foreground/[0.04]`; filled → image `rounded-xl` + 18px ✕ circle
  inside top-right (same as thumbs). Hint prop keeps working.

### A4 · `panels/assets/views/generate.tsx`

- Remove batch bar (see Removals).
- Replace shadcn `TabsList/TabsTrigger` header with the media segmented control (keep
  `Tabs`/`TabsContent` wiring and `section` state): four segments with Hugeicons
  (pick from @hugeicons/core-free-icons, e.g. Video02Icon / Image02Icon / AudioWave01Icon /
  UserMultiple02Icon — verify exact exported names) at 13.5px + labels
  Video / Image / Audio / Personas. Active = filled segment token. Keep any existing testids.
- Error strip: restyle to `text-[11.5px] text-destructive` row with a quiet "Dismiss"
  (`text-muted-foreground hover:text-foreground`), placed directly under the active tab
  content, no red box fill.
- Panel root spacing: sections separated by 16px (`space-y-4`).

### B · `components/studio/generation-form.tsx` (Video tab)

Layout order: mode TextTabs → references/frames section → composer card.
- Mode tabs: labels stay Omni / First–Last (rename label text from "First/Last" to
  "First–Last") / Multiframe; same testids `video-gen-mode-*`.
- References (omni/persona): label row `References` (`text-[13px] font-semibold
  text-foreground/70`) + right hint `type @ to reference` (`text-[11.5px]`); thumbs row from
  uploader. Delete the old "optional · drag, drop, or @mention" copy and the below-prompt
  handles helper paragraph — handle chips now live ON the thumbs; clicking a thumb's tag
  inserts its @handle into the prompt (preserve insert behavior somewhere clickable).
- First–Last: labels row (`First Frame` / `Last Frame · optional` — "· optional" in muted 400)
  above two equal FrameSlots. Multiframe: keyframe slots grid (2 per row, same slot style) +
  dashed "+ Add keyframe" tile; per-mockup styling, logic unchanged.
- Precondition text (`helperText` + first-frame-unsupported warning): neutral
  `text-[11.5px] text-muted-foreground`, positioned between slots and card.
- Composer card rows: (1) prompt, (2) tool row, (3) variations, (4) progress strip when busy,
  (5) bottom bar. Prompt: `min-h-28 text-[14.5px] p-4 pb-1`, placeholder per mode:
  omni "Describe your shot… @ references your attachments.", first–last "Describe the motion
  between your two frames…", multiframe "Describe how the keyframes connect…". Keep mention
  autocomplete anchored under the textarea (restyle menu: `rounded-xl border-foreground/[0.12]
  bg-popover shadow-lg`, rows `text-[12.5px]`).
- **Tool row** (`px-4 pb-3 pt-1 flex items-center gap-2`):
  - Camera chip: rest `Camera` w/ 12.5px camera-motion icon, filled-chip tokens; set state →
    `bg-foreground/[0.14] text-foreground` label = preset name + ✕ to clear. Clicking opens
    `CameraPresetPicker`'s popover — refactor the picker so its trigger is this chip
    (pass trigger as child / render inline); picker content styling: same popover surface,
    keep categories + 2-col grid, selected cell = filled token not blue. Remove
    `border-primary` blue styling.
  - EnhancePromptButton on the right (`ml-auto`), same behavior.
- Variations row: label `Variations` + 4 chips `size-7 rounded-[9px]` filled tokens,
  right-aligned (keep hint text? drop — count is self-evident; submitLabel still says
  "Generate N takes").
- Settings popover content (order): Model chips · Duration (`ChipGrid columns={5}` over the
  backend-filtered `durationChipOptions`, PLUS the Match chip below spanning full width when
  an omni video ref with `durationSec` exists: label `Match @VideoN · {n}s` where
  n = clamp(round(durationSec), backend range); selected state = a local `matchRef: boolean`
  that pins `duration = n` (write through `setSettings({duration:n})` and re-clamp if the ref
  or backend changes; deselect on ref removal)) · Aspect Ratio chips · Resolution
  `SegmentedControl` · Audio chips (when supported).
- Bottom bar: `modelLabel = selectedBackend?.label ?? "Auto"`,
  `settingsSummary = "{res} · {dur}s · {ratio}" + (count>1 ? " · ×N" : "")`.
- **Progress strip** (new, shown while `busy || mfBusy`): NEW module
  `lib/studio/generation-eta.ts` exporting `estimateGenerationSeconds({backendId, resolution,
  durationSec})` — heuristic table: base 22s + 3.5s×durationSec at ≤720p; ×1.75 for 1080p;
  export const so it's tunable. Strip UI: 3px track `bg-foreground/[0.12] rounded-full`,
  fill cream token, width = progress%; progress driver: rAF/250ms interval,
  `p = min(0.92, (elapsed/eta) * 0.9)` eased linear; when the hook's busy flips false →
  set 100%, 300ms transition, fade strip out after 600ms. Line under bar
  (`text-[11.5px] text-muted-foreground tabular-nums`): left `Generating{count>1 ? ` ${count}
  takes` : ""} · {pct}% · ~{remaining}s left`, right link `View in Takes →`
  (`font-semibold text-foreground/80 hover:text-foreground`) that activates the Takes panel —
  find the existing left-rail Takes tab store (grep how the Takes view opens; the takes
  icon is driven by `useTakesNotificationStore`, the panel switch likely via the same
  mechanism as `useAssetsPanelStore.setActiveTab`). If a per-take completion signal isn't
  available from `useStudioGeneration`, aggregate-only is fine.
- Persona active: persona chip row replaces mode tabs (as today) — restyle its container to a
  quiet row (`rounded-xl bg-foreground/[0.04] p-2`), Clear = ✕ chip not underline link.

### C · `components/studio/image-panel.tsx` + `audio-panel.tsx`

Image:
- Preset selector: filled chips (12.5px tokens).
- References: same label row + thumbs (uploader now restyled).
- Card: drop the `Label` ("Prompt/Scene/Character") — placeholder carries it; prompt +
  tool row (Enhance only) + variations (1/4/8/16 chips) + bottom bar
  (`modelLabel = backend label`, `settingsSummary = "{ratio} · {2K|1K}" + (×N)`).
- Popover: Model chips · Aspect chips · Resolution (2K/1K) as `SegmentedControl` ·
  Panels chips (storyboard preset only).
- Progress: reuse the progress-strip UI with REAL fraction `done/total` (no eta needed);
  error text `text-[11.5px] text-destructive`.
- Gallery: `gap-2 rounded-xl` tiles, keep drag/lightbox/Use-as-reference.

Audio:
- Score: "Source video" label row tokens; card = optional prompt + bottom bar
  (`modelLabel = "MMAudio V2"`, `settingsSummary = "{duration}s"`); popover Duration chips;
  progress strip with eta ≈ 45s while polling; "Place on timeline" button → filled-chip row
  (`bg-foreground/[0.14]`), not primary/blue.
- Music: prompt card + "+ Lyrics" as a tool-row chip (toggles the lyrics textarea);
  popover Vocals + Duration chips; bar model "ElevenLabs Music".
- Voiceover redirect: quiet card (`bg-foreground/[0.04] rounded-xl p-3`), copy unchanged,
  button = filled chip tokens (not bg-primary).
- Keep every submit/poll/cancel/testid behavior identical.

## Phasing & git

- Phase A (one agent): A1–A4 on branch `feat/genui-v3-core`. Must compile with EXISTING
  generation-form/image/audio callers — so keep `summary` prop working via a temporary
  back-compat: if `modelLabel` absent, fall back to old rendering (Phase B/C remove usage);
  simplest: make new props optional with old `summary` still accepted. ChipGrid `variant`
  removal: leave the prop accepted-but-ignored in Phase A, delete in Phase C once callers
  are updated. Merge to local main before B/C start.
- Phase B (agent 2): `feat/genui-v3-video` — generation-form.tsx + generation-eta.ts +
  camera picker refactor.
- Phase C (agent 3): `feat/genui-v3-image-audio` — image-panel.tsx, audio-panel.tsx, and
  the final cleanup: remove `summary`/`variant` back-compat from generation-bottom-bar.tsx
  ONLY IF Phase B already merged (coordinate: if generation-form still uses old props, leave
  back-compat and note it).
- Rules for every agent: work only in your worktree; `bun install` there if needed;
  green `bun test` (unit) + typecheck (`bunx tsc --noEmit` in apps/web or the repo's
  check script) before merge; commit only your files (never `git commit -a`; the main
  checkout has other sessions' dirty files, e.g. settings.tsx — do not touch/stash them);
  merge atomically into local `main` with `--no-ff`; NEVER push; if the merge would conflict
  with uncommitted changes in the main checkout, STOP and report instead of forcing.
- Follow repo GitNexus rules: `impact` before editing exported symbols, `detect_changes`
  before committing (UI-leaf blast radius expected: generate.tsx ← generation-form/panels).

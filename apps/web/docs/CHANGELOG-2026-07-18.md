# Byorn — Speedrun Changelog, 2026-07-18

Extends `apps/web/docs/CHANGELOG-2026-07-17.md`. That doc covers `99ab432c..827e36c8`
(283 files · +32,865 / −729, 16 campaigns); this doc covers the delta since, `827e36c8..main`
(21 commits · 20 files · +812 / −64). Combined coverage of the two documents together spans
`origin/main..main` in full — 225 commits at time of writing (`git rev-list --count
origin/main..main`).

> Verification tiers (same rubric as the 07-17 base): **merged** (battery green) ·
> **verified locally** (driven in a real browser on the dev Mac) · **architectural finding**
> (traced, no contained fix). None of the items below claim a tier higher than what their commit
> message or diff supports; where a commit is silent on verification, it is recorded as **merged**.

---

## Timeline & audio

### Record-button docking + auto-track (@371b1392, merged)
- Docks a mic button into the timeline toolbar (next to Audio tools) that starts/stops a
  recording via the existing `useAudioRecording` hook and drops the result on the timeline at
  the playhead, with an inline red-dot + elapsed-time indicator while recording.
  (`components/editor/panels/timeline/record-button.tsx`, `timeline-toolbar.tsx`)
- Fixes `addToTimeline`'s track selection: it previously fell back to *any* track when no audio
  track existed. Now placement mode `"auto"` + `trackType: "audio"` creates a correctly-typed
  track when needed. Shared by the assets-panel Record tab, which is unchanged.
  (`hooks/use-audio-recording.ts`)

### Record-button accessible name (@894906ad, merged)
- The Radix tooltip only wired `aria-describedby`, leaving the icon-only record button with no
  accessible name for screen readers or role-based queries. Adds a dynamic `aria-label` matching
  the tooltip text, consistent with the neighboring `AudioToolsMenu`. Same file as the item above.

---

## AI writing tools

### Enhance-prompt: improve-don't-reduce rewrite contract (@72e8b382 / @aee09100, merged)
Two identical commits (cherry-pick reconciliation across a merge chain — see risk table);
one logical change:
- `buildSystemPrompt` now assesses the draft first (enrich if sparse, tighten if rambling —
  tightening never drops content) and replaces the old hard "~150 words" cap with soft,
  draft-scaled length guidance (~350-word ceiling). Long/detailed drafts were previously getting
  compressed by a cap sized for short drafts.
- `MAX_OUTPUT_TOKENS` 700 → 2048 (Gemini shares this budget with thinking tokens); prompt schema
  cap 2000 → 8000 chars.
- Both provider paths now check for truncation (`finishReason: MAX_TOKENS` /
  `stop_reason: max_tokens`) and return `502 truncated_completion` instead of silently returning
  a partial rewrite.
- `enhance-prompt-button.tsx` surfaces 401/429/other failures via toast instead of failing
  silently; the existing 503 `enhance_not_configured` hide-button behavior is unchanged.
  (`app/api/llm/enhance-prompt/route.ts`, `route.test.ts`, `components/editor/ai/enhance-prompt-button.tsx`)

---

## Studio — identity & reference generation

### Sticky "Keep face & pose" lock, v1 (@20444df8 / @54caccc3, merged)
Two identical commits (same reconciliation pattern as above):
- Adds `withIdentityLock()` (`lib/studio/identity-lock.ts`) to append an identity-preservation
  instruction to the prompt at request-build time when the user attaches a reference image of
  themselves and wants clothes/background/setting to change per-prompt while face and body pose
  stay locked.
- Sticky via a new `imageKeepFacePose` setting in the studio settings store, surfaced as a
  "Keep face & pose" chip in `ImagePanel` next to the reference row (shown only once a ready
  image reference is attached). (`stores/studio-settings-store.ts`, `components/studio/image-panel.tsx`)

### Identity lock v2 — instruction-first framing (@78abd126, merged)
- v1 appended the lock *after* the prompt, so a draft describing a person ("a handsome young
  cowboy…") won the subject fight: pose followed the reference but the face got swapped for a
  generic one. v2 leads with the lock, frames the task as an edit of the attached photo, and
  states that any person the directions mention *is* the reference person in that role; the
  narrow explicit-override for face/expression/pose changes remains.
  (`lib/studio/identity-lock.ts`, `identity-lock.test.ts` — same files as v1, built directly on top)

---

## Board & studio UI

### True-ratio board previews, star icon, storage copy, draggable stills (@85f128c6, merged)
- `reel-board.tsx`: `DraftCard` now measures the loaded image/video's natural aspect ratio
  (clamped 0.5–2, fallback 16:9) instead of forcing `aspect-video`, so portrait generations stop
  getting head-cropped — matches the Assets grid's approach.
- Replaces the amber "Star" text pill with a `StarIcon` button (aria-label + title
  "Star — save to Assets"); same `onStar` behavior.
- Reframes Board copy as storage rather than a review queue (header count, empty state, doc
  comment) — no behavior change.
- `image-panel.tsx`: generated stills in the Image tab now also emit a `StudioTakeDragData`
  payload on drag, which the timeline drop handler and Assets tab already consume, making stills
  draggable straight into the project instead of being dead weight.

---

## Studio — reference asset correctness

### Verified-asset kind: update-on-repaste, explicit type choice (@3cc3bc32, merged)
A BytePlus `asset://` id is opaque (nothing in the id says image vs. video), and the saved
`kind` decides whether the URI is sent to Seedance as `reference_image` or `reference_video`.
Three compounding bugs made a video asset stick as "Verified image" forever:
- the add dialog's type toggle defaulted to `image` and carried over between opens, so a paste
  without touching it saved `kind: image`;
- `upsertSavedAsset` de-duped by URI as a pure no-op, so re-pasting the same URI with the
  correct type silently discarded the correction;
- the quick-pick reads the saved `kind`, so every reuse repeated the mislabel.

Now the toggle starts unselected (add is refused until a type is picked, reset on close), and
re-pasting a known URI updates its `kind` in place — keeping a custom label but regenerating an
auto "Verified image/video" label so it can't contradict the corrected kind.
(`components/studio/reference-media-uploader.tsx`, `lib/studio/saved-verified-assets.ts`, `.test.ts`)

---

## Library / assets

### Per-asset Download in the library context menu (@54a408dc / @b8e354a2, merged)
Two identical commits (same reconciliation pattern as above):
- Right-click any asset → Download saves its ORIGINAL bytes (the in-memory source `File` — no
  re-encode, no server round-trip, proxies ignored) via an object-URL anchor click. Replaces the
  dead no-handler "Export clips" menu item.
- Filenames keep the asset's display name and borrow an extension from the source file name or
  MIME type when the display name has none (generated takes are named like "Take 3").
  (`editor/panels/assets/views/assets.tsx`, `lib/media-download.ts`, `.test.ts`)

---

## Docs & process

### 07-17 speedrun changelog (@dc18c9ab, merged)
- Added `apps/web/docs/CHANGELOG-2026-07-17.md` itself — the base document this file extends.

### Queue v4 hardening-first kickoff (@6b4a1de2, merged)
- Updates `apps/web/docs/SPEEDRUN-QUEUE.md` (G2 local-only framing, user-dogfood rows for
  BUG32b/34/35/F9) and adds `apps/web/docs/feature-ideas.md`.

---

## Per-merge risk audit

Range `827e36c8..main`. "Files" counts the commit's own diff (duplicate-content commits listed
once). Risk weights money/auth/schema/export-path changes higher; everything in this range is
UI, prompt-construction, or docs — no schema migrations, no payment/credit paths, no auth
boundaries touched.

| Item | Files touched (hot areas) | Risk | Verification | Rollback note |
|---|---|---|---|---|
| Record-button dock + auto-track (@371b1392) | 3 — timeline toolbar, new record-button component, audio-recording hook | LOW | merged | Revertable in isolation; @894906ad below builds on the same `record-button.tsx` |
| Record-button aria-label (@894906ad) | 1 — `record-button.tsx` (shared with @371b1392) | LOW | merged | Depends on @371b1392's file existing; trivial to re-apply or drop independently |
| Enhance-prompt improve-don't-reduce contract (@72e8b382/@aee09100) | 3 — LLM route, route test, button component | MED — raises `MAX_OUTPUT_TOKENS` (cost-adjacent) and changes provider error/truncation handling on a paid-model path | merged | Revertable in isolation; no shared files with other items in range |
| Sticky "Keep face & pose" lock v1 (@20444df8/@54caccc3) | 4 — `identity-lock.ts` (new), test, settings store, `image-panel.tsx` | LOW — client-side prompt construction only, no billing/schema | merged | Entangled with @78abd126 (v2 edits the same `identity-lock.ts`); revert as a pair. Shares `image-panel.tsx` with @85f128c6 (different hunks) |
| Identity lock v2 instruction-first framing (@78abd126) | 2 — `identity-lock.ts`, test (same files as v1) | LOW | merged | Built directly on v1; revert together, not standalone |
| Board true-ratio previews / star icon / storage copy / draggable stills (@85f128c6) | 2 — `reel-board.tsx`, `image-panel.tsx` | LOW — presentation/UX only | merged | Revertable in isolation for `reel-board.tsx` hunks; `image-panel.tsx` hunk (drag payload) sits alongside the sticky-lock chip in the same file — isolate by hunk if reverting only one |
| Verified-asset kind update-on-repaste (@3cc3bc32) | 3 — reference-media-uploader, saved-verified-assets, test | MED — wrong `kind` routes a reference to the wrong Seedance field (`reference_image` vs `reference_video`), which can waste a paid generation call | merged | Revertable in isolation; no shared files with other items in range |
| Per-asset Download in library context menu (@54a408dc/@b8e354a2) | 3 — assets view, media-download lib, test | LOW — client-only blob download, no network/server round-trip | merged | Revertable in isolation; no shared files with other items in range |
| 07-17 changelog doc (@dc18c9ab) | 1 — `CHANGELOG-2026-07-17.md` | LOW — docs only | merged | Revertable in isolation |
| Queue v4 kickoff docs (@6b4a1de2) | 2 — `SPEEDRUN-QUEUE.md`, `feature-ideas.md` | LOW — docs only | merged | Revertable in isolation |

**07-17 base (prior coverage, not re-audited here):** 16 campaigns merged, combined battery green
at each step; C7 wave-3 regression hunt found zero golden-path regressions across the whole
`99ab432c..827e36c8` integration (real exports ffprobed). See
`apps/web/docs/CHANGELOG-2026-07-17.md` for the full campaign-by-campaign breakdown and its own
known-follow-ups list.

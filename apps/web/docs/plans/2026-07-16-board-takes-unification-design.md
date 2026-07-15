# Board/Takes unification — design

Date: 2026-07-16

## Problem

Two disconnected systems exist today:

- **Single-shot generation** (Generate panel, Image panel) creates DB rows
  (`generationSets`/`takes` for video, `imageStills` for images) and either
  requires a manual "star" to save to Assets (video, via the flat "Takes" tab)
  or auto-saves unconditionally regardless of count (images) — the exact
  complaint that started this: "when I AI generate an image it goes straight
  to assets anyways."
- **Reel Board** (`reel-board.tsx`, toggled from the editor header) only
  scans the *timeline* for elements carrying `.generation`/`.takes` metadata,
  which only the Director's batch/storyboard flow writes. It's disconnected
  from the single-shot flow the user actually uses, hence "I'm not sure what
  board does — it never initializes."
- A third table, `boardItems` (`/api/studio/board`), already implements
  "pin a take or image still" with a working GET/POST/DELETE API, but nothing
  reads it back — dead code.

Director's per-slot take picking has its own dedicated dialog (`TakeReview`,
`take-review.tsx`) which is unaffected by anything here.

## Goals

- One generation from a click → lands straight in Assets, no extra step.
- 2+ generations from one click → held as drafts; Board is where you review
  and star winners into Assets.
- Reuse `boardItems` (already built, currently unused) as the "pending
  drafts" store instead of adding new schema.
- Kill the flat, permanent "Takes" tab.

## Non-goals

- No changes to Director/storyboard batch generation's timeline-embedded
  takes, or to `TakeReview`.
- No batchId/grouping schema — the requesting client already knows the
  count before firing, so the auto-route decision is made client-side at
  generate time, not reconstructed from stored data.
- `takes.starred` is not migrated away; it becomes unused but harmless.

## Data flow changes

### Video (`generation-form.tsx` / `use-studio-generation.ts`)

- `count` is already known before the generate loop fires.
- `count === 1`: on completion, auto-save the take to Assets (reuse the same
  `addItemsToProjectMedia` call `starred-takes.tsx` uses today) — no manual
  star step.
- `count > 1`: on each take's completion, POST it to `/api/studio/board`
  (`kind: "take"`, `takeId`) instead of touching Assets. After the whole
  batch settles, fire one toast (see below).
- Remove the manual "pin to board" action (`pinToBoard`) — pinning is now
  automatic, not a user gesture.

### Images (`image-panel.tsx`)

- `total` (`preset.allowsMultiple ? n : 1`) is already computed before the
  fan-out.
- `total === 1`: keep current behavior — `importStillsToAssets` runs as
  today.
- `total > 1`: instead of `importStillsToAssets`, POST each still to
  `/api/studio/board` (`kind: "image"`, `imageStillId`) as it arrives. One
  toast after the batch settles.

### Toast copy

- 1 result: quiet — no toast, or a subtle "Added to Assets."
- 2+ results: `"N takes ready — pick your favorite"` with an "Open Board"
  action button that calls `useBoardStore.getState().setOpen(true)`.

## Board rewrite (`reel-board.tsx`)

- Replace the timeline-scanning `slots` logic with `GET /api/studio/board`.
- Render pending drafts as a grid: video takes autoplay muted-loop (same
  visual language as today's `BoardTake`), images as `<img>`.
- Star a draft → promote to Assets (same underlying save call as the
  count===1 path) and DELETE it from `boardItems`.
- Small "×" → DELETE from `boardItems` without saving (dismiss).
- Leftover siblings from the same batch stay in Board until individually
  starred or dismissed — no auto-clear-on-first-star.
- Empty state: "Nothing pending — batches of 2+ generations land here for
  you to pick a winner."
- Promote-to-1080p stays available as a per-draft action inside the new grid
  (relocated from the old `TakeCard`).

## Removing the Takes tab

- Delete `starred-takes.tsx` and its entry in the Assets panel tab list.
- Delete the `takes-notification-store.ts` star-glow wiring and the
  "View in Takes" toast in `generate.tsx` (replaced by the batch-aware toast
  above).
- Reuse or trim `take-card.tsx` as needed for the new Board grid (drop
  `onPin`/toggle-star props that no longer apply; keep promote/dismiss).

## Edge cases

- Partial batch failures: failed takes/stills still show (as an error-state
  card) in Board rather than vanishing silently; they don't count toward the
  "N ready" toast wording.
- Undo: no more un-star toggle. Removing an accidentally-promoted asset is a
  normal Assets delete, not a special action.

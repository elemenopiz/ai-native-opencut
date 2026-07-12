# Frame extraction + chaining — design

_2026-07-12 · branch `feat/frame-extraction-chaining`_

Users of AI video tools chain shots by feeding the **last frame of clip N** as the
**first frame of clip N+1** so consecutive generations mesh. Byorn already had the
decode machinery (`lib/media/last-frame.ts`, used internally by the Director's
remix / vision review). This feature adds the user-facing UI, provenance marking,
and Director verbs on top of it.

## The five pieces

### 1. Full-resolution frame extraction

`generateThumbnails` / `generateThumbnail` (`lib/media/processing.ts`) gained an
optional `fullResolution?: boolean`. When set, the decode **skips the 1280×720
thumbnail clamp** and emits **lossless PNG** instead of JPEG 0.8. Default is
`false`, so every existing thumbnail caller is byte-for-byte unchanged (verified:
the whole `impact` upstream set of `generateThumbnails` never passes the new flag).

New primitives in `lib/media/last-frame.ts`:

- `extractFrameFull(source, timeSec) → { dataUrl, width, height } | undefined` —
  decode ONE frame at an arbitrary source time at native resolution.
- `extractTakeFrameFull(asset, timeSec, name?)` — convenience over a resolved
  media asset (prefers in-memory `file`, falls back to proxied `url`).

### 2. "Extract frame" context menus (the only user surfaces)

**Timeline clip** (`timeline-element.tsx`) — video elements, single selection, with
resolved media. A `ContextMenuSub` "Extract frame" with:

- **First frame** — source time `trimStart`.
- **Last frame** — source time `trimStart + duration − LAST_FRAME_EPSILON_S`.
- **Frame at playhead** — shown/enabled only while the playhead is over the
  element; source time `trimStart + (playhead − startTime)`.

**Library asset** (`assets.tsx` `MediaItemWithContextMenu`) — video assets get
"Extract first frame" / "Extract last frame" over the full (untrimmed) source.

Both decode full-res → `dataUrlToFile` → `editor.media.addMediaAsset` as an
`image` asset with width/height. A loading toast covers the decode; success/error
toasts follow.

### 3. Provenance

`DerivedFrom { assetId, sourceTimeSec, label }` on `MediaAssetData`
(`services/storage/types.ts`), surfaced on `MediaAsset` via the existing
`extends`. `label ∈ { "first frame" | "last frame" | "frame" }`.

- **Name**: `«source» — first frame` / `— last frame` / `— frame @ 4.2s`
  (`frameAssetName`, extension stripped).
- **Visible**: an **edge pill** on the tile (`FrameEdgePill`) whose side mirrors
  the frame's position in the clip — first→bottom-left, last/frame→bottom-right —
  in the `MediaDurationBadge` chrome (they never collide: extracted frames are
  images, the duration badge is video-only). Under the name, a muted
  `↳ from «source»` line (`MediaProvenanceRow`) reveals + flash-highlights the
  SOURCE asset on click. List view shows the compact inline equivalent.

**Persistence** (no zod schema here — IndexedDB stores plain objects via explicit
field copies): `derivedFrom` is threaded through both `saveMediaAsset` and
`loadMediaAsset` in `services/storage/service.ts`. It's optional, so **old projects
load unchanged** (the field is simply absent). No migration is required —
`migrations/` only run for structural changes, and adding an optional metadata
field is backward/forward compatible. Storage suite stays green (66/66).

### 4. Chaining toast + store seam

`stores/frame-chain-store.ts` — a tiny zustand channel: `pendingFirstFrame
{ url, label }` + a monotonic `nonce`. The success toast for a frame gets:

- **Primary action** — "Use as next first frame" (first-frame extracts read
  "Use in Generate"): upload the still via `uploadReferenceFile` → R2, then
  `setPendingFirstFrame({ url })`.
- **Secondary** (`cancel` button) — "Reveal": `requestRevealMedia(mediaId)`
  (flip to Media tab + flash-highlight). Extraction itself never auto-switches a
  tab — the toast is the navigation hub.

`RightPanel` watches `nonce` and switches to its Generate tab. `GenerationForm`
consumes `pendingFirstFrame`: sets `firstFrameUrl`, and flips genMode to
`first-last` **only when the selected backend supports it** (`availableModes`,
derived from `supportsLastFrame`); otherwise it still stows the URL and lets the
existing capability-coercion effect surface it.

### 5. Director verbs

- **`extractFrame`** `{ slotId | mediaId, position: "first" | "last" | seconds }`
  — decodes full-res from the slot's active take (or a library asset), adds it to
  the library with piece-3 provenance, returns `{ mediaId, url }` where `url` is a
  hosted (R2), generation-usable image URL. Mutating → `reel:write`.
- **`chainFrom`** `{ fromSlotId, toSlotId }` — the cross-slot seam (see below).

Both are registered in the shared `toolCatalog()`, so they flow automatically into
`agent.ts`'s `TOOLS`/`TOOL_DOCS`/`anthropicToolDefs` and the MCP server. Browser-
bound decode + upload are injected via a new `options.frames?.{ decode, upload }`
seam (mirroring `references`), so the verb handlers unit-test headless.

## Trim → source-time math

Canonical convention (`lib/timeline/audio-sync-utils.ts`): an element shows SOURCE
range `[trimStart, trimStart + duration]` at TIMELINE `[startTime, startTime +
duration]`, where `duration` is the **visible** duration.

| Frame | Source time |
|-------|-------------|
| First (visible) | `trimStart` |
| Last (visible) | `trimStart + duration − LAST_FRAME_EPSILON_S` (never < first) |
| Playhead | `trimStart + (playheadTime − startTime)`, clamped to `[trimStart, trimStart + duration]` |

`playbackRate` / `reversed` are intentionally **not** modeled — the canonical
source↔timeline mapping ignores them too, and modeling them would diverge from the
rest of the codebase for a marginal case. Library extraction uses a full-span
synthetic element (`{ startTime: 0, duration: asset.duration, trimStart: 0 }`).

## Provenance is pinned to the SOURCE, not the cut

Extraction reads the timeline clip's **current** trim to pick a moment, but the
stored `derivedFrom` references the **source asset id + absolute source
timestamp** — never the timeline element. If the user later re-trims the clip, the
frame stays a truthful snapshot of that source instant, and frames from different
cuts of the same source coexist unambiguously. The name carries the timestamp for
generic-frame (playhead) extracts.

## Chaining seam choice

**Chosen: a dedicated `chainFrom({ fromSlotId, toSlotId })` verb** that stamps the
target slot's `generation` spec with the source slot's last frame as
`referenceImageUrl` + `mode: "image-to-video"`, then stops (the caller runs
`generate`/`reroll`).

Why this over an optional `firstFrame` input on `generate`/`reroll`:

- It reuses the **exact** re-conditioning shape `remix` already uses
  (`buildRemixSpec` sets `mode: "image-to-video"` + `referenceImageUrl`), so no
  new capability surface — base image-to-video is supported by every i2v-capable
  backend (unlike flf2v, which needs `supportsLastFrame`). Only fields a normal
  i2v generation uses are set.
- It leaves the generate pipeline untouched (no redesign), and composes cleanly:
  `chainFrom` internally calls `extractFrame`, so the seed frame also lands in the
  library with provenance.
- Splitting extract (adds a real asset) from generate keeps each verb single-
  purpose and lets the agent inspect/reuse the extracted frame.

## Files

- `lib/media/processing.ts` — `fullResolution` decode option.
- `lib/media/last-frame.ts` — `extractFrameFull` / `extractTakeFrameFull` + `FullFrame`.
- `lib/media/data-url.ts` (new) — `dataUrlToBlob` / `dataUrlToFile`.
- `lib/media/frame-extraction.ts` (new) — source-time math, naming, provenance,
  `extractAndAddFrame`.
- `stores/frame-chain-store.ts` (new) — chaining channel.
- `services/storage/types.ts` — `DerivedFrom` + `MediaAssetData.derivedFrom`.
- `services/storage/service.ts` — persist/restore `derivedFrom`.
- `components/editor/panels/timeline/timeline-element.tsx` — clip submenu.
- `components/editor/panels/assets/views/assets.tsx` — library menu, edge pill,
  provenance row.
- `components/editor/panels/right-panel.tsx` — tab switch on chain.
- `components/studio/generation-form.tsx` — consume pending first frame.
- `lib/director/tool-catalog.ts` — `extractFrame` / `chainFrom` verbs.
- `lib/director/director-api.ts` — verb impls + `frames` seam.
- Tests: `lib/media/frame-extraction.test.ts`, `lib/media/data-url.test.ts`,
  `lib/director/director-frame-extraction.test.ts`.

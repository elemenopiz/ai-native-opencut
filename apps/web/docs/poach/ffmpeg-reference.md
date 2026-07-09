# ffmpeg reference: sixsevenstudio → OpenCut/Byorn

Adapted from `palmier-io/sixsevenstudio` (MIT), Copyright (c) 2025 Palmier.
Source: Tauri/Rust desktop app that shells out to a real `ffmpeg` binary for
video export. This doc records what their ffmpeg math does, and maps it
against our web render pipeline to decide what (if anything) was worth
porting.

**Outcome: nothing was ported. All four features are DOCUMENT-only.** Our
render/export stack (WebCodecs via `mediabunny` + WebGL canvas compositing +
Web Audio API sample mixing) already covers the same product surface with a
different, non-ffmpeg architecture, and in three of the four cases the
underlying *data model* is different enough that a literal port of their
formulas would be actively wrong if wired up. No `.ts` files were created by
this pass.

## Mapping table

| Their Rust fn (`ffmpeg/*.rs`) | What it does | Our equivalent | Verdict |
|---|---|---|---|
| `filters.rs::build_transition_filter`, `calculate_transition_offset`, `calculate_cumulative_offset` | Builds an `xfade` filter\_complex offset per cut, assuming clips are trimmed and concatenated with the timeline **shrinking** by `transition_duration` at each cut | `apps/web/src/services/renderer/nodes/transition-node.ts` + `transition-renderer.ts` (WebGL shader cross-blend, driven by `scene-builder.ts`'s `cutTime = current.startTime + current.duration`) | DOCUMENT — different data model, see below |
| `filters.rs::calculate_total_duration`, `calculate_audio_padding`, `build_audio_sync_filters` (atrim→adelay→apad→amix) | Per-track trim/delay/pad so N audio tracks can be `amix`ed into one file that matches the shrunk timeline | `apps/web/src/lib/media/audio.ts::createTimelineAudioBuffer` / `mixAudioChannels` — sample-accurate mixdown into one `AudioBuffer` via absolute `startTime`, no shrink, no re-encode | DOCUMENT — already solved, more precisely |
| `concat.rs::concatenate_fast` (codec copy) vs `concatenate_with_transitions` (re-encode) | Dual path: cheap stream-copy concat when there are no transitions, full re-encode through `filter_complex` when there are | `apps/web/src/services/renderer/scene-exporter.ts` — always renders every frame through `CanvasRenderer` and muxes via `mediabunny`'s `CanvasSource`/`Output`; there is no concat step at all, with or without transitions | N/A / DOCUMENT — the fast/slow fork doesn't exist as a concept in our pipeline |
| `sprite.rs::generate_sprite_image` (fps from `min_frame_width`, `scale`+`tile` into one sprite PNG) | Computes fps/frame-count so a horizontal sprite sheet has readable frames, then asks ffmpeg to render it | `apps/web/src/hooks/use-filmstrip.ts::generateFilmstrip` — seeks an HTML `<video>` to `numFrames` evenly spaced timestamps and captures each to its own canvas/dataURL (no sprite sheet, no ffmpeg) | DOCUMENT — same product goal (scrub thumbnails), different mechanism, already shipped |
| `waveform.rs::generate_waveform_image` (`showwavespic`) | Renders one static waveform PNG via ffmpeg filter | `apps/web/src/components/editor/panels/timeline/audio-waveform.tsx` (`wavesurfer.js` + Web Audio `decodeAudioData`/peak extraction) | DOCUMENT — client-side peak rendering already covers this, no image asset needed |

## Why the transition/audio math wasn't ported (not just "duplicate", actually incompatible)

Their formulas assume a **sequential trim-and-concat timeline**: each clip is
physically shortened by `transition_duration` before being spliced to the
next, so the *exported* video is shorter than the sum of clip durations:

```
total_duration = Σ(i=0..n-2)(clip_i.duration - transition_i.duration) + clip_{n-1}.duration
offset_i       = cumulative_offset_i + clip_i.duration - transition_i.duration
```

`xfade` needs `offset_i` because ffmpeg has no notion of an absolute
timeline position — it only sees a linear stream, so the offset has to be
reconstructed by walking every prior clip and subtracting overlaps. Same
story for audio: each track is `atrim`'d (drop the overlapped tail),
`adelay`'d (shift right by `cumulative_offset`), `apad`'d (stretch to
`total_duration`), then `amix`'d, because ffmpeg's audio filter graph also
has no absolute-position concept.

Our timeline elements (`apps/web/src/types/timeline.ts` `VisualElement`)
already carry an **absolute `startTime`** in the project's data model, and
nothing shortens on cut. Confirmed in
`apps/web/src/services/renderer/scene-builder.ts`:

```ts
cutTime: current.startTime + current.duration
```

`current` and `next` keep their full, un-shrunk durations; the transition is
a purely visual cross-blend rendered in a `±transitionDuration/2` window
around `cutTime` (`transition-node.ts`), not a change to how long anything
plays. `getElementLocalTime` (`apps/web/src/lib/animation/resolve.ts`)
clamps local time to `0` before an element's own `startTime`, i.e. the
transition window is a frame-hold cross-blend at the boundary, not an
overlap of two streams that both need extra footage. Likewise
`createTimelineAudioBuffer` mixes every track directly into one `AudioBuffer`
by absolute sample offset (`outputStartSample = Math.floor(startTime *
sampleRate)`); nothing is shrunk, delayed-in-a-filter-graph, or padded to
match a re-derived total duration.

Net effect: `total_duration`, `calculate_cumulative_offset`,
`calculate_transition_offset`, and `calculate_audio_padding` all solve for a
timeline-shrinkage model we don't have. Porting them as "pure TS math" would
produce functions with no correct call site — plugging our actual
`startTime`/`duration` values into them would compute offsets for a shrunk
timeline that never happens in our editor, i.e. genuinely dead (and
misleading) code, not a reusable utility.

`concat.rs`'s copy-vs-reencode fork doesn't apply either: our export path
(`scene-exporter.ts`) always renders every frame procedurally through
`CanvasRenderer` (WebGL transitions included) and encodes via WebCodecs
(`mediabunny`'s `CanvasSource`/`AudioBufferSource` → `Output`). There's no
"can we just stream-copy the source files" fast path to have a slow path
fork against — every export re-renders, always.

## Sprite and waveform: already-shipped equivalents, not gaps

- **Sprite** (`use-filmstrip.ts`): their fps formula
  (`fps = clamp(max_frames / duration, 0.5, 10)`, `max_frames =
  width / min_frame_width`) exists to keep ffmpeg's `tile` output readable.
  We don't tile at all — `generateFilmstrip` seeks a `<video>` element to
  `numFrames` timestamps (`numFrames = clamp(ceil(visibleWidth /
  thumbWidth), 1, 20)`) and draws each seek to its own canvas, caching the
  resulting dataURLs per media asset. Conceptually the same "how many
  thumbnails fit legibly" heuristic, already implemented, no ffmpeg
  dependency, no sprite-sheet image asset to manage.
- **Waveform** (`audio-waveform.tsx`): `showwavespic` renders a static PNG.
  We decode the real `AudioBuffer` client-side and extract per-bucket peaks
  (`extractPeaks`) for `wavesurfer.js` to draw as a scalable, live SVG/canvas
  waveform — strictly more capable (resizes, re-themes, no image asset,
  works before any file is written to disk).

## Dependency note

`apps/web/package.json` lists `@ffmpeg/ffmpeg`, `@ffmpeg/core`, and
`@ffmpeg/util` (ffmpeg.wasm), but a repo-wide search found **zero imports**
of any of them anywhere in `apps/web/src`. It's a vestigial/unused
dependency, not evidence of an existing ffmpeg-based path. If a future
"batch/server-side export" phase actually shells out to ffmpeg (either via
this wasm build or a server binary), *that* would be the point to revisit
`filters.rs`'s formulas for real — at that point the shrinking-timeline
model would legitimately apply, since a from-scratch ffmpeg concat pipeline
would be built around it. Nothing to wire today.

## What a wiring pass must connect

Nothing — no code was created in this pass because none of the four
features had an additive gap. If a server-side/ffmpeg export path is built
later, revisit this doc first; the formulas above are still valid ffmpeg
math and can be transcribed then, scoped to whatever new pipeline actually
needs a linear-stream offset model.

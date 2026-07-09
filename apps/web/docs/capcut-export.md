# CapCut / JianYing draft export

"Export as CapCut draft" (in the editor's Export popover) packages the
current timeline as an editable CapCut / JianYing (剪映) draft so creators
can finish a cut in CapCut instead of re-assembling it from a flat MP4.

## What you get

A zip containing one draft folder:

```
<Project Name>/
  draft_content.json    # the timeline: materials + tracks of segments
  draft_meta_info.json  # draft metadata + imported-media index
  Resources/            # every media file the draft references
  media_manifest.json   # file list + all export warnings
  README.txt            # install instructions for the user
```

Install: unzip and move the folder into the CapCut drafts directory, then
restart CapCut.

- Windows: `%LOCALAPPDATA%/CapCut/User Data/Projects/com.lveditor.draft`
- macOS: `~/Movies/CapCut/User Data/Projects/com.lveditor.draft`
- JianYing uses `JianyingPro` instead of `CapCut` in those paths.

## Schema target

The plain-JSON draft format written by JianYing desktop 5.9 (draft
`version` 360000, `new_version` "110.0.0"), which CapCut desktop builds
with unencrypted drafts also read. JianYing 6.0+ encrypts drafts on save
but still imports older plain-JSON drafts. The field-level reference is
the openly documented format used by OSS draft tooling (pyJianYingDraft,
Apache-2.0). No AGPL code was referenced.

Times are integer microseconds. Each segment has a `target_timerange`
(position on the track) and `source_timerange` (slice of the source
media, scaled by playback speed).

## Mapping

| Byorn | CapCut draft |
| --- | --- |
| scene tracks (current scene) | `tracks[]`, ordered bottom-to-top: main video track, overlay video tracks, audio, text. `render_index` = track order |
| video element | `materials.videos` (`type: "video"`) + segment on a `video` track |
| image element | `materials.videos` (`type: "photo"`, 3h virtual duration) + segment |
| audio element (upload or library) | `materials.audios` (`type: "extract_music"`) + segment on an `audio` track |
| text element | `materials.texts` (JSON-in-JSON `content` payload) + segment on a `text` track |
| `startTime` / `duration` | `target_timerange` (µs) |
| `trimStart` / `playbackRate` | `source_timerange.start` / segment `speed`; source duration = timeline duration x rate |
| transform position (px, canvas-centered, y-down) | `clip.transform` in half-canvas units, y-up (x = px / (width/2), y = -px / (height/2)) |
| transform scale | `clip.scale.x/y` (both engines treat 1.0 as fit-to-canvas; approximate) |
| transform rotate (deg, clockwise) | `clip.rotation` (same convention) |
| opacity | `clip.alpha` |
| element/track mute, audio volume | segment `volume`, track `attribute` |
| linear number keyframes on position / scale / rotate / opacity / volume | `common_keyframes` with `KFTypePositionX/Y`, `KFTypeScaleX`, `KFTypeRotation`, `KFTypeAlpha`, `KFTypeVolume` |
| text size / color / bold / italic / underline / align | text material `content` styles + `alignment` (font size units are canvas-relative in both apps, default 15; approximate) |
| text background enabled | `background_*` fields (style, color) |

Media files are written to `Resources/` and referenced by draft-relative
paths. If a CapCut build insists on absolute paths it shows the standard
"media missing" state; relinking to the adjacent `Resources/` folder
restores every clip (positions/durations are unaffected).

## Degraded or skipped (warned, never fatal)

- Effect elements/tracks, per-element effects, filters — CapCut effects
  are proprietary library resources with no stable public IDs.
- Transitions (`transitionOut`) — same reason; adjacent clips stay butt
  cut.
- Stickers — Byorn stickers are Iconify vectors with no local media file.
- Masks, crops, blend modes.
- Karaoke word timings / word pop on text.
- Non-linear features of keyframes: "hold" interpolation exports as
  linear; color / background / playbackRate channels are dropped.
- Fonts: CapCut font resources cannot be referenced generically; text
  falls back to CapCut's default font.
- Generative placeholder clips without resolved media (and any element
  whose media asset is missing) are skipped with a warning.
- Multi-scene projects export the current scene only.

Every degradation is listed in `media_manifest.json` inside the zip and
summarized in a toast after export.

## Code

- `src/lib/export/capcut-draft.ts` — pure serializer (unit tested in
  `src/lib/export/__tests__/capcut-draft.test.ts`).
- `src/lib/export/capcut-zip.ts` — minimal store-only zip writer.
- `src/lib/export/capcut-export.ts` — browser glue: bundles media + JSON
  into the zip and triggers the download.
- UI entry point: `src/components/editor/export-button.tsx`.

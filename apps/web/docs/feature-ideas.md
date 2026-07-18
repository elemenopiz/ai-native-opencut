# Feature Ideas — Bring to Life

Running list of feature ideas to build. Not prioritized or scoped — just capturing them as they come up.

- **Asset folders** — let users organize uploaded assets into folders in the Assets panel. Support uploading a whole folder of files at once (preserving structure), plus creating folders manually to organize existing assets.
- **Square audio previews** — make audio asset previews/thumbnails in the Assets panel square, matching the shape used for other asset types.
- **Audio delete/undo + recording discard redesign** — deleting an audio asset from Assets removes it from the timeline, but undo (Ctrl+Z) doesn't restore the actual audio. Needs a broader redesign of the audio recording/asset lifecycle — including giving the recording flow a way to discard a take, since right now you're forced to save it.
- **Audio volume not respected on export** — changing a clip's audio volume level has no effect on the exported video; export doesn't apply the volume setting.
- **Stale waveform preview after split + delete** — when you split an audio clip and delete part of it, the waveform preview drawn on the remaining timeline clip doesn't look like it's regenerated/re-sliced correctly anymore.
- **Shrink audio preview squares** — make the square audio previews in the Assets panel about 1/4 of their current size.
- **Folder tile layout broken in Assets grid** — adding a folder messes up the grid layout: the new folder card renders narrower/cut off and overlapping the neighboring asset tile instead of sizing like a normal grid item (see screenshot in conversation — "New folder" tile is squished next to the "Audio" tile).
- **Scrollable asset filter tabs row** — the All/Videos/Images/Audio filter tab bar in the Assets panel should be horizontally scrollable on its own (independent of the asset grid below it), so it doesn't need to wrap or get cut off when there are more categories/tabs than fit.
- **Board grid layout has weird gaps** — the Board view uses a fixed-row grid, so rows with mixed aspect-ratio images (portrait next to landscape) leave large empty gaps under the shorter tiles. Should use the same Pinterest-style masonry layout as the Assets panel instead.
- **Excess spacing in Text presets list** — the Text panel's preset cards (Heading, Subheading, Body Text, Caption, Bold Impact, Outlined, etc.) have an oddly large gap between rows that should be tightened up.
- **Dismiss button on post-transcribe Quick actions popup** — the "Quick actions" bar (Smart cut / fillers / Find silences / Remove subtitles / Popover subs) that appears after transcribing has no way to close it — add an X button to dismiss it.
- **Transcribe entire video, not just one audio track** — transcription currently only runs on a single audio track; add an option to transcribe the whole video (all audio in the timeline) at once.
- **More distinct transition preview icons** — the Transitions panel icons (Cross Dissolve, Dissolve with..., Fade Grayscale, Color Phase, Perlin Dissolve, Linear Blur, Dip to Black, Fade Through..., etc.) all look nearly identical (generic half-circle/square). Make each icon actually reflect what that specific transition looks like, e.g. a small animated/representative preview instead of a generic shape.
- **Control transition speed/duration after applying** — once a transition is applied to a clip, give the user a way to adjust its speed/duration (not just pick which transition to use).
- **More specific Credit history entries** — every credit deduction just shows as generic "Generation" with a timestamp and cost. Make each entry reflect what was actually generated (small thumbnail/preview for image or video generations, or a distinct icon/label for AI Director, voiceover, etc.) so users can tell where their credits went, without making each row too heavy.

---

## Sprint status — 2026-07-19 (all 15 items resolved; local `main` only, not pushed)

Cleared in one parallel Sonnet fan-out. "Pre-sprint" = already shipped before this
sprint (reconciled, not rebuilt). "This sprint" = built + reviewed + merged below.

| # | Item | Status | Merge |
|---|------|--------|-------|
| 1 | Asset folders (create/upload/organize) | ✅ pre-sprint (F9/C33) | `8784e984` |
| 2 | Square audio previews | ✅ pre-sprint (BUG35) | `8d8128cb` |
| 3 | Audio delete/undo + recording discard | ✅ pre-sprint (BUG34 + discard) | `325a08dd` |
| 4 | Audio volume not respected on export | ✅ pre-sprint (BUG32/C24) | `5f7a8e00` |
| 5 | Stale waveform after split+delete | ✅ this sprint — Part 8 (windows peaks to trim range; also fixes trim-drag) | `c6b129b8` |
| 6 | Shrink audio preview squares (~¼) | ✅ this sprint — Part 2 (audio pinned to 1 col) | `8de0718e` |
| 7 | Folder tile layout broken in grid | ✅ this sprint — Part 1 (`size-28`→`w-full`) | `8de0718e` |
| 8 | Scrollable asset filter tabs row | ✅ this sprint — Part 3 (`overflow-x-auto`) | `8de0718e` |
| 9 | Board grid weird gaps → masonry | ✅ this sprint — Part 4 (Assets-grid masonry technique) | `2ddb7304` |
| 10 | Excess spacing in Text presets | ✅ this sprint — Part 5 (`containerClassName=w-full`) | `596157ed` |
| 11 | Dismiss button on Quick actions bar | ✅ this sprint — Part 9 | `e1f7d38c` |
| 12 | Transcribe entire video (all tracks) | ✅ this sprint — Part 9 (whole-video toggle) | `e1f7d38c` |
| 13 | More distinct transition icons | ✅ this sprint — Part 10 (68 per-type previews) | `f0f409da` |
| 14 | Control transition speed/duration | ✅ this sprint — Part 10 (Applied-Transition slider) | `f0f409da` |
| 15 | More specific Credit history entries | ✅ this sprint — Part 11 (icon+label from ledger metadata) | `76f806c2` |

Follow-up logged (not built this sprint, per packet Non-goals): the deeper audio
recording/asset-lifecycle *redesign* behind item 3 — the two concrete asks (undo
restores audio; recording discard) shipped; a full lifecycle redesign remains open
if still wanted.

# Third-Party Notices

This project incorporates code, prompts, and patterns adapted from third-party
open-source projects. Each entry lists the source, its license, and which files
in this repo were adapted from it. Adapted source files carry a header:
`// Adapted from <project> (<license>). See THIRD_PARTY_NOTICES.`

---

## palmier-io/sixsevenstudio — MIT

Copyright (c) 2025 Palmier. Source: https://github.com/palmier-io/sixsevenstudio

```
MIT License

Copyright (c) 2025 Palmier

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

Files adapted from this project:

- `apps/web/src/stores/generation-status-store.ts` — from
  `src/stores/useVideoStatusStore.ts`: statusMap-keyed-by-id zustand store with
  dedup'd interval polling and auto-stop on terminal status. Ported to our
  `pending|processing|completed|failed` enum (`PollVideoResult` in
  `lib/studio/provider-adapter.ts`); poll function is caller-injected rather
  than hardcoded to OpenAI's `videos.retrieve`.
- `apps/web/src/hooks/use-generation-polling.ts` — from
  `src/hooks/use-video-polling.ts`: React hook composing the status store with a
  per-job import step. Stripped of all Tauri/local-filesystem logic; media is
  rehosted to R2 and the import step is a caller-injected `onCompleted`.
- `apps/web/src/lib/director/consistency-prompt.ts` — global STYLE/CHARACTERS/
  SETTING context-block technique, from `src/lib/ai-sdk.ts`'s `SYSTEM_PROMPT`
  `<global_context>` section and `createStoryboardTools()`.
- `apps/web/src/lib/studio/model-capabilities.ts` — model-capability catalog
  shape, from `src/types/constants.ts`'s `RESOLUTIONS_BY_MODEL` / `DURATIONS` /
  `LLM_MODEL_LABELS` tables.
- `apps/web/src/lib/studio/remix.ts` — remix / edit-in-place pattern, from
  `src/lib/openai/video.ts`'s `remixVideo()` and
  `src/components/videos/RemixPopover.tsx`.
- `apps/web/src/components/studio/remix-popover.tsx` — the manual remix UI
  affordance (delta-prompt popover on a take), from
  `src/components/videos/RemixPopover.tsx`. Ported to emit a ready-to-submit
  `GenerationSpec` via `buildRemixSpec` instead of calling Sora's server-side
  remix endpoint.
- `apps/web/docs/poach/ffmpeg-reference.md` — xfade offset / audio-mix / sprite /
  waveform formulas cited for reference (no code copied; our stack already
  covers these), from `src-tauri/src/commands/video_editor/ffmpeg/`.

---

## palmier-io/palmier-skills — Apache-2.0

Copyright (c) 2025 Palmier. Source: https://github.com/palmier-io/palmier-skills

Licensed under the Apache License, Version 2.0. The full license text is
reproduced at `apps/web/src/lib/studio/playbooks/LICENSE`.

Files reproduced verbatim from this project (prose unmodified):

- `apps/web/src/lib/studio/playbooks/ugc-photo-prompts.md` — from
  `skills/ugc-photo-prompts/SKILL.md`.
- `apps/web/src/lib/studio/playbooks/ugc-video-prompts.md` — from
  `skills/ugc-video-prompts/SKILL.md`.

`apps/web/src/lib/studio/playbooks/index.ts` is a generated verbatim mirror of
those two `.md` bodies (JSON-stringified) so the prose can be imported as string
constants; it is a derived copy, not a modification of the prose.

---

## OpenCut-app/opencut-classic — MIT

Copyright 2025-2026 OpenCut. Source: https://github.com/OpenCut-app/opencut-classic

```
MIT License

Copyright 2025-2026 OpenCut

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN
AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

Files adapted from this project (TypeScript / algorithm level only; none of the
project's Rust/WASM engine code was copied):

- `apps/web/src/lib/animation/easing.ts` — cubic-bezier keyframe easing (presets,
  the CSS-style timing-function evaluator, and the easing-picker UI patterns),
  adapted from the pure-TypeScript animation math in `apps/web/src/animation/bezier.ts`,
  `graph-channels.ts`, and the `timeline/components/graph-editor/*` modules.
- `apps/web/src/lib/effects/definitions/shape-mask.frag.glsl` /
  `apps/web/src/lib/effects/definitions/shape-mask.ts` /
  `apps/web/src/hooks/use-mask-handles.ts` /
  `apps/web/src/components/editor/panels/preview/mask-handles.tsx` — shape-mask
  geometry, parameterization (center/size/rotation/feather/invert), and the
  draggable-handle interaction model, adapted from opencut-classic's
  `apps/web/src/masks/` and `commands/timeline/element/masks/`. Feather is
  re-implemented as a signed-distance smoothstep in our WebGL effect system
  (their Rust JFA feather crate was not ported).

---

## francozanardi/pycaps — MIT

Copyright (c) 2025 Franco Zanardi. Source: https://github.com/francozanardi/pycaps

```
MIT License

Copyright (c) 2025 Franco Zanardi

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN
AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

Files adapted from this project (re-implemented in TypeScript for our canvas
renderer; no source copied verbatim):

- `apps/web/src/lib/captions/caption-presets.ts` and the karaoke rendering in
  `apps/web/src/services/renderer/nodes/text-node.ts` — the three-state per-word
  caption model (not-yet-narrated → being-narrated → already-narrated) and the
  pop/fade word-entry animation approach, adapted from pycaps' CSS word-state
  hooks (`.word-being-narrated`) and its `fade_in` / `zoom_in` on-narration
  animations.

---

## itsjwill/vanta — MIT

Copyright (c) 2026 itsjwill. Source: https://github.com/itsjwill/vanta

```
MIT License

Copyright (c) 2026 itsjwill

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN
AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

Referenced from this project (a curated map of open-source video tooling):

- `apps/web/src/lib/captions/caption-presets.ts` — the caption-preset taxonomy
  and active-word configuration shape were informed by vanta's caption-template
  catalog. No source copied verbatim.

---

## gl-transitions/gl-transitions — MIT

Copyright (c) 2017-present gl-transitions contributors.
Source: https://github.com/gl-transitions/gl-transitions

```
MIT License

Copyright (c) 2017-present gl-transitions contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Each transition shader is additionally MIT-licensed by its individual author,
as declared in the header comment of each file (preserved in our vendored
copies).

Files vendored from this project's `transitions/` directory into
`apps/web/src/lib/transitions/shaders/gl/` (verbatim copies with author/license
headers preserved; adapted onto our WebGL renderer contract at registration
time by `apps/web/src/lib/transitions/gl-transitions-adapter.ts`; two files —
`circle-crop.frag.glsl` and `pixelize.frag.glsl` — carry a marked minimal edit
moving progress-dependent global initializers into the transition function):

| Vendored file (`shaders/gl/`) | Upstream shader | Author |
|---|---|---|
| `angular.frag.glsl` | `angular.glsl` | Fernando Kuteken |
| `bounce.frag.glsl` | `Bounce.glsl` | Adrian Purser |
| `burn.frag.glsl` | `burn.glsl` | gre |
| `butterfly-wave.frag.glsl` | `ButterflyWaveScrawler.glsl` | mandubian |
| `circle-crop.frag.glsl` | `CircleCrop.glsl` | fkuteken |
| `circle-open.frag.glsl` | `circleopen.glsl` | gre |
| `circle.frag.glsl` | `circle.glsl` | Fernando Kuteken |
| `color-phase.frag.glsl` | `colorphase.glsl` | gre |
| `cross-warp.frag.glsl` | `crosswarp.glsl` | Eke Péter |
| `cross-zoom.frag.glsl` | `CrossZoom.glsl` | rectalogic |
| `crosshatch.frag.glsl` | `crosshatch.glsl` | pthrasher |
| `cube.frag.glsl` | `cube.glsl` | gre |
| `directional-warp.frag.glsl` | `directionalwarp.glsl` | pschroen |
| `directional-wipe.frag.glsl` | `directionalwipe.glsl` | gre |
| `doom-screen.frag.glsl` | `DoomScreenTransition.glsl` | Zeh Fernando |
| `doorway.frag.glsl` | `doorway.glsl` | gre |
| `dreamy-zoom.frag.glsl` | `DreamyZoom.glsl` | Zeh Fernando |
| `dreamy.frag.glsl` | `Dreamy.glsl` | mikolalysenko |
| `fade-color.frag.glsl` | `fadecolor.glsl` | gre |
| `fade-grayscale.frag.glsl` | `fadegrayscale.glsl` | gre |
| `fly-eye.frag.glsl` | `flyeye.glsl` | gre |
| `glitch-displace.frag.glsl` | `GlitchDisplace.glsl` | Matt DesLauriers |
| `glitch-memories.frag.glsl` | `GlitchMemories.glsl` | Gunnar Roth |
| `grid-flip.frag.glsl` | `GridFlip.glsl` | TimDonselaar |
| `heart.frag.glsl` | `heart.glsl` | gre |
| `hexagonalize.frag.glsl` | `hexagonalize.glsl` | Fernando Kuteken |
| `kaleidoscope.frag.glsl` | `kaleidoscope.glsl` | nwoeanhinnogaehr |
| `linear-blur.frag.glsl` | `LinearBlur.glsl` | gre |
| `mosaic.frag.glsl` | `Mosaic.glsl` | Xaychru |
| `perlin.frag.glsl` | `perlin.glsl` | Rich Harris |
| `pinwheel.frag.glsl` | `pinwheel.glsl` | Mr Speaker |
| `pixelize.frag.glsl` | `pixelize.glsl` | gre |
| `polka-dots-curtain.frag.glsl` | `PolkaDotsCurtain.glsl` | bobylito |
| `radial.frag.glsl` | `Radial.glsl` | Xaychru |
| `random-squares.frag.glsl` | `randomsquares.glsl` | gre |
| `ripple.frag.glsl` | `ripple.glsl` | gre |
| `rotate-scale-vanish.frag.glsl` | `RotateScaleVanish.glsl` | Mark Craig |
| `simple-zoom.frag.glsl` | `SimpleZoom.glsl` | 0gust1 |
| `squares-wire.frag.glsl` | `squareswire.glsl` | gre |
| `swap.frag.glsl` | `swap.glsl` | gre |
| `swirl.frag.glsl` | `Swirl.glsl` | Sergey Kosarevsky |
| `undulating-burn-out.frag.glsl` | `undulatingBurnOut.glsl` | pthrasher |
| `water-drop.frag.glsl` | `WaterDrop.glsl` | Paweł Płóciennik |
| `wind.frag.glsl` | `wind.glsl` | gre |
| `window-blinds.frag.glsl` | `windowblinds.glsl` | Fabien Benetou |
| `window-slice.frag.glsl` | `windowslice.glsl` | gre |
| `wipe-down.frag.glsl` | `wipeDown.glsl` | Jake Nelson |
| `wipe-up.frag.glsl` | `wipeUp.glsl` | Jake Nelson |

---

## chrisguttandin/web-audio-beat-detector — MIT

Copyright (c) 2026 Christoph Guttandin. Source:
https://github.com/chrisguttandin/web-audio-beat-detector

```
MIT License

Copyright (c) 2026 Christoph Guttandin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

Used as an npm dependency (not adapted source):

- `apps/web/src/hooks/use-beat-detection.ts` — tempo (BPM) and beat-offset
  estimation via the library's `guess()` API; our beat grid is derived from
  that tempo. The legacy energy-peak detector remains as a fallback.

---

## jwagner/smartcrop.js — MIT

Copyright (c) 2016 Jonas Wagner. Source: https://github.com/jwagner/smartcrop.js

```
Copyright (c) 2016 Jonas Wagner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

Used as an npm dependency (not adapted source):

- `apps/web/src/lib/reframe/smartcrop-fallback.ts` — content-aware crop
  selection on sampled video frames, used as the auto-reframe fallback when
  face detection finds no faces or the face service is unreachable.

---

## Signalsmith Audio / signalsmith-stretch — MIT

Copyright (c) Signalsmith Audio Ltd (Geraint Luff). Source:
https://signalsmith-audio.co.uk/code/stretch/ (npm: `signalsmith-stretch`,
JS/WASM release of the Signalsmith Stretch library)

```
MIT License

Copyright (c) Geraint Luff / Signalsmith Audio Ltd

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

Used as an npm dependency (not adapted source):

- Installed for time-stretch / pitch-preserving playback work (AudioWorklet
  WASM node); integration is implemented separately from this notice.

---

## valenbine/OpenCut-ZHS — MIT

Copyright (c) valenbine and the OpenCut contributors. Source:
https://github.com/valenbine/OpenCut-ZHS (pinned commit
`2593e12c4ff0e3649000f03fe00202f2ec941522`)

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

Design reimplemented (not verbatim source) — the fork's channel/handle animation
model and WASM `MediaTime` differ from our single-`KeyframeEasing`-per-keyframe
model, so the curve-aware keyframe copy/paste design was ported to our types:

- `apps/web/src/lib/animation/keyframe-clipboard.ts` — copy-side time
  normalization (offset from earliest keyframe) and relative-time paste with
  property-path resolution + easing/bezier preservation.
- `apps/web/src/lib/commands/timeline/element/keyframes/paste-keyframes.ts` —
  undoable `PasteKeyframesCommand`.

Mirrors the fork's `src/commands/timeline/clipboard/paste-keyframes.ts` and
`src/clipboard/handlers/keyframes.ts`.

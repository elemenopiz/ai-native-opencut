# Open-source video editors beyond OpenCut — poach survey (2026-07-13)

> 4-agent GitHub sweep, explicitly excluding OpenCut and its fork network (already
> exhausted — see [opencut-ecosystem-poaches.md](opencut-ecosystem-poaches.md) and the
> `opencut_fork_sweep` memory). Every repo below was checked live via `gh repo view` /
> `gh search repos` at survey time — do not trust star counts, license, or activity
> dates from model memory; re-verify before acting if this doc goes stale. Four lanes:
> (A) established desktop NLEs, (B) modern web-native TS/WebCodecs editors, (C)
> AI-native/auto-editing tools, (D) broad unbiased sweep for misses.

---

## Decision — what we're poaching, in order

1. **WebAV** (`av-cliper`/`av-canvas`, MIT) — read its clip/track/encoder abstractions
   before touching our WebCodecs ingest/export layer again. Closest architectural
   sibling found anywhere in the sweep; highest confidence of a clean, direct port.
2. ~~**auto-editor's `--edit` predicate DSL** (Unlicense) — port the composable
   threshold-expression model (`(or audio:0.03 motion:0.06)` + asymmetric margins +
   multi-label cut/keep/speed) as the real silence/filler-removal algorithm. Zero
   license risk, clearly better than a naive threshold.~~ **SHIPPED 2026-07-13**:
   TS reimplementation in `apps/web/src/lib/auto-cut/` (loudness → threshold →
   `mutMargin` → smoothing → multi-label chunkify, verbatim semantics from
   upstream `src/util/fun.nim`/`conductor.nim`), applied via one undoable
   `TracksSnapshotCommand` with same-track ripple; surfaced as a "Remove
   silence" clip context-menu dialog + `removeSilence` Director verb (polish
   phase). Audio-only v1 — boolean combinators are in place for a future motion
   signal; speed labels are emitted by the engine but downgraded to keep at
   apply time (timeline's 1:1 source↔timeline model). See POACH-LEDGER.md +
   THIRD_PARTY_NOTICES.md.
3. **mediabunny** (MPL-2.0) — evaluate as a dependency for GoPro/HEVC ingest
   normalization. This is the only gap in our whole backlog with a maintained,
   permissively-licensed, actively-updated library that fits it directly.
4. **OpenTimelineIO** (Apache-2.0) — adopt the OTIO schema for EDL import/export.
   Strategic rather than urgent: unlocks Premiere/Resolve/Avid/Kdenlive round-trip and
   is a credibility signal for the "serious editor" positioning, not a user-facing
   feature anyone is currently blocked on.
5. **video-use's LLM-authored EDL pattern** (MIT) — read before designing Director's
   transcript-edit-by-text feature. It's the closest existing analog: phrase-packed
   silence-aware transcript → LLM writes `edl.json` → self-evaluates cut boundaries.
6. Everything else in the tables below is lower priority — either idea-only
   (copyleft/no-license) or a smaller point fix. Don't sequence it ahead of 1–5
   without a specific trigger (e.g. a user complaint that maps directly to one).

**Explicitly not doing:** anything from Remotion or Shotstack Studio SDK (license
prohibits it outright), anything requiring AGPL/GPL code inline (Cap's app, etro.js,
Kdenlive/Olive/Blender/MLT source itself — read for architecture, never copy).

---

## Tier 1 — permissive license, code-portable

| Item | Repo | Stars | License | Lang | Fills |
|---|---|---|---|---|---|
| WebCodecs editing SDK (`av-canvas`/`av-cliper`) | [WebAV](https://github.com/WebAV-Tech/WebAV) | 2.1k | MIT | TS | Closest architectural sibling — compositor + clip combinators |
| Pure-TS demux/mux/transcode | [mediabunny](https://github.com/Vanilagy/mediabunny) | 6.7k | MPL-2.0 | TS | GoPro/HEVC ingest normalization — **no other OSS prior art found for this gap** |
| WebCodecs→container muxers | [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) / webm-muxer | 608/338 | MIT | TS | Multi-container export parity |
| Canvas→video export, worker/progress | [canvas-record](https://github.com/dmnsgn/canvas-record) | 426 | MIT | JS | Export-progress architecture |
| Silence/filler `--edit` predicate DSL | [auto-editor](https://github.com/WyattBlue/auto-editor) | 4.5k | Unlicense | Nim (was Python) | Best-in-class auto-cut algorithm |
| EDL/timeline interchange | [OpenTimelineIO](https://github.com/AcademySoftwareFoundation/OpenTimelineIO) | 1.9k | Apache-2.0 | Python | Pro-NLE round-trip, ASF/Pixar-backed |
| On-device transcription | [browser-whisper](https://github.com/tanpreetjolly/browser-whisper) | 190 | MIT | TS | Transcript-edit-by-text reference |
| Caption rendering on canvas | [subtitler](https://github.com/dmtrKovalenko/subtitler) | 374 | BSD-3-Clause | ReScript | Same |
| Dialogue/Music/SFX split | [stem-studio](https://github.com/wassermanproductions/stem-studio) | 41 | Apache-2.0 | TS | Stem-separation gap — verify underlying model (likely Demucs) before vendoring |
| Waveform rendering | [wavesurfer.js](https://github.com/katspaugh/wavesurfer.js) | 10.3k | BSD-3-Clause | TS | Audio-track UI, if it ever needs upgrading |
| LLM-authored EDL from transcript | [video-use](https://github.com/pifferologo/ai-agent-video-editor) | 152 | MIT | TS | Transcript-edit-by-text analog |
| Asymmetric J-cut trim detail | [resolve-jcut](https://github.com/ezin-rev/resolve-jcut) | 1 | MIT | — | Small but sharp: filmic (not hard-sync) auto-cut offset |

## Tier 2 — idea-only (GPL/AGPL/no-license), architecture reference only

| Pattern | Repo | License | Fills |
|---|---|---|---|
| Multicam hotkey source-switch → cut list → flatten | Kdenlive | GPLv3 | Multicam flatten-export gap — **no other OSS prior art found** |
| Ripple edit + track-relative grouping (group = ID tag, not a structure) | Kdenlive | GPLv3 | Ripple/grouping gap |
| `NodeParam`: static-or-keyframed value w/ per-key Bezier handles | Olive | GPLv3 (upstream stale ~19mo; continuation at OakVideoEditorCommunity/oak) | Audio automation curves gap |
| OCIO working→view→display color chain, not ad hoc gamma | Blender VSE | GPLv3 | Color curves/HSL gap |
| Pull-based `Service` graph — one `get_frame` interface for every producer/filter/transition | MLT Framework | **LGPL-2.1** (only LGPL repo in the lane — a compiled dependency is legally viable, unlike the rest) | Could restructure WebGL2 render graph as uniform pull-based nodes |
| Repeated-take grouping by sentence similarity | autocut-resolve | none (all-rights-reserved) | Confirms the approach is buildable; nothing to copy |
| 16-bit linear-light GPU filter pipeline (avoids banding) | Shotcut/Movit | GPLv3 | Filter-UI-state MVC split also worth mirroring |
| Proxy/original path swap via hidden shadow project file | Flowblade | GPLv3 | WebCodecs scrub-performance mode pattern |

## Confirmed dead ends — don't spend time here

- **Remotion** (53k★) — custom license explicitly prohibits copying/modifying its code
  to build and sell/license a derivative. That's exactly what porting into Byorn would
  be. Ideas-only at most; re-verify terms before even that.
- **Shotstack Studio SDK** — PolyForm Shield 1.0, bars using the software to build a
  competing product. Same verdict.
- **Lightworks** — still proprietary/DRM'd as of 2026 despite a 2010 open-source
  promise that never materialized.
- **DaVinci Resolve** — no OSS SDK; Lua/Python scripting API is
  proprietary-but-documented only.
- **Cap** (20k★) — core app is AGPLv3 (network-use clause triggers on any hosted/SaaS
  use). MIT carve-out only for capture-primitive crates (`cap-camera*`, `scap-*`) —
  relevant only if native capture is ever needed.
- **etro.js** (GPL-3.0) — layer/effect-graph model and AV-sync worth studying,
  zero literal code reuse safe.

## Direct competitors surfaced (track, don't poach) — see follow-up writeups

**freecut**, **omniclip**, **openreel-video** — three MIT browser NLEs running a
similar core bet to Byorn (client-side editing, no server-side render). Full
competitor writeups landed 2026-07-13 — see `freecut-competitor.md`,
`omniclip-competitor.md`, `openreel-video-competitor.md` in this directory.
Headline finding across all three: **none has a generative/agentic AI layer** —
Director's moat is unclaimed. Corrections to the original survey: omniclip is WebGL
(PixiJS), not WebGPU; openreel-video has been stalled 6+ weeks (last commit
2026-06-01) despite its star count, and runs a live Solana memecoin promoted from its
own README — a due-diligence flag, not just a feature comparison. Best concrete poach
surfaced: openreel-video's on-device MediaPipe background removal (person
segmentation) — verified gap, nothing equivalent exists in our codebase.

Also noted: **FireRed-OpenStoryline** (already tracked, see
[similar-repos-survey.md](similar-repos-survey.md)) — LLM "intention-driven
directing" agent with reusable "Style Skills," conceptually adjacent to
Director/StyleBible. **video-db/Director** (MIT, Python, 1.4k★) — AI video-agent
framework, name collision with our own "Director," worth a glance for positioning
only, not code.

## Remaining gaps with genuinely no OSS prior art anywhere in the sweep

- **GoPro/HEVC ingest normalization** — mediabunny is a general demux/mux toolkit,
  not normalization-specific, so it closes this gap partially at best.
- **Multicam flatten-to-export** — Kdenlive's UX pattern is the only reference found,
  and it's idea-only (GPLv3).

Both remain original-build items, informed by the patterns above rather than ported
from anywhere.

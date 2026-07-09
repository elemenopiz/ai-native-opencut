# OpenCut-ecosystem & wider-space poach report — for Byorn

**Date:** 2026-07-09 · **Branch:** `feat/ai-reel-studio`
**Method:** 3 parallel research agents (OpenCut lineage + forks · same-space
tools the prior pass missed · git divergence audit), with all
highest-value claims **re-verified by grep against our own tree** before
inclusion (see "Verification notes" — two agent claims were wrong and are
excluded).

This doc is the **companion to the existing 8-doc Palmier corpus** in this
folder. That corpus is ~90% Palmier + a survey of 11 AI-native competitors, and
it **deliberately excluded our own OpenCut upstream**. This pass fills exactly
that gap. It has three findings, in descending order of actionability.

---

## TL;DR — the three veins

| Vein | Source | License | Verdict |
|---|---|---|---|
| **1. OpenCut mainline (`opencut-classic`)** | `OpenCut-app/opencut-classic` (~48k★ org) | **MIT — verbatim-copyable** | **Primary poach source.** Shipped ~6 editor primitives we lack, all at the TS/UI level. This is the highest-ROI vein and nobody has touched it. |
| **2. Wider-space tools the Palmier pass missed** | ArcReel, vanta, pycaps, MuseTalk, InstantID/PuLID, Chinese short-video agents | Mixed | Idea + some permissive code. Biggest strategic item: **lip-sync (we have zero)**; biggest map: **`vanta` (MIT) is a curated 40-tool poach-map**. |
| **3. Our direct upstream (`Ekaanth/OpenCut-AI`)** | our `upstream` remote | MIT | **Exhausted — 0 behind, fully merged.** Nothing to cherry-pick. Confirms the interesting divergence is against *mainline* OpenCut, not our frozen upstream. |

**Lineage (all MIT):** `elemenopiz/ai-native-opencut` ← `Ekaanth/OpenCut-AI`
(our `upstream`, frozen at `fa2764d`, 2026-06-19) ← `mazeincoding/OpenCut` /
`OpenCut-app/opencut-classic` (the live mainline). Because the whole family is
MIT, mainline code copies in **verbatim** with attribution in
`THIRD_PARTY_NOTICES.md` — unlike the GPL/AGPL Palmier & OpenMontage sources,
which are idea-only.

---

## Vein 3 first (shortest): upstream is exhausted

The audit against the **live** `Ekaanth/OpenCut-AI` remote (via `git ls-remote`,
not a stale local ref):

- Live `upstream/main` HEAD = **`fa2764d`** — *exactly our merge-base*. Upstream
  has committed nothing since 2026-06-19.
- Divergence: **0 behind / 2 ahead** (our two AI Reel Studio commits).
- One branch, zero tags — no hidden feature branches to mine.
- Every OpenCut-AI headline feature (AI copilot, CLIP search, A/B thumbnails,
  music-gen, multi-provider video-gen adapter in `types/ai.ts`, etc.) is already
  an ancestor of our HEAD and physically present in our tree.

**Implication:** to get new MIT poaches from "our own family," the target is
**mainline `opencut-classic`**, which kept shipping editor primitives (v0.1 →
v0.4) *after* OpenCut-AI branched off. That's Vein 1.

> **Architectural caveat on mainline:** classic **v0.3+ rewrote its renderer to
> Rust/wgpu-WASM and switched timing to integer `MediaTime` ticks**. Those
> internals are **not** portable into our TS/WebGL/seconds-based fork. Poach
> classic at the **TS / UI / geometry / algorithm level only**, re-implementing
> any shader math in our existing WebGL effect system
> (`lib/effects/definitions/`).

---

## Vein 1 — OpenCut mainline (`opencut-classic`), MIT, copyable

Ranked by ROI. **Every item below was grep-verified against our tree today** —
including two the research agent flagged as gaps that we in fact already have
(now excluded): **blend modes** (`panels/properties/sections/blending.tsx`,
`blendMode` across the renderer) and **safe-zone / layout guides**
(`panels/preview/layout-guide-overlay.tsx`). Don't re-poach those.

### P1 — Bezier easing on keyframes  ·  HIGH value · M effort
- **Gap: CONFIRMED.** `grep bezier|easing|graph-editor|easingPreset` across
  `lib/` and the whole `src/` tree = **empty**. We have keyframes +
  `speed-curve-editor.tsx` + `lib/animation/interpolation.ts`, but interpolation
  is **linear only**.
- **What to take:** classic's keyframe **graph editor** — drag bezier handles to
  shape easing between keyframes, easing presets, per-property keyframe lanes,
  copy/paste keyframes between elements. Source:
  `apps/web/src/timeline/components/graph-editor/*`, `apps/web/src/animation/bezier.ts`,
  `graph-channels.ts`, `keyframes.ts` (pure TS — portable).
- **Why for us:** motion polish is table-stakes, and an AI-native editor whose
  Director *generates* motion should emit **eased** curves, not linear ramps.
  This upgrades both manual editing and every future generated animation.
- **Where it lands:** extend `lib/animation/interpolation.ts` with cubic-bezier
  evaluation; add an easing-curve UI beside our existing `speed-curve-editor.tsx`.

### P1 — Lip-sync / talking-head  ·  HIGH value · L effort  *(cross-vein: see Vein 2)*
- **Gap: CONFIRMED.** No `lipsync|wav2lip|musetalk` anywhere but playbook prose.
  This is our single biggest capability gap vs. Captions.ai / Argil / HeyGen and
  pairs directly with our persona/seed-lock work. Engine options in Vein 2 §Lip-sync.

### P2 — Pitch-preserved speed changes  ·  MED value · ~~S~~ **M effort** *(bug is real; fix is NOT cheap — corrected 2026-07-09)*
- **Gap: CONFIRMED, but the "S / property-flip" framing was WRONG.** This fork no
  longer uses `HTMLMediaElement` for preview: video renders to a **canvas via
  WebCodecs** (`services/video-cache/service.ts`, mediabunny `CanvasSink`) and
  audio plays through **Web Audio `AudioBufferSourceNode`** (`core/managers/audio-manager.ts:397`
  sets `node.playbackRate.value`). Neither has a `preservesPitch` property — in
  Web Audio, `playbackRate` and `detune` fold into one `computedPlaybackRate`, so
  pitch cannot be decoupled without a real **time-stretch (WSOLA / phase-vocoder)**.
  Complicated further by keyframed *variable-rate* speed curves (0.1×–4×) and
  chunk-streamed audio with existing drift/resync logic.
- **Fix (re-scoped M):** integrate a vetted AudioWorklet time-stretcher (e.g.
  soundtouch-based) rather than hand-rolling DSP; requires audible verification.
- **PLUS a separate pre-existing bug found alongside:** export's audio mixdown
  (`lib/media/audio.ts`, `createTimelineAudioBuffer`/`mixAudioChannels`) doesn't
  apply `playbackRate` to audio placement **at all** — sped-up clips aren't even
  time-shortened in the exported audio. Fix export timing *before* layering pitch
  preservation on top.

### P2 — Shape masks (ellipse / rect / star / cinematic bars + feather/invert)  ·  HIGH value · M–H effort
- **Gap: CONFIRMED.** Only `sections/crop-mask.tsx` exists; no shape/reveal masks,
  no mask shaders in `lib/effects/definitions/`.
- **What to take:** classic's shape-mask set + draggable preview handles
  (`apps/web/src/masks/`, `commands/timeline/element/masks/`). **Re-implement the
  feather in our WebGL** (classic moved feather to a Rust JFA crate — not portable).
- **Why for us:** cinematic bars and shape reveals are staple reel effects and
  compose naturally with generative clips.

### P2 — Canvas background fill (blur / solid / gradient)  ·  HIGH value for reels · L–M effort
- **Gap: PARTIAL — verify.** No `BackgroundPanel`/`canvasBackground` UI, but a
  `backgroundType` field appears in our **storage migration transformers**
  (`services/storage/migrations/transformers/v1-to-v2.ts`) — i.e. the data model
  carries a background field with no editing UI wired to it. Confirm what's live
  before building.
- **What to take:** classic's Background tab — **blurred-background fill is the
  default look for 9:16 repurposing** and a cheap complement to our smart-reframe.

### P3 — Preview zoom & pan  ·  MED value · L–M effort
- **Gap: CONFIRMED** (`grep zoomLevel|preview zoom` empty). Needed for fine work
  on mask handles / keyframes (i.e. a prerequisite that makes P2-masks and
  P1-easing actually usable). Classic v0.3.

### P3 — Properties-panel niceties  ·  LOW–MED value · S effort
- Math-expression number inputs + click-drag scrubbing; color picker with
  **eyedropper** + opacity + multiple formats (`grep eyedropper` empty). Classic
  v0.1. Self-contained polish.

**Explicitly NOT gaps (verified present — do not poach):** blend modes ·
safe-zone/layout guides · ripple edit (`lib/ripple/`, 17 hits) · RMS waveforms ·
CLIP search · A/B thumbnails · music-gen · auto-duck · color-correction profiles.

---

## Vein 2 — wider-space tools the Palmier pass missed

Full candidate table and citations preserved below; the strategically important
ones:

### Lip-sync engines (fills the P1 gap above)
| Engine | License note | Pick when |
|---|---|---|
| **TMElyralab/MuseTalk 1.5** | training code open | **Default** — best real-time speed/quality balance |
| **ByteDance LatentSync** | verify | Highest visual fidelity (diffusion) |
| **Alibaba Sonic** | verify | Adds audio-driven emotion/expression, not just mouth |
| SadTalker / VideoReTalking / Diff2Lip / mowshon/lipsync | verify each | Fallbacks |

Deploys as a Python sidecar next to our existing Whisper service; input is our
persona anchor still + a TTS/voiceover track (both of which we already produce).
**Caveat: verify model-weight licenses separately** — several are research/
non-commercial even when the code is permissive.

### Character/face consistency (our build #1) — permissive *code*
- **instantX-research/InstantID** (Apache-2.0) — zero-shot ID-preserving from one
  image; good for fast persona iteration.
- **PuLID** (Apache-2.0) — best-in-class identity locking for *final* assets.
- **IP-Adapter** — the general reference-conditioning workhorse.
- These are a stronger identity lock than a bare `/images/edits` reference pass;
  candidate upgrade to `lib/studio/persona-still.ts`. **Weights license: verify.**

### `itsjwill/vanta` (MIT) — treat as a poach-map, not a product
A curated aggregation of 40+ OSS tools mapped to exact use cases: GL-Transitions
pipeline, **word-by-word/karaoke caption templates**, react-timeline-editor →
Remotion JSON, GPT-SoVITS/OpenVoice voice, SadTalker/Wav2Lip avatars. Lowest-
effort, highest-density thing to mine in this whole report. https://github.com/itsjwill/vanta

### `francozanardi/pycaps` (MIT) — animated captions via **standard CSS**
Whisper word-level timestamps → `.word-being-narrated` CSS state hooks. A clean,
copyable styling engine for the animated/karaoke caption layer we've flagged as
"remaining work" (we have transcription; we lack styled/animated caption presets).

### ArcReel (`ArcReel/ArcReel`, ~3.2k★, **AGPL — idea only**)
Our closest *new* competitor and the most strategically instructive: novel →
character/clue extraction → storyboard → video, cross-shot consistency via a
locked "character-design image," built on the **Claude Agent SDK (Skill +
Subagent)** — same agent lane as our Director. Two patterns worth borrowing (not
copying): **lease-based RPM scheduling** across independent image/video/audio
channels, and **CapCut/Jianying draft export** with subtitle tracks.

### Idea-only reframes (closed competitors + AGPL sources)
- **Virality scoring →** reframe around **hook-score + hold-rate + attention
  heatmap** (Higgsfield Virality Predictor) and **multi-platform reaction
  simulation** (Azure-Vision/viral-predictor) instead of one scalar. Directly
  upgrades our existing A/B/virality features.
- **OpenMontage "Backlot"** — a live **cost-preview + approval gate before
  expensive renders**. Reinforces the fail-closed-approval-gate idea already in
  `similar-repos-survey.md` #2.
- **Product-URL → ad** ingestion (Creatify) — a concrete missing *input path*;
  aligns with the URL→Ad funnel already in `higgsfield_gap_analysis.md` Phase C.
- **Distribution/publishing automation** (Chinese short-video agents:
  NarratoAI, Pixelle-Video, MoneyPrinterTurbo, etc.) — a whole workflow stage
  after export that we don't cover at all.

### SysAdminDoc/OpenCut (MIT, Premiere ext — **idea-poach**, Python/CEP stack)
- **Repeated-take detection via transcript similarity** — auto-groups retries of
  the same spoken line. **Directly complements our generative "takes" model:
  apply the same clustering to *recorded* footage.** Reuses our Whisper
  transcripts; just add similarity clustering. High strategic fit, M effort.
- **Audio stem separation** (Demucs) — "remove music, keep voice"; we have
  auto-duck but not stem isolation. HIGH value, L effort (Python sidecar).
- **AI highlight extraction** — segment-level engagement scoring for auto-cut;
  overlaps virality scoring at finer granularity.

### Full candidate table (new finds beyond the prior corpus)
| Repo / Product | Stars | License | Poachable | Effort |
|---|---|---|---|---|
| ArcReel/ArcReel | ~3.2k | AGPL-3.0 | Idea + architecture | H to match / L to borrow |
| itsjwill/vanta | ~77 | **MIT** | **Code + poach-map** | Low |
| diffusionstudio/core | ~1k+ | verify | Code (WebCodecs compositor) | Med |
| omni-media/omniclip | — | AGPL (verify) | Idea (browser NLE) | — |
| Augani/openreel-video | — | verify | Idea/code (WebGPU CapCut clone) | Med |
| Anil-matcha/Open-AI-Micro-Drama-Generator | — | verify (usually MIT) | Idea + adapter list | Low |
| 0xsline/StoryGen-Atelier | — | verify | Idea (storyboard→Veo→ffmpeg) | Low |
| francozanardi/pycaps | — | MIT (verify) | **Code (CSS captions)** | Low |
| hosuaby/PupCaps | — | verify | Code (karaoke CSS) | Low |
| Chinese short-video agents (NarratoAI, Pixelle-Video, MoneyPrinterTurbo, …) | 1k–30k+ | mostly MIT/Apache | Idea + some code (publishing) | Low–Med |
| Azure-Vision/viral-predictor | — | verify (open) | **Idea (reaction sim)** | Low |
| Palmier forks (Voidsprog/palmier-pro-windows, …) | small | GPLv3 | Idea (cross-platform path) | — |

---

## Master sequencing recommendation

Ordered by ROI = (value × verified-real) ÷ effort, MIT-copyable first:

1. **`preservesPitch` fix (P2, S)** — smallest, fixes a real audio bug we ship today.
2. **Mine `vanta` + adopt `pycaps` CSS captions (S–M, MIT)** — closes the
   "animated captions" remaining-work item cheaply, with copyable code.
3. **Bezier easing / keyframe graph editor (P1, M, MIT verbatim)** — compounding:
   upgrades manual editing *and* every future Director-generated animation.
4. **Shape masks + preview zoom (P2/P3, M–H, MIT)** — land together (masks need
   zoom to be usable); staple reel effects.
5. **Lip-sync sidecar — MuseTalk 1.5 (P1, L)** — biggest capability gap vs. avatar
   competitors; reuses persona still + TTS we already produce. Verify weights license.
6. **Repeated-take detection (idea, M)** — highest *conceptual* fit: extends our
   "takes" model to recorded footage using Whisper transcripts we already have.
7. **Reframe virality → hook/hold/heatmap + reaction sim (idea, M)** — upgrades an
   existing feature; no new pipeline.
8. **Track only, don't build:** mainline's Rust/wgpu WASM compositor rewrite
   (`OpenCut-app/OpenCut`). If it lands performant, our WebGL renderer dates —
   revisit then, not now.

## Verification notes (why to trust this doc)
- Grep-verified **present** (excluded from gaps): blend modes, safe-zone guides,
  ripple, CLIP search, A/B thumbnails, music-gen, auto-duck.
- Grep-verified **absent** (real gaps): bezier/easing, `preservesPitch`,
  shape masks, preview zoom, eyedropper, lip-sync, stem separation.
- **PARTIAL / verify before building:** canvas background fill (schema field in
  migrations, no UI). Model-weight licenses for all AI engines in Vein 2.
- Per memory-freshness rules: re-confirm file paths/line numbers at implementation
  time — none of this is wired yet.

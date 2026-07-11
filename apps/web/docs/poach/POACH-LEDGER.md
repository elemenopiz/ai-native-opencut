# POACH LEDGER — Byorn provenance & audit trail

> Living state file of the Poach Orchestrator. Every lift of external code (or
> deliberate reimplementation of an external technique) gets a row. Companion to
> root `THIRD_PARTY_NOTICES.md` (the legal notice file); this is the operational
> record: what, from where, under what license, how it was adapted, where it lives.
> Rules of engagement: `.claude/fable-poach-orchestrator.md`.

## Ledger

| # | Capability | Source (repo @ pin) | License (SPDX) | Copy vs. reimplement | Destination | Date | Status | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | Multi-provider video-gen adapter, CLIP search, A/B thumbnails, music-gen (inherited fork base) | `Ekaanth/OpenCut-AI` @ fa2764d (upstream, frozen) | MIT | Fork ancestry | whole tree | pre-2026-07 | on `main` | Upstream exhausted (0 behind); attribution kept per rebrand-decisions |
| 2 | GLSL transition library — 48 vendored shaders (~20 → 68 transitions) | `gl-transitions/gl-transitions` | MIT | Verbatim copy + adapter (`gl-transitions-adapter.ts` prelude/footer; 2 marked minimal edits: circle-crop, pixelize) | `apps/web/src/lib/transitions/shaders/gl/` | 2026-07-11 | ✅ **MERGED to `main` @ `4df4ac4`** (founder-gated; combined typecheck+lint verified vs baseline) | Per-shader author/license headers preserved; NOTICES updated in-commit; InvertedPageCurl skipped (BSD-3) to keep set uniformly MIT; luma/displacement skipped (need external textures). Verified: WebGL1 compile+link, p=0/1 endpoint correctness, visual spot-check |
| 3 | LUT color-grading UI (wire `lut-3d` effect: picker, .cube import, 5 builtin looks) | — (no external code; builtins generated programmatically) | n/a | Original | `apps/web/src/lib/effects/` (`lut-builtins.ts`, `lut-upload.ts`) + properties panel | 2026-07-11 | ✅ **MERGED to `main` @ `6efd31b`** (founder-gated; combined typecheck+lint verified vs baseline) | No third-party LUT files bundled → no license obligation. Closes registry WIRING TODO. Known cosmetic: 2 fixable `noNonNullAssertion` lint warnings in `lut-builtins.test.ts` |
| 4 | Canvas background fill (blur/solid/gradient) | — (original build) | n/a | Original | `apps/web/src/components/editor/panels/assets/views/background-settings.tsx` (+ `settings.tsx` section), `apps/web/src/services/renderer/nodes/composite-effect-node.ts` (`coverCanvas`), `apps/web/src/services/renderer/scene-builder.ts` | 2026-07-11 | ✅ **MERGED to `main` @ `e4b97bf8`** (founder-gated; combined battery: tsc = baseline, lint = baseline, +16 tests all pass) | Reuses existing `settings.background` TBackground union — no schema change; dormant v1 `backgroundType` still reconciled by v1→v2 migration. Gradients ride `type:"color"` as CSS gradient strings (ColorNode/drawCssBackground handles preview + export). Verified live: all 3 modes over an underfitting 16:9 clip on 9:16 canvas, blur persists across reload; typecheck 0, zero new lint |
| 5 | Pitch-preserved speed changes (kills chipmunk audio; offline pre-stretch, shared preview/export seam) | `signalsmith-stretch` npm @ **1.3.2** (Signalsmith Audio / Geraint Luff) | MIT | Vendored JS/WASM release verbatim (`public/vendor/signalsmith-stretch-1.3.2.mjs`) + original integration (`lib/media/pitch-preserving-stretch.ts`, audio-manager wiring) | `apps/web/public/vendor/`, `apps/web/src/lib/media/` | 2026-07-11 | ✅ **MERGED to `main` @ `3fdab8b6`** (advisor lane built; founder-gated 2026-07-11) | NOTICES already carries the Signalsmith MIT entry (full license text). Graceful fallback to pitch-shifted playback if WASM fails to load; e2e + 16 unit tests |
| 6 | Beat/tempo detection upgrade (BPM-grid, replaces naive energy detector) | `web-audio-beat-detector` npm @ **8.2.37** (chrisguttandin) | MIT | Package dependency (no source copied); legacy detector kept as fallback | `apps/web/package.json` + beat-detection call sites | 2026-07-11 | ✅ **MERGED to `main` @ `d5f92a89`** (advisor lane @ `3959650`; user-approved) | npm-vetted 2026-07-11; NOTICES entry present |
| 7 | Content-aware auto-reframe fallback (no-face frames) | `smartcrop` npm @ **2.0.5** (jwagner/smartcrop.js) | MIT | Package dependency (no source copied) | `apps/web/package.json` + `lib/reframe/smartcrop-fallback.ts` | 2026-07-11 | ✅ **MERGED to `main` @ `d5f92a89`** (advisor lane @ `bb4b6a7`; user-approved) | npm-vetted 2026-07-11; NOTICES entry present |
| 8 | Subtitle/caption **IMPORT** (SRT / ASS / VTT) — parse file → real text-track elements via Add/Insert timeline commands | `valenbine/OpenCut-ZHS` @ **`2593e12c4ff0e3649000f03fe00202f2ec941522`** | MIT | Copy (SRT + ASS parsers ~verbatim, import paths only) + adapt (types/insert/builder to Byorn's flat `TextElement`) + original (WebVTT parser — new; source ships SRT+ASS only) | `apps/web/src/lib/subtitles/` (`types.ts`, `srt.ts`, `ass.ts`, `vtt.ts`, `parse.ts`, `build-subtitle-text-element.ts`, `insert.ts`) + `captions.tsx` UI ("Import subtitles" picker) | 2026-07-12 | 🔧 committed on `poach/subtitle-import` (not yet merged; founder-gated) | Tier-1 #1 from fork-network sweep — we only *exported* before. Impact(`Captions`)=LOW (1 direct consumer). 27 parser unit tests pass (bun:test); typecheck clean for new code (only pre-existing `content-collections` codegen errors remain, unrelated). Source `build-subtitle-text-element.ts` did full canvas text measurement via its own layout utils — reimplemented as transform-offset placement matching our existing `addSubtitleTrack`. NOTICES updated. |

## Capability × Source map (gaps → candidates → verdict)

Basis: 2026-07-11 re-audit in memory + fresh grep this session. **Already shipped on
`main` — do NOT re-poach:** bezier easing (`lib/animation/easing.ts`), shape masks
(SDF WebGL, `mask-handles.tsx`), karaoke captions (pycaps-attributed), beat-snap
grid (`beat-ticks.tsx`, naive energy detector), face auto-reframe, chroma key, LUT
engine, CapCut export, eyedropper, blend modes, safe zones, ripple. License classes
are as last scouted — **re-verify at hunt time before any lift**.

| Gap (grep-verified open) | Best candidate(s) | License class | Verdict / next move |
|---|---|---|---|
| Pitch-preserving speed change | `signalsmith-stretch@1.3.2` | 🟢 MIT | ✅ **DONE — MERGED** (ledger row 5) |
| Canvas background fill (blur/solid/gradient) | Original build | 🟢 n/a | ✅ **DONE — MERGED** (ledger row 4) |
| Beat/tempo detector upgrade | **`web-audio-beat-detector@8.2.37`** — npm-vetted 2026-07-11: MIT, active (2026-06). Picked over `realtime-bpm-analyzer` (Apache-2.0, realtime-oriented; our use is offline buffer analysis) | 🟢 MIT | ✅ **DONE — MERGED to `main` @ `d5f92a89`** (advisor lane built @ `3959650`, legacy detector kept as fallback; user-approved) |
| Auto-reframe fallback (no-face content) | **`smartcrop@2.0.5`** — npm-vetted 2026-07-11: MIT, jwagner; last publish 2022 but algorithm-complete, zero deps | 🟢 MIT | ✅ **DONE — MERGED to `main` @ `d5f92a89`** (advisor lane built @ `bb4b6a7`; user-approved) |
| Color curves / HSL wheels (only `speed-curve-editor.tsx` exists — no color curves) | opencut-classic / MIT vein; curve-editor math | 🟢 MIT | POACH — M effort; LUT engine already provides application path |
| Stem separation ("remove music, keep voice") | Demucs (MIT but **archived**) | 🟢 verify fork health | HUNT — Python sidecar next to Whisper service |
| Speech enhancement / denoise | DeepFilterNet (MIT/Apache) | 🟢 | HUNT — Python sidecar candidate |
| Lottie sticker layer | lottie-web (MIT) | 🟢 | HUNT — scope first |
| Lip-sync / talking-head | **CUT 2026-07-09 (user decision)** — if revisited: fal.ai adapter into `lib/studio/backends/` router, NOT a sidecar | — | HOLD |
| Identity lock upgrade (persona) | InstantID / PuLID (code Apache-2.0) | 🟡 weights verify | Candidates for `lib/studio/persona-still.ts`; weights gate. Face-identity direction already decided (on-device ArcFace-class, weights TBD) |
| Repeated-take detection (recorded footage) | SysAdminDoc/OpenCut technique | idea-only (stack mismatch) | REIMPLEMENT — cluster Whisper transcripts we already have |
| **Never lift:** Palmier, OpenMontage, ArcReel, omniclip, essentia.js/aubio, soundtouchjs | — | 🔴 GPL/AGPL/LGPL | Idea-only, clean-room reimplement where valuable |

**Serialization note:** the three package-dep poaches (signalsmith-stretch, beat
detector, smartcrop) all touch `package.json`/`bun.lock` — one branch or strictly
serialized, never parallel.

## Standing decisions

- soundtouchjs is **LGPL — rejected**; signalsmith-stretch (MIT) is the chosen time-stretch vein.
- opencut-classic v0.3+ Rust/wgpu/MediaTime internals are **not portable** — poach at TS/UI/algorithm level only.
- Model **weights** licenses are vetted separately from code licenses; several permissive-code repos ship non-commercial weights.

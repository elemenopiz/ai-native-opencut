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
| 4 | Canvas background fill (blur/solid/gradient) | — (original build) | n/a | Original | `apps/web/src/components/editor/panels/assets/views/background-settings.tsx` (+ `settings.tsx` section), `apps/web/src/services/renderer/nodes/composite-effect-node.ts` (`coverCanvas`), `apps/web/src/services/renderer/scene-builder.ts` | 2026-07-11 | ✅ **built @ `7465210` — pending merge gate** (branch `poach/canvas-background-fill`) | Reuses existing `settings.background` TBackground union — no schema change; dormant v1 `backgroundType` still reconciled by v1→v2 migration. Gradients ride `type:"color"` as CSS gradient strings (ColorNode/drawCssBackground handles preview + export). Verified live: all 3 modes over an underfitting 16:9 clip on 9:16 canvas, blur persists across reload; typecheck 0, zero new lint |

## Capability × Source map (gaps → candidates → verdict)

Basis: 2026-07-11 re-audit in memory + fresh grep this session. **Already shipped on
`main` — do NOT re-poach:** bezier easing (`lib/animation/easing.ts`), shape masks
(SDF WebGL, `mask-handles.tsx`), karaoke captions (pycaps-attributed), beat-snap
grid (`beat-ticks.tsx`, naive energy detector), face auto-reframe, chroma key, LUT
engine, CapCut export, eyedropper, blend modes, safe zones, ripple. License classes
are as last scouted — **re-verify at hunt time before any lift**.

| Gap (grep-verified open) | Best candidate(s) | License class | Verdict / next move |
|---|---|---|---|
| Pitch-preserving speed change (live chipmunk-audio bug: Web Audio playbackRate shifts pitch) | **`signalsmith-stretch@1.3.2`** — npm-vetted 2026-07-11: MIT, publisher = DSP author (Signalsmith Audio). NOT soundtouchjs (LGPL 🔴) | 🟢 MIT | **🚧 IN PROGRESS — advisor lane**, branch `feat/pitch-preserved-speed` (off `integrate/poach-wave`). Poach-orchestrator's duplicate agent stopped 2026-07-11 to end a two-implementation race. Export playbackRate pre-req already fixed @ `b075734` |
| Canvas background fill (blur/solid/gradient — default 9:16 repurpose look) | Original build over dormant `backgroundType` field (no UI; grep: 0 hits in components/); opencut-classic Background tab as UX prior art only | 🟢 n/a (original) | ✅ **BUILT** @ `7465210` on `poach/canvas-background-fill` — see ledger row 4; awaiting founder merge gate |
| Beat/tempo detector upgrade (replace naive energy detector) | **`web-audio-beat-detector@8.2.37`** — npm-vetted 2026-07-11: MIT, active (2026-06). Picked over `realtime-bpm-analyzer` (Apache-2.0, realtime-oriented; our use is offline buffer analysis) | 🟢 MIT | ✅ **BUILT — advisor lane** @ `3959650` (legacy detector kept as fallback), merged into `integrate/poach-wave` @ `4d61072`, full battery green (tsc 0, 763/763 unit, e2e 1/1) — **awaiting founder merge gate to `main`** |
| Auto-reframe fallback (no-face content) | **`smartcrop@2.0.5`** — npm-vetted 2026-07-11: MIT, jwagner; last publish 2022 but algorithm-complete, zero deps | 🟢 MIT | ✅ **BUILT — advisor lane** @ `bb4b6a7`, merged into `integrate/poach-wave` @ `4d61072`, same green battery — **awaiting founder merge gate to `main`** |
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

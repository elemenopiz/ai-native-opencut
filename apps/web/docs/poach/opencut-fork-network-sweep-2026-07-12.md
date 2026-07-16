# OpenCut fork-network sweep — for Byorn

**Date:** 2026-07-12 · **Branch:** `main` (survey only — no code lifted in this pass)
**Method:** 6 parallel research agents. Full `OpenCut-app/OpenCut` fork **network**
enumerated (~6,689 forks; only 941 had any post-fork activity, 66 substantial, 14
source-verified), plus the renamed derivatives that *left* the network, plus the
sibling AI forks of our own upstream `Ekaanth/OpenCut-AI`. Every high-value claim
was **grep-verified against our own tree** before inclusion, and **reconciled against
the in-flight `poach/*` worktrees** (a concurrent 2026-07-12 mainline-poach session).

Companion to [`opencut-ecosystem-poaches.md`](./opencut-ecosystem-poaches.md) (which
covered mainline **drift**) and [`similar-repos-survey.md`](./similar-repos-survey.md).
This pass covers the fork **network** — the question "does any fork, AI or not, have
a general editing feature worth taking?"

> **License boundary.** Every fork below except two is MIT (they descend from
> MIT OpenCut / MIT `Ekaanth/OpenCut-AI`), so TS/UI/algorithm lifts are clean with
> `THIRD_PARTY_NOTICES.md` attribution. The two exceptions: **`SysAdminDoc/OpenCut`**
> is a *name-collision* — a separate Python/Flask + Adobe Premiere extension, NOT our
> lineage — so anything from it is idea-only reimplementation; **`JXUE0/opencut-controller`**
> is a standalone MCP bridge used here as a *checklist*, not a code source. Re-pin
> every source SHA at lift time.

---

## TL;DR

1. **The fork ecosystem is ~99% empty.** Of ~6,689 forks, ~5,748 never received a
   commit and ~700 more touch only README/i18n/CI/docker/branding. The star-sorted
   fork list is worthless (all stale mirrors). Value lives in a few **renamed** forks
   that left the network and a couple of **sibling** AI forks.
2. **Five of the highest-value gaps are already being built** by a concurrent
   `poach/*` session — do **not** re-poach them (table below).
3. **The single best source is same-lineage, not mainline.** `valenbine/OpenCut-ZHS`
   (and the `rich-bot/OpenCut` cluster) implement our missing editor features in our
   *exact* TS/React/Zustand **+ GLSL** stack — cleaner than mainline OpenCut, whose
   masks/compositor moved to Rust/wgpu and need re-homing.
4. **`FlashCut` (1,212 commits ahead) has nothing** — we exceed it on every axis.

---

## ⚠️ Already in flight — DO NOT re-poach (concurrent `poach/*` session, 2026-07-12)

My sweep independently rediscovered these; they are already owned. Listed so nobody
double-builds. My sweep's contribution: a **cleaner same-lineage source** (valenbine /
rich-bot, GLSL) if the mainline-Rust port hits friction.

| Feature | In-flight branch | State | Same-lineage source my sweep found |
|---|---|---|---|
| Bezier keyframe/easing graph editor | `poach/bezier-graph` | ✅ committed `3ad57d5f` | valenbine `src/timeline/components/graph-editor/bezier-graph.tsx`, `src/animation/bezier.ts` |
| Grid / rule-of-thirds guides | `poach/preview-guides` | ✅ committed `6c1d8dea` | — |
| Mask shapes (split/heart/diamond) + handles | `poach/mask-shapes` | 🔧 uncommitted WIP | rich-bot `src/masks/builtin/definitions/{diamond,heart,split}.ts` |
| Multi-select grouped move + resize | `poach/group-move-resize` | 🔧 uncommitted WIP | valenbine `src/timeline/group-move/*`, `group-resize/*`; hudijiang `src/lib/timeline/group-resize/compute-resize.ts` |
| Detach / extract source audio to own track | `poach/timeline-toolbar` | 🔧 uncommitted WIP | — |

---

## ✅ Genuinely new & NOT in flight — ranked poach targets

All grep-verified absent from `main` **and** absent from the `poach/*` branches.

### Tier 1 — clean same-lineage ports (our exact TS/React/Zustand + GLSL stack)

| # | Feature | Source (repo · path) | License | Effort | Byorn destination / note |
|---|---|---|---|---|---|
| 1 | **Subtitle / caption IMPORT (SRT / ASS / VTT)** — parse → real text track via Add/Insert commands (verified end-to-end, not a stub) | `valenbine/OpenCut-ZHS` · `src/subtitles/{srt,ass,parse,insert,build-subtitle-text-element}.ts` | 🟢 MIT | **S–M** | We only *export* (`…/captions.tsx` `handleExportSubtitles`). Independently flagged by 3 agents — the clearest gap. |
| 2 | **Keyframe copy/paste between elements** — curve-aware clipboard (property-path resolution, relative-time paste, interpolation preserved) | `valenbine/OpenCut-ZHS` · `src/commands/timeline/clipboard/paste-keyframes.ts`, `src/clipboard/handlers/keyframes.ts` | 🟢 MIT | **S** | Lands in `apps/web/src/lib/commands/timeline/element/keyframes/` (has upsert/remove/retime/set-easing, no copy/paste). |
| 3 | **Non-uniform (independent W/H) scale** — edge handles = `scaleX`/`scaleY`, corners stay uniform | `valenbine/OpenCut-ZHS` · `src/preview/controllers/transform-handle-controller.ts` (Corner/EdgeScaleSession) | 🟢 MIT | **M** | ⚠️ Data-model change: `element.scale` (single axis) in `apps/web/src/types/rendering.ts` → `scaleX/scaleY`. **Run `impact({target:"scale"})` first** (CLAUDE.md rule) — wide blast radius. |
| 4 | **Mask stroke param + freeform pen-tool mask** — `strokeColor/strokeWidth/strokeAlign`; click-to-add-point custom path | `valenbine/OpenCut-ZHS` · `src/masks/types.ts` (stroke fields), `src/masks/freeform/{definition,path}.ts` | 🟢 MIT | **S–M** | Stroke is additive to our mask params. Freeform pen = "wave 2" of the in-flight `poach/mask-shapes` work — **coordinate with that owner**; our path = rasterize Path2D → alpha canvas → GLSL feather (their JFA feather is Rust, not portable). |

### Tier 2 — new capabilities

| # | Feature | Source (repo · path) | License | Effort | Note |
|---|---|---|---|---|---|
| 5 | **Transcript-based text editing (Descript-style edit-by-transcript)** — delete text → cut timeline; filler/silence removal, speaker labels, gap edits. Deepest & best-tested feature of the whole sweep (8 dedicated test files) | `ChickenAlexanderPillow/OpenCut` · `src/lib/transcript-editor/{core,state,constants}.ts`, `src/lib/clips/transcript/*` | 🟢 MIT | **L** | We have Whisper transcripts (`transcript-store.ts`) but no edit-by-transcript engine. Fills our own vs-Descript positioning. ⚠️ **Product caution:** a 2026-07-12 commit "retire the old text-editing pitch from the empty-editor guide" suggests possible de-emphasis — confirm direction before building. |
| 6 | **Multicam flatten-to-export** — record live switch-points, `flatten-multicam` bakes them into real timeline cuts | `khazaryan/OpenCut` · `src/core/managers/multicam-manager.ts`, `src/commands/multicam/{add-multicam-switch,flatten-multicam,create-multicam-clip}.ts` | 🟢 MIT | **M** | Our multicam (`…/multicam.tsx`, `lib/multicam/index.ts`) is preview-only (toggles track visibility during playback) and likely doesn't survive export — a **correctness** gap. Verify our multicam export first. |
| 7 | **GoPro/HEVC/`.mov` auto-normalize on ingest** — detect problem footage (regex `gh\d{2}\|gx\d{2}\|max\d{2}`, HEVC) and transcode to editor-safe H.264 before it enters the timeline | `randyaswin/OpenCut-AI` · `src/lib/media/ffmpeg-normalizer.ts` | 🟢 MIT | **M** | We have nothing; common "clip silently won't preview/decode" reliability win. Same ffmpeg.wasm stack. |
| 8 | **Plan-preview-then-execute Copilot UX** — ReAct loop: AI proposes a multi-step plan (`GET_SYSTEM_CAPABILITIES` self-introspection so it only plans against real transitions/effects), user confirms before execution, destructive-action gate + cancel | `randyaswin/OpenCut-AI` · `src/lib/copilot/agent-loop.ts`, `src/components/editor/ai/{plan-execution-block,chat-message}.tsx` | 🟢 MIT | **M** | Our `hooks/use-ai-command.ts` is single-shot fire-and-apply. Adds a preview/safety layer for natural-language edits. |
| 9 | **Audio automation curves** — draggable volume/param automation points on the timeline + sidechain config UI + one-shot triggers | `Yang-Yiming/myOpenCut` · `src/core/managers/automation-manager.ts`, `src/components/editor/panels/timeline/automation-point-markers.tsx`, `…/dialogs/sidechain-config-dialog.tsx` | 🟢 MIT | **L** | Our `audio-envelope.ts` is display-only. Distinct from the existing auto-duck. |

### Tier 3 — small QoL / infra

| Feature | Source · path | License | Effort |
|---|---|---|---|
| One-click "close gap" (ripple a single gap shut) | `IpaaserHub/OpenCut` · `src/commands/timeline/element/close-gap.ts` | 🟢 MIT | S |
| Alt-drag clip clone w/ ghost preview · corner drag→fade-in/out handles | `vnt87/cave` ("Prawn") | 🟢 MIT | S each |
| OPFS→IndexedDB fallback for non-TLS / LAN-IP self-hosting | `marcosveigamkt-prog/OpenCut-AI` | 🟢 MIT | S |
| Repeated-take detection (Jaccard word-overlap → flag "speaker restarted") | `SysAdminDoc/OpenCut` · `opencut/core/repeat_detect.py` (idea-only, Python) | reimplement | S |

### Strategic / future (not a clean poach)

- **MCP editor-control surface.** Our MCP (`lib/mcp/build-mcp-server.ts`, server
  `byorn-reel-director`) exposes ~21 **Director** verbs from `toolCatalog()`.
  `JXUE0/opencut-controller` exposes **161 general timeline tools across 24 categories**
  (timeline/keyframes/audio/canvas/export/selection/…). Use its category list as a
  **checklist** for where our external-agent surface is thin — directly serves the
  "real tools, not passthrough" positioning vs Vyra. Effort L (new general
  editor-control catalog alongside Director's).
- **WebCodecs hardware-accelerated export.** Concept worth building properly later as
  an ffmpeg.wasm alternative; the one fork attempt (`babysharkek`) has broken muxing —
  do not port it.
- **Rust/WASM compositor (~20× render perf).** `valenbine` `rust/crates/{compositor,masks}`
  (JFA distance-field feather) + `Pacvue/OpenCut`. Architectural reference only if
  perf becomes a blocker — not portable to our WebGL/GLSL stack.

---

## ❌ Swept and dismissed

- **`zstar1003/FlashCut`** (1,212 ahead / 278 files) — diverged before our monorepo
  restructure; its features (client-side Whisper captions, text drag/transform,
  timeline caching, bulk segment delete) are all things we already implement more
  completely. Nothing to take.
- **`SysAdminDoc/OpenCut`** (27★) — name collision; separate Python/Flask + Premiere
  CEP/UXP extension. Fully incompatible stack; ~100 advertised features mostly overlap
  what we already ship (ducking, loudness, chapters, filler removal, semantic search).
  Only idea-level residue: repeated-take detection (Tier 3), multicam auto-switch from
  diarization, histogram color-match (M, needs shader), speech de-reverb (L, needs a
  Torch model server we don't run).
- Chinese-localization / Electron-desktop / link-farm derivatives (`OpenCut-CN`,
  `opencut-zh-desktop`, `Browser-Video-Editor`, `SOUMIKBERA`, `InZei/open-cut`,
  `bbylw`) — no editing features; desktop packaging also fights our hosted-SaaS
  direction.
- ~5,748 never-committed mirror forks + ~700 translation/CI/docker/branding-only forks.

**Coverage:** whole ~6,689-fork network enumerated (67 pages, `sort=newest`); 941
active → 924 compared → 201 with real source → 66 substantial → 14 source-verified.
Renamed derivatives found via `gh search repos` (they left the fork network). Sibling
forks of `Ekaanth/OpenCut-AI` (30) swept; ~24 dead.

---

## Feeds the ledger

None lifted yet — these are candidates. When one lands, add a
[`POACH-LEDGER.md`](./POACH-LEDGER.md) row (capability · source@pin · SPDX · copy vs.
reimplement · destination · status) and a `THIRD_PARTY_NOTICES.md` entry. Suggested
first lifts (low effort, non-colliding with the `poach/*` wave): **#1 subtitle import**
and **#2 keyframe copy/paste**.

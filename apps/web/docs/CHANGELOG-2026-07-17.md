# Byorn — Speedrun Changelog, 2026-07-17

Staged on local `main`, **not yet pushed** (push = prod deploy, gated on the user — queue G2).
Range `99ab432c..827e36c8` · 283 files · +32,865 / −729.

**Composition:** ~7,500 lines product code · ~13,700 tests/e2e · ~11,700 docs + measured evidence.
16 campaigns merged, combined battery green at each step; C7 wave-3 regression hunt found
**zero golden-path regressions** across the whole integration (real exports ffprobed).

> Verification tiers below: **merged** (battery green) · **verified locally** (driven in a real
> browser on the dev Mac) · **architectural finding** (traced, no contained fix). Nothing here is
> **verified on prod** yet — that's the B3 gate (G1) after the push.

---

## Moats

### Character consistency (C2 — @77196b22, verified locally)
- StyleBible / ConsistencyContext **fold now applies on the manual Generate and remix paths**, not
  only the Director agent. This was the moat's core defect — the "keep one character consistent"
  promise silently dropped on the main UI path. (`lib/studio/consistency-fold.ts`,
  `hooks/use-studio-generation.ts`)
- Persona **seed-lock threading** on single-shot generations (batches stay seed-varying per server contract).
- Composer **consistency UI**: persona chip + seed-lock badge, StyleBible preview chip, personas
  empty-state, cross-tab "pick a persona" hint. (`components/studio/generation-form.tsx`)
- **Real-face routing seam** (`REAL_FACE_VIDEO_BACKEND`, Seedance→Runway) — env-gated, inert by
  default; prep for BytePlus verified-asset partner access.
- DoD proof: `e2e/persona-consistency.e2e.ts` — one persona × 3 seed-locked generations + cross-project reuse.

### MCP editor (C3 — @75bbc99c, merged; relay needs a two-instance staging smoke)
- **Cross-instance editor-bridge relay** over the existing Upstash Redis pub/sub — env-gated,
  fail-soft (null = prior single-instance behavior). (`lib/mcp/bridge-relay.ts`, `editor-bridge.ts`)
- Three new board verbs: `getBoard` / `promoteBoardItem` / `discardBoardItem` (catalog 53→56;
  paid 1080p-promote deliberately excluded).
- BUG13-class **input-validation guards** on MCP-reachable commands (closed a real `Object.entries(null)` crash).
- **Double edit-loop reliability e2e** (connect→edit→export→reconnect→repeat) + token-auth edge coverage; zero product defects found.
- Palmier conformance audit: `docs/mcp/palmier-conformance-2026-07-17.md` (13 covered / 8 partial / 17 gap; 24-item backlog).

---

## Security & tenancy (C6 @74403866 + C6-w2 @11c3ad30)

- **HIGH — SSRF closed.** Four image/video backend adapters fetched client-controlled reference
  URLs server-side with no guard (default image backend reachable; loopback / `169.254.169.254`
  cloud-metadata exposed, with raw errors echoed as a recon oracle). Now routed through a
  DNS-pinned `lib/studio/reference-fetch.ts` (validate + `pinnedFetch` + redirect re-validation,
  generic errors). (BUG-SSRF)
- **Live cross-tenant fix (BUG24).** `version-control/media/[hash]` had no repo-access check — any
  authed user with a content hash could fetch another user's media. Now gated by `checkRepoAccess`
  (uploader fast-path + any-referencing-repo access; public-repo parity preserved).
- **Constant-time beta-gate compare** (BUG26).
- **Observability alerting webhook** — dep-free, env-gated, secret-redacting (ADR-002 seam). (`lib/observability/logger.ts`)
- **Route-protection sweep green** (BUG20) — all 54 API routes classified; the three riskiest
  "public" routes source-verified (MCP token auth, Polar signature, metadata-only endpoints).
- **Collab pre-unhide security packet** — 3 HIGH findings documented; nothing un-hidden (`docs/security/`).
- API security re-sweep: paid-route auth gating, tenancy scoping, rate-limit coverage, and secret
  handling all re-proven sound.

---

## Performance (C5 — @c64060dc, verified locally via repro harnesses)

- **fps60 playback wedge FIXED (BUG2).** The decode-starvation re-seek storm: `tolerateStale`
  requests outside the sequential window now serve the current stale frame + kick exactly one
  coalesced background re-seek per sink; export path unchanged. Stall episodes 521ms→0 under CPU
  throttle. (`services/video-cache/service.ts`)
- **CLIP-indexer / proxy race fixed (BUG14).** The auto-indexer no longer competes with proxy
  generation for the same un-proxied 4K decode. The ~70% remainder is main-thread 4K decode on the
  preview path — architectural, folds into the worker-compositor case.
- **Worker-compositor default-ON = HARD NO-GO** (evidence-backed). Flag-ON renders a **black
  preview** (overlay canvas cleared opaque every frame, BUG23); prior flag-ON fps numbers measured
  an invisible canvas. Ships OFF with a 3-precondition path to re-open the decision.
- **HDR export flattening (BUG16)** — traced to the mediabunny dependency's `CanvasSink` (srgb 2d
  context, upstream of all first-party seams). Architectural finding, no contained fix.

---

## Export & formats (C11 — @47f75475, 6 presets ffprobe-verified)

- **SRT/VTT caption export, client-side** — replaces a call to the frozen Python ai-backend that
  was **broken on prod**. Timeline-time cue mapping, lossless round-trip through the in-repo parsers.
  (`lib/export/captions.ts`, `lib/subtitles/serialize.ts`)
- **Preset matrix with real dimension plumbing** — YouTube / TikTok / Reels / Instagram Square +
  Portrait / 720p / 4K, via a contain-fit letterbox output stage (scene still renders at project
  canvas). (`services/renderer/scene-exporter.ts`, `contain-fit.ts`)
- **Clean-room GIF89a encoder** — median-cut quantizer + LZW (with the GIF "early-change" code-width
  fix). Kept out of the Director/MCP verb surfaces. (`lib/export/gif/*`)
- QA matrix: `docs/export/qa-matrix-2026-07-17.md` (6 real exports ffprobed clean).

---

## Audio suite (C9 — @5287f9c6, playback-verified)

- **BUG5/F8 — duplicate voiceover UIs reconciled** to one `VoiceoverView` (Assets→Audio via
  `AudioCombinedView`; Generate-panel Voiceover is a redirect, not a reimpl). Regression-locked.
- **Generation-audio to timeline** — Music "Add to timeline" lands on an audio track; Score places at span.
- **Auto-duck under voiceover** — VO-element spans + WebAudio gain automation; audible ducking
  verified in real playback. **Playback-only** — export mixdown honoring is tracked as BUG32.
  (`hooks/use-auto-duck.ts`, `core/managers/audio-manager.ts`)

---

## Director intelligence (C8 — @b0a83aaa, merged)

- **Beat-grid grounding** in the Director's asset manifest + slot timing in reel summaries. (`lib/director/asset-manifest.ts`)
- **Critic verdict-memory + failure-axis taxonomy** — bounded in-session, zero new model calls. (`lib/director/vision-critic.ts`)
- **Adapter-defaults regression sweep** — verified the undefined-clobbers-defaults bug class is contained; one latent `buildSpec` case fixed (BUG31, in C7-w3).
- Context-gap audit tail: `docs/director-context-tail-2026-07-17.md` (14-item Tier 2/4 verdict table).

---

## Golden-path robustness & UX

- **Anon-401 fix (BUG12, C13 @3cd3acd4).** Background hydration 401s no longer evict anonymous users
  to `/signup` (silent-mode `apiFetch`); also de-flaked CI. Real session-expiry still prompts.
- **Toaster / tasks-widget occlusion (BUG8/9, C10 @8d73a107)** — Toaster to bottom-left, tasks widget
  minimized-default + z-40.
- **First-run truth pass (C10)** — platform-aware ⌘K (was Mac-wrong Ctrl+K), reel→video de-brand,
  honest "private to your account" copy, generative-path empty states. BUG19 root-caused (guide
  hides the composer).
- **Rate-limit toast (BUG3)**, **label truncation (BUG10)**, **keyboard project rename (BUG11)**,
  **drag-overlay copy (BUG30)**, **buildSpec undefined-clobber (BUG31)**.
- **BUG1** (odd-dimension proxy crash) confirmed fixed-prior; **BUG4/BUG7** closed as obsolete/harness-artifact.

---

## Inventory & test depth

- **C1 (@e67f1860)** — landed the parked Palmier-15 delta wave + 6 poach branches (director verb
  telemetry, staged-export-jobid, VU meter, scrub-player, MCP project binding, chroma/LUT, agent
  undo), reaped ~35 dead branches, and prepared the money + upscale gated packets.
- **C12 (@0ebedaf6)** — machine-verified golden-path e2e (generate→edit→**real export**→ffprobe),
  takes/board invariant suite, CI wiring (ffmpeg + real-export job). Much of the +13.7k test lines.
- **C4-A (@c5864ac4)** — UI direction pass (Instrument-Grade Minimal) + 11 annotated screenshots =
  the taste-gate package (G7).

---

## Known follow-ups filed (see SPEEDRUN-QUEUE.md)

- **G8 (money floor):** `sweepStaleHolds` is implemented + tested but has **zero production call
  sites** — abandoned/crashed jobs strand reserved credits. Needs a scheduled cron (deploy-config = gated).
- **BUG25 (money):** `studio/image` settles the charge before persisting the row — a DB blip post-settle = charged with data loss.
- **BUG32:** export mixdown doesn't honor volume automation (auto-duck works in playback, not in exported files).
- **BUG33:** imported-subtitles-only users can't reach caption export (gated on transcript segments).
- **C4-B (taste-gated on G7):** guide-hides-composer, timeline empty state, and the panel-by-panel UI polish.
- **Gated packets:** `fix/credit-audit-money-gated` (needs rebase-and-reconcile), `feat/upscale-backend` (migration 0012 + FAL_KEY).

## User gates before this reaches users

G1 B3 prod verify · **G2 push (this whole changelog)** · G3 Resend sender domain · G4 provider spend
caps · G5 Vercel token rotation · G7 UI taste-gate · G8 sweepStaleHolds cron · G9 legal contact email.

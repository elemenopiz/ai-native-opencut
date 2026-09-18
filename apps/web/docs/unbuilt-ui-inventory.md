# Unbuilt UI Inventory

Functionality that has **working backend / lib / API / exported code, but no UI wired to it** — no
page, panel, dialog, button, menu item, or shortcut that actually invokes it.

Compiled 2026-07-10 by a 4-agent parallel sweep (auth · AI-studio · editor/timeline · services).
Each finding was verified by proving the *negative*: the exported symbol / route / component has no
importer, no client fetch, and nothing mounts or triggers it from a user-facing surface.

## Two systemic patterns

1. **No auth UI at all** — better-auth is fully configured and its API works, but nothing calls
   `signIn`/`signUp`/`useSession`. This is the root launch blocker (users can't make accounts) and
   it also silently disables the otherwise-complete MCP token dialog.
2. **The "orphaned panel" epidemic** — ~15 fully-built view components (`panels/assets/views/*`,
   `panels/timeline/*`) exist with their own hooks/libs but are **never imported by any mounted
   component**. The asset panel mounts exactly 12 tabs via `viewMap` in
   `apps/web/src/components/editor/panels/assets/index.tsx`; these panels were left out. Most look
   like casualties of a tab-system refactor. **The fix for the majority is a 3-line wiring recipe**
   (see below), which makes this the highest-leverage cleanup in the repo.

### Quick-wire recipe (applies to most Category B items)
1. add a tab key in `apps/web/src/components/editor/panels/assets/assets-panel-store.tsx` (`TAB_KEYS`)
2. add the component to `viewMap` in `apps/web/src/components/editor/panels/assets/index.tsx`
3. add a `TabBar` icon
   — OR, for Studio features, add a `StudioMode` + button in `views/director.tsx` (pattern: `ABTestingPanel`).

---

## Category A — Auth (root launch blocker)

| # | Feature | Code that exists | UI gap | Conf | Effort |
|---|---------|------------------|--------|------|--------|
| A1 | **Login / signup / session / sign-out** | `lib/auth/client.ts` exports `signIn`/`signUp`/`useSession`; `lib/auth/server.ts` `emailAndPassword.enabled`; handler at `app/api/auth/[...all]/route.ts` (sign-up/sign-in endpoints work); `users`/`sessions`/`accounts` tables | Zero importers of the auth client. No login/signup page, no form, no session provider, no real sign-out (the "Logout" icon in `editor-header.tsx:237` is "Exit project"). | **High** | M |
| A2 | **Account management / delete account** | `lib/auth/server.ts` `user.deleteUser.enabled = true` → endpoint exposed | No account/profile page, no delete button. Settings panel covers only project/proxy/AI keys. | High | S–M |
| A3 | **MCP token dialog (built, but dead without A1)** | `api/mcp/tokens/route.ts` (session-gated), `lib/mcp/token-client.ts`, `dialogs/mcp-connect-dialog.tsx` — mounted & reachable via `editor-header.tsx:290/321` | Fully built both ends, but every token endpoint 401s with no session and there's no sign-in UI to get one. **Falls out for free once A1 ships.** | High | S (dependent on A1) |
| A4 | Email verification / password reset | `verifications` table exists | No `sendVerificationEmail`/`forgetPassword` config and no forgot/reset UI — closer to "not wired either end." Low priority. | Medium | M |

> **Not a gap:** billing / payments / subscriptions / waitlist — searched `stripe|polar|billing|subscription|checkout|payment|waitlist`; **no underlying code exists**, so there's nothing to wire (it's absent, not unbuilt-UI). Relevant if monetization is a launch goal.

## Category B — Orphaned panels (built, never mounted) — mostly quick-wire

| # | Feature | Code that exists | Status | Conf | Effort |
|---|---------|------------------|--------|------|--------|
| B1 | **Audio effects chain** (EQ/Comp/Gate/Reverb/De-esser/Limiter) | `panels/timeline/audio-effects-panel.tsx` + `lib/audio/audio-effects.ts` (full DSP) | Zero importers; mixer is mounted but nothing opens the per-track chain | High | S |
| B2 | **Multicam editing** | `views/multicam.tsx` + `lib/multicam/*` | Orphaned; no tab, no viewer, no angle-switch | High | M |
| B3 | **Direct audio recording** (mic→timeline) | `views/audio-recording.tsx` + `hooks/use-audio-recording.ts` | Orphaned; hook used only by its panel | High | S |
| B4 | **Script-to-Video** | `views/script-to-video.tsx` + `hooks/use-script-to-video.ts` | Orphaned (flagged by 2 agents); prominently advertised | High | S |
| B5 | **Shorts / Reel composer** | `views/shorts-composer.tsx` + `hooks/use-shorts-composer.ts` | Orphaned (2 agents); backs the "60-second reel" pitch | High | S |
| B6 | **AI music generation** | `views/music-gen.tsx` + `hooks/use-music-gen.ts` | Orphaned (2 agents); Audio combined view doesn't include it | High | S |
| B7 | **Scene detection** | `views/scene-detection.tsx` + `hooks/use-scene-detection.ts` + `lib/scene-detection/*` | Orphaned (2 agents) | High | S |
| B8 | **Batch export** | `views/batch-export.tsx` + `lib/export` | Orphaned; single export IS wired (`export-button.tsx`) | High | S |
| B9 | **Markers** panel + timeline render + jump | `panels/timeline/markers-panel.tsx`; actions in `lib/actions/definitions.ts` / `hooks/actions/use-editor-actions.ts` | **Partial:** `m` drops a marker, but panel is orphaned, markers never render on the ruler, and next/prev have no shortcut/button — markers are write-only & invisible | High | M |
| B10 | **AI toolbar: Infographic gen + Background removal** | backend `ai-backend/app/routes/generate.py` `/infographic` `/remove-bg` (+ `image-service` `/remove-bg`); `aiClient.generateInfographic()`/`removeBackground()`; `ai/ai-toolbar-buttons.tsx` + `ai/background-removal-dialog.tsx` | **Entire `AIToolbarButtons` is mounted nowhere**; both client methods have zero callers | High | S |
| B11 | AI Thumbnail Generator (standalone panel) | `views/thumbnail-gen.tsx` + `hooks/use-thumbnail-gen.ts` | **Partial:** hook also used by `ab-testing.tsx` (reachable via Director), so basic gen works; the full 5-style/4-size panel is orphaned | High | S |
| B12 | Template gallery | `views/template-gallery.tsx` + `lib/templates` | **Partial:** Director mounts a *different* `TemplatePanel`; the searchable gallery is orphaned | Medium | S |

## Category C — Orphaned features that need more than a tab

| # | Feature | Code that exists | UI gap | Conf | Effort |
|---|---------|------------------|--------|------|--------|
| C1 | **Version control: conflict resolution / cherry-pick / branch-switcher / sync-status** | Full `panels/version-history/version-history-panel.tsx` + `conflict-resolution.tsx` / `cherry-pick-dialog.tsx` / `branch-switcher.tsx` / `split-preview.tsx` / `sync-status.tsx`; engines `services/merge/*`, `core/managers/version-manager.ts` | A lighter `VersionControlDrawer` IS mounted (commit/branch/merge/diff/tag), but the full panel is unmounted, so **conflict resolution, cherry-pick, and sync are unreachable** despite the merge engine existing | Med-High | M |
| C2 | **TurboQuant model manager** | `turboquant-service` `/v1/models*` (catalog/download/load/unload/delete) → `ai-backend/routes/turboquant.py` → 9 `aiClient.turboquant*` methods (`lib/ai-client.ts:1575-1652`) | None of the 9 methods has a caller. Settings only wires status + tier/KV/compute toggles — no catalog browse / download / load / delete surface | High | M |
| C3 | **Beat detection (audio analysis)** | `views/beat-detection.tsx` + `hooks/use-beat-detection.ts` + `beat-grid-store.ts` | **Partial:** beat *grid* is wired (toolbar, `beat-ticks.tsx` render) but `use-beat-detection` (the analysis that populates it) is only used by the orphaned panel — grid can't be populated from audio | Medium | S-M |

## Category D — Orphaned actions / endpoints (no trigger)

| # | Feature | Code that exists | UI gap | Conf | Effort |
|---|---------|------------------|--------|------|--------|
| D1 | **Studio provider key config** (Runway, Kling, Veo, Imagen, Nano-Banana, FLUX, Ideogram, GPT-Image, fal) | Adapters in `lib/studio/backends/{video,image}/*` read keys from server `process.env`; `GET /api/studio/backends` surfaces available ones in the model picker | Settings "API Keys" (`settings.tsx` `API_KEY_FIELDS`) only offers Freesound/Sarvam/Smallest/Pexels/Seedance/Replicate/Stability/Luma. ~8 studio providers are **env-only** — inconsistent with their configurable peers | Medium | M |
| D2 | Image prompt enhancement | `ai-backend/routes/generate.py` `/enhance-prompt`; `aiClient.enhancePrompt()` | Zero callers; image-gen callers invoke `generateImage` directly with no "enhance" action | High | S |
| D3 | Subtitle export (SRT/VTT) | `ai-backend/routes/transcribe.py` `/transcribe/subtitles`; `aiClient.generateSubtitles()` | Zero callers (captions build their own output) | Medium | S |
| D4 | Sarvam transliterate / detect-language, Smallest voice picker | `sarvam.py` `/transliterate` `/detect-language`; `smallest` `/voices`; client methods `sarvamTransliterate`/`sarvamDetectLanguage`/`smallestVoices` | Zero callers; TTS passes a hardcoded voice `"emily"` instead of a `smallestVoices` picker | Medium | S each |

## Category E — Probably delete, not wire (dead parallel / low value)

| # | Item | Why | Action |
|---|------|-----|--------|
| E1 | **AI Co-Pilot panel** (`views/copilot-panel.tsx` + `hooks/use-copilot.ts`, ~24 action types) | Orphaned, but the mounted **Director** tab already implements plan/approve/execute (`runDirectorAgent`/`executeDirectorAction`) — this looks like a superseded parallel implementation, not a missing capability | Confirm Director covers it, then remove |
| E2 | Undo-history panel (`panels/timeline/undo-history-panel.tsx`) | Orphaned; undo/redo already work via keybindings — a low-value visualization | Wire only if desired, else drop |

---

## Verified wired (NOT gaps) — recorded to prevent re-investigation

- **Auth-adjacent:** none (see Category A).
- **Studio/Director:** core generation (personas, takes, sets, board, image, backends, upload, generate, remix, reference intake); A/B thumbnail + hook + analytics testing (`ab-testing.tsx` in Director).
  - ⚠️ **CORRECTED 2026-09-18.** This row previously claimed "Virality Score + Engagement
    Diagnostics (`virality-score-modal.tsx` from header)" was verified wired. That is
    **false**: `virality-score-modal.tsx` has never existed in this repo's git history,
    and nothing is wired from the header. What actually exists is
    `components/editor/youtube/engagement-panel.tsx` — fully built, and **orphaned**
    (no importer). `score-breakdown.tsx`, `engagement-diagnostics.tsx`,
    `lib/engagement-diagnostics.ts` and `stores/engagement-store.ts` are live, but only
    reachable through `youtube-reels-panel` → `clip-grid`, which scores YouTube-ingested
    clips rather than the current timeline. Treat standalone virality scoring as a
    **Category B quick-wire**, not as done.
- **Editor/timeline:** Transitions/Effects/Filters/Adjust (`visuals-combined.tsx`), Crop & Mask, Speed-curve editor, Ripple editing, LUFS loudness + auto-duck, Audio mixer, Smart reframe / motion tracking / ai-dubbing / auto-chapters, Bookmarks, version commit/branch/merge/diff drawer.
- **Services:** face (`/detect`→podcast-clips), clip (`/embed`/`/zero-shot`→visual-search), speaker (`/diarize`/`/analyze-emotion`→captions), whisper + tts (voiceover/captions + service-health/setup guide), YouTube **ingest** (note: no upload/publish integration exists), Freesound/Pexels (settings + sounds), Marble CMS (public blog), denoise/beats-grid/visual-search.

## Suggested sequencing for launch

1. **A1 auth UI** — unblocks A2, A3, and account-gated Studio routes. Nothing ships without it.
2. **Category B quick-wires** — biggest surface-area-per-effort; most are the 3-line recipe. Start with B10 (whole AI toolbar), B1/B3/B4/B5/B6/B7/B8.
3. **B9 markers render** + **C1 conflict/cherry-pick** + **C2 TurboQuant manager** — medium features worth finishing.
4. **D1 provider key config** — needed if users bring their own provider keys; otherwise document env-only.
5. **E1/E2** — decide delete vs. wire to reduce dead code.

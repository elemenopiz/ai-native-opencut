# Campaign: audio-suite (C9) — log

Branch: `campaign/audio-suite` off main @2a1307a0. L1 orchestrator worktree: `.claude/worktrees/agent-a2931e62c4ee83ffe`.

## Recon findings (2026-07-17, verified against code @2a1307a0)

1. **BUG5 ("two duplicate voiceover UIs") is fixed-prior at the code level.**
   The second full voiceover UI `apps/web/src/components/editor/ai/voiceover-panel.tsx`
   was DELETED in `d72df321` ("feat(studio): add Audio tab (score + music) to the
   generation panel"). The Generate panel's Audio tab has a `VoiceoverRedirect`
   (`audio-panel.tsx` ~L747) that deep-links via `openAudioSubTab("voiceover")` to the
   one canonical pipeline: `apps/web/src/components/editor/panels/assets/views/voiceover.tsx`
   (875 lines; also the Director `addVoiceover` target via `generate-voiceover-take.ts`).
   Only ONE component imports `runVoiceoverTake`/`TTS_VOICES` today. Remaining work =
   browser-verify entry points (redirect, command palette "Audio" entry, ai-toolbar
   `onGenerateVoiceover`) + drive a mocked TTS generation, then close BUG5/F8 rows.
2. **Gen-audio flows exist but music has no path onto an audio track.**
   `components/studio/audio-panel.tsx`: Score mode (MMAudio V2, `action:"score"`,
   async fal queue via `/api/studio/audio` + `[jobId]` poll) places a scored VIDEO
   at the captured span; Music mode (ElevenLabs Music, `action:"music"`, sync) adds
   the result to Assets only — no "add to timeline" affordance. Gap: land the music
   take on an audio track.
3. **Auto-duck exists but is inaudible.** `hooks/use-auto-duck.ts` +
   `views/auto-duck.tsx` (mounted in Audio tab → Enhance) write `volume` keyframes
   from TRANSCRIPT segments via `timeline.upsertKeyframes`. But playback applies only
   static `clip.volume` (`core/managers/audio-manager.ts` `connectClipNode`, fixed
   GainNode); `resolveVolumeAtTime` (`lib/animation/resolve.ts`) is consumed only by
   the properties UI. Two gaps: (a) duck spans should derive from VOICEOVER elements
   on the timeline (no transcript required); (b) the WebAudio mix graph must honor
   volume keyframes (gain automation on the clip gain node = the audio-mix seam,
   in-territory). Export-side honoring lives in `lib/export` = OFF-LIMITS (C11) →
   report, don't touch.

## Partition (file-disjoint, parallel)

| Worker | Scope | Owned files |
|---|---|---|
| W1 | BUG5 verify + close: entry-point sweep, mocked-TTS browser drive of voiceover.tsx, fix only what's broken | `panels/assets/views/voiceover.tsx`, `views/audio-combined.tsx`, `e2e/voiceover-single-ui.e2e.ts` (new) |
| W2 | Gen flows: music→audio-track placement, verify score placement, mocked-provider e2e for both backends | `components/studio/audio-panel.tsx`, `e2e/audio-gen.e2e.ts` (new) |
| W3 | Auto-duck: VO-element-derived spans + volume-keyframe gain automation in playback mix graph | `hooks/use-auto-duck.ts`, `views/auto-duck.tsx`, `core/managers/audio-manager.ts` + its tests |

Hot-file notes: `audio-panel.tsx` is W2-only (W1 does NOT touch the redirect); nobody
touches `lib/export`, renderer/compositor, stores outside territory, credits, routes.

## Status (only what HAS happened — updated as events occur)

- [x] Recon done; campaign log written (@1046d982).
- [x] W1 (BUG5 verify+close) returned @34f8b068 — dup UI already deleted @d72df321; new `e2e/voiceover-single-ui.e2e.ts`. Diff audited (e2e-only), merged @dd... (W1 merge commit).
- [x] W3 (auto-duck) returned @60ff1b6c — VO-element spans + playback gain automation; +22 unit tests; authorized `lib/media/audio.ts` AudioClipSource plumbing (additive optional `animations?`, NOT shared with export mixdown). Diff audited, merged.
- [x] W2 (gen flows) returned @ae72d393 — Music mode "Add to timeline" → fresh audio track via addTrack+insertElement (probed duration); `e2e/audio-gen.e2e.ts` (Music+Score, mocked). Diff audited, merged.
- [x] Campaign tip after all three merges: **78b5fc78**.
- [x] Battery on 78b5fc78: typecheck exit 0; lint 341 errors (≤454 baseline ⇒ no-worse); `bun test` 2079 pass / 12 fail — all 12 pre-existing & OUT of territory (Polar/webhook signature = missing webhook-secret env; generateProxyOffThread worker tests = process-global mock.module leak, pass 15/0 in isolation); W3 unit files 22/22 pass.
- [x] `build:e2e` compiles successfully (23.3s) BUT the full prod build fails prerendering `/beta-gate` — PRE-EXISTING Next 16 SSG useContext-null, `/beta-gate` untouched by this campaign (queue row for owning campaign). e2e therefore run against a dev server.
- [x] Browser-verified (dev server :3214, NEXT_PUBLIC_E2E, viewport 1440): W1+W2 specs **5/5 pass** — BUG5 canonical pipeline renders, Generate-panel Voiceover redirect lands on Assets→Audio→Voiceover, mocked TTS lands audio on timeline, Music "Add to timeline" → audio track, Score → Assets. Screenshots in `apps/web/e2e/screenshots/`.
- [x] Auto-duck live-playback smoke DONE via **W4** @f2953515 → merged; new `e2e/auto-duck-playback.e2e.ts` (import-pipeline seeding, real playback). Asserts the music element gets the exact predicted duck keyframes AND `editor.audio.clipGainNodes` populates during real playback with a decoded buffer (audible ducking, animated gain node). W4 also corrected the auto-duck detection note: the full-voiceover pipeline element carries NO `generation.kind` — the name-pattern fallback (`VOICEOVER_NAME_PATTERN`) is what catches it; documented + asserted. My earlier console-synthetic-seed attempt crashed the timeline error boundary (hand-built elements bypass `processMediaAssets`; editor recovers on reload) — a harness limitation, not a defect; W4's real-import path is the correct verification.
- [x] Final campaign tip after W4 merge: **a4f5d4e6**. Final battery: typecheck 0; lint 341 (≤454); `bun test` 2079/12 (12 pre-existing, out-of-territory); **e2e 6/6 pass** in a real browser (voiceover-single-ui ×3, audio-gen ×2, auto-duck-playback ×1).

## Corrections from L0 (recorded)

- The `/beta-gate` `build:e2e` prerender failure I hit was **ENVIRONMENTAL** — L0 ran `build:e2e` clean on main (exit 0, no beta-gate error). Downgraded from "queue row" to an env note; NOT a real bug.
- The export-doesn't-honor-volume-automation gap is already filed by L0 as **BUG32** — not double-filed here.

## Queue-row deltas for L0 (apply to SPEEDRUN-QUEUE on main)

- CLOSE **BUG5** / **F8** — two duplicate voiceover UIs reconciled to ONE (`components/editor/panels/assets/views/voiceover.tsx` = `VoiceoverView`, surfaced in the Assets Audio tab via `AudioCombinedView`); the second full UI `components/editor/ai/voiceover-panel.tsx` was already deleted @d72df321; the Generate panel's Audio→Voiceover mode is a redirect (`VoiceoverRedirect` → `openAudioSubTab`), not a re-implementation. Regression-locked by `e2e/voiceover-single-ui.e2e.ts` (3 specs).
- (export mixdown does not honor `volume` keyframes — ALREADY FILED by L0 as **BUG32**; not re-filed.)
- (`/beta-gate` `build:e2e` prerender failure — ENVIRONMENTAL per L0's clean main build; not a queue row.)

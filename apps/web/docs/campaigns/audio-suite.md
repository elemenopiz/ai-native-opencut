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

- [x] Recon done; campaign log written.

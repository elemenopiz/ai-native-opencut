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

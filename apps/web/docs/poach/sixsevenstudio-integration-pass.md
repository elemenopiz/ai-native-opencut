# sixsevenstudio integration pass: file-by-file comparison

Systematic comparison of `palmier-io/sixsevenstudio` (MIT, Copyright (c) 2025
Palmier) `src/` against our `apps/web/src/`, run after the first two poach
phases landed (polling store, consistency prompt, remix verb, UGC playbooks —
see `THIRD_PARTY_NOTICES.md` at the repo root). Goal: find anything of real
value NOT yet captured, and record what was deliberately skipped so future
passes don't re-litigate it.

**Outcome: one small port** — `apps/web/src/components/studio/remix-popover.tsx`
(the manual Remix UI affordance, ~90 upstream lines). **Everything else is
DOCUMENT-only.** With this, sixsevenstudio is considered fully mined: every
remaining file is either already poached, already covered better by our
OpenCut-derived stack, or Tauri/OpenAI-specific plumbing with no reusable core.

## What was compared

All of upstream `src/`: `lib/openai/{video,image,auth}.ts`, `lib/ai-sdk.ts`,
`components/storyboard/*`, `components/videos/*`, `components/chat/*`,
`components/editor/*`, `components/tabs/*`, `components/VideoSettings.tsx`,
`hooks/*` (incl. `hooks/tauri/*`), `stores/useVideoStatusStore.ts`, `types/*`,
`pages/*` — against our `components/studio/*`,
`components/editor/panels/assets/*` (esp. `views/director.tsx`),
`components/editor/panels/properties/generative-clip-properties.tsx`,
`lib/studio/*`, `lib/director/*`, `hooks/*`, `stores/*`.

## What was ported

### `components/studio/remix-popover.tsx` (new, self-contained, unwired)

From upstream `src/components/videos/RemixPopover.tsx`. The remix VERB was
already poached (`lib/studio/remix.ts` → wired into `director-api.ts` as the
agent-facing `remix` tool), but `remix.ts`'s own header flags the open gap:
no manual "Remix" button on a take for users who don't go through the agent.
This is exactly upstream's affordance — Sparkles button → popover → one
delta-prompt textarea ("describe the change, not the whole prompt") → confirm.

Translation to our model: upstream emits only the raw delta string because
Sora has a server-side `videos.remix(videoId, prompt)` endpoint. BytePlus
ModelArk has no edit endpoint, so our component goes one step further and
emits the ready-to-submit `GenerationSpec` too — it takes the prior `Take`
(`types/timeline.ts`), runs the delta through `buildRemixSpec` (delta composed
onto the original prompt, seed carried with `seedLocked: true`, reference
image re-anchored), and hands the caller `{ spec, remixPrompt }`. Callers
enqueue the spec through their existing generation path.

Deliberately NOT wired (wiring is always a separate reviewed phase; see the
`WIRING TODO` in the file):

1. `generative-clip-properties.tsx` — render it per take (or beside
   "Re-roll · +1 take") and enqueue via the already-imported
   `useSlotGeneration().generateIntoSlot`.
2. Optionally `components/studio/take-card.tsx`'s hover action overlay.
3. Pass a "last frame of completed take" as `anchorImageUrl` once that
   extractor exists (matching TODO in `lib/studio/remix.ts`).

`THIRD_PARTY_NOTICES.md` (repo root) updated with the new file under the
existing sixsevenstudio entry.

## What was examined and NOT ported, and why

| Upstream | What it is | Why skipped |
|---|---|---|
| `lib/openai/video.ts`, `image.ts`, `auth.ts` | OpenAI Sora/GPT-Image adapter | Checked specifically for retry/backoff, error normalization, request-shaping conventions worth stealing: there are none. It's a thin SDK wrapper whose only "error handling" is re-wrapping messages (`throw new Error(\`Failed to X: ${msg}\`)`) — our `lib/studio/provider-adapter.ts` already does the equivalent (`BytePlus submit failed ${status}: ${text}`). No retries anywhere upstream. The one non-trivial bit (resize reference image to target dims before submit) is Tauri-native `invoke("resize_image")`; our `reference-upload.ts`/R2 path owns that concern. |
| `lib/ai-sdk.ts` (`SYSTEM_PROMPT`, `createStoryboardTools`) | Global-context block + storyboard tool-call loop | Already poached in prior phases: `<global_context>` → `lib/director/consistency-prompt.ts`; the tool loop CONCEPT → `lib/director/agent.ts`'s ReAct loop + `director-api.ts` verbs (read-before-write guidance, confirm-with-details, max-steps guard all present). The only unpoached fragment is Sora-specific content-restriction prose — inapplicable to Seedance. |
| `components/storyboard/*` (`SceneList`, `SceneDetailCard`, `OverviewCard`, `TextEditor`) + `tabs/StoryboardTab.tsx` | Scene-list storyboard UI | Our `views/director.tsx` Direct mode (shot-list → slots → generate-all) plus `generative-clip-properties.tsx` (per-slot prompt/duration/seed/cost editing, takes filmstrip) covers the same surface on a richer data model (slots ARE timeline clips; theirs are markdown files). Two small UX ideas noted, not ported: (a) reel-level totals (Σ duration, Σ estimated cost across all slots) in one overview row — ours shows cost per slot only; (b) paste-image-from-clipboard directly onto a scene's reference-image slot. Both are wiring-level features on existing code (`lib/studio/cost.ts`, `reference-media-uploader.tsx`, `use-paste-media.ts`), nothing worth carrying as adapted code. |
| `components/videos/RemixPopover.tsx` | Manual remix affordance | **Ported** (above). |
| `components/videos/VideoGalleryItem.tsx`, `VideoStatus.tsx`, `VideoDetails.tsx`, `VideoGallery.tsx`, `VideoPlayer.tsx` | Gallery cards with polling overlays, metadata panel | Our `take-card.tsx` + `generative-clip-properties.tsx` TakeThumbs already have the generating/failed overlays, hover actions, and seed/resolution metadata. Their remix-provenance fields (`remixed_from_video_id`, `remix_prompt`) are a good idea already tracked as the "generation-provenance panel" idea (#12) in `palmier-idea-poaches.md` — a `Take.spec` change belongs to that work, not this pass. |
| `tabs/VideosTab.tsx` | Regenerate/remix/delete handlers | One nuance noted: regenerate REPLACES a failed video but ADDS a sample when regenerating a successful one, and deletes the provider-side artifact fire-and-forget. Our re-roll always adds a take (takes are never destroyed on selection — deliberate, our model is better); the failed-take-replacement nuance is a one-line behavior choice, not poachable code. |
| `stores/useVideoStatusStore.ts`, `hooks/use-video-polling.ts` | Poll-until-done store | Already poached (`stores/generation-status-store.ts`, `hooks/use-generation-polling.ts`). Re-verified: nothing left in them we didn't take. |
| `hooks/use-ai-chat.ts` | ai-sdk `useChat` + custom transport + max-steps | Their transport trick (client-side `streamText` behind a fake `fetch`) is an artifact of Tauri having no server; we have API routes. Max-steps guard and step logging already exist in `agent.ts`. |
| `hooks/tauri/use-editor-state.ts`, `use-editor.ts`, `use-projects.ts`, `use-storyboard.ts` | Editor/project persistence | Their editor state is a simplified descendant of OpenCut's own pattern (their `splitClip` comment literally cites "Following OpenCut's pattern"). We ARE the upstream of that idea; nothing flows back. Persistence is Tauri `invoke` → JSON files; ours is the OpenCut storage layer. |
| `hooks/tauri/use-waveform-cache.ts` (+ `use-sprite-cache`) | Width-keyed waveform/sprite caches over ffmpeg | Backed by native ffmpeg commands; our `use-filmstrip.ts` + `audio-waveform.tsx` (wavesurfer/Web Audio) already cover this — see `ffmpeg-reference.md`, which documented these same Rust commands as DOCUMENT-only. The width-keyed-cache-with-in-flight-dedup pattern is nice but ~30 lines to write fresh when needed; not worth an attributed port. |
| `components/chat/*` (`ToolCallDisplay`, `MemoizedMarkdown`, `ChatMessages`) | Chat UI | `director.tsx` already renders per-step tool-call status lines (✅/⚠️ per action) and full markdown messages. Their `ToolCallDisplay` is a 40-line status row — nothing we lack. |
| `components/VideoSettings.tsx` | Model/resolution/duration/samples form + `calculateCost` | Covered by `lib/studio/cost.ts` + `lib/studio/options.ts` + the spec editor in `generative-clip-properties.tsx` (live cost estimate included). Their per-model resolution table shape was already poached into `lib/studio/model-capabilities.ts`. |
| `types/constants.ts`, `types/transitions.ts`, `types/video-editor.ts` | Model tables, 4 transition types, simplified clip types | Model tables already poached (`model-capabilities.ts`); our transition and timeline types are supersets. |
| Keyboard shortcuts / state persistence in their stores & hooks | — | Checked explicitly: upstream has essentially none (one zustand store total, no keybinding system). Our `keybindings-store.ts` + `use-keybindings.ts` + `stores/keybindings/` are far beyond it. Nothing to take. |

## Verification

`cd apps/web && bun x tsc --noEmit -p tsconfig.json` — exactly the 12
pre-existing baseline errors (`Property 'X' does not exist on type '{}'` in
`src/app/api/studio/*/route.ts`, the known Drizzle schema-inference issue),
no new errors. Biome lint (root `biome.json` config) on the added file:
`Checked 1 file in 8ms. No fixes applied.` — no diagnostics. (Note: the repo's
`bun run lint:web` script currently exits 127 because `@biomejs/biome` is not
a declared dependency anywhere — pre-existing, unrelated to this pass.)

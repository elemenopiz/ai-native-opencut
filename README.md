# Byorn

**An AI-native video editor with a real timeline.** Generate shots, cut them, and
export a finished file — in one browser tab, no round-trip to Premiere.

Byorn is a fork of [OpenCut](https://github.com/OpenCut-app/OpenCut) that adds a
generation-first workflow on top of a genuine multi-track NLE: a **Director** agent
that plans a reel and drives ~48 timeline verbs, generative **slots and takes**
alongside real media, persona **seed-lock** for character continuity, and export
that carries generation provenance.

## Why this exists

The AI video field split in two. Generators make beautiful five-second clips and
then hand you off to a desktop NLE. Editors cut footage and know nothing about
generation. Byorn is the timeline that understands where a clip came from — so
"reroll shot 3 a little wider" is one instruction, not an export/regenerate/reimport
loop.

## What's in the box

| | |
|---|---|
| **Timeline** | Multi-track NLE — trim, split, ripple, groups, keyframes with bezier easing, masks, 22 hand-authored WebGL transitions, LUT color |
| **Director** | Phase-scoped agent (briefing → production → polish) over ~48 verbs: storyboard, propose, generate, reroll, cut-on-beat, tighten-to-length, duck-music-under-speech, export |
| **Generation** | Pluggable backend registry — one adapter file per provider, routed by slot intent, with honest per-generation cost shown *before* you press the button |
| **Identity** | Personas + seed-lock, so a character survives a model switch |
| **Local-first AI** | In-browser Whisper captions and CLIP visual search — $0, no upload |
| **Export** | Real h264 + aac encode, verified A/V sync, generation provenance in a sidecar |

## Architecture

```
apps/web           Next.js app — editor, Director, API routes
packages/env       Zod-validated environment schema
packages/ui        Shared components
services/*         Optional Python sidecars (whisper, clip, face, tts, speaker…)
```

The editor runs on a singleton `EditorCore` with specialized managers
(`playback`, `timeline`, `scene`, `project`, `media`, `renderer`). React reads it
through the `useEditor()` hook. See [`AGENTS.md`](AGENTS.md) for the full map.

### Adding a generation provider

Every provider implements one interface and self-registers:

```ts
registerBackend({
  id: "my-provider",
  modality: "video",
  capabilities: { supportsSeedLock: true, intents: ["character-video"], … },
  isAvailable: () => Boolean(webEnv.MY_PROVIDER_KEY),
  estimateCost: (req) => ({ credits, usd, basis }),
  submit: async (req) => ({ jobId, status }),
  poll:   async (jobId) => ({ jobId, status, mediaUrl }),
});
```

One file, one `registerBackend()` call, no other edits — the router, registry and
UI pick it up automatically. Adapters are **server modules** and never ship keys to
the browser. An adapter with no key configured is `isAvailable() === false`: real,
complete code that stays inert until someone sets the key.

## Development

```bash
bun install
bun run dev:web        # editor at localhost:3000
bun run test           # unit suite
bun run lint:web
```

The Python services in `services/` are optional — the editor runs without them;
local captions and visual search degrade gracefully when they're absent.

## License

MIT. Third-party code and algorithm reimplementations are tracked in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) and
[`POACH-LEDGER.md`](POACH-LEDGER.md).

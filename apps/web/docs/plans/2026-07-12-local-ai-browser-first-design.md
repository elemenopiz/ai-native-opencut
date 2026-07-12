# Local AI, Browser-First — Design

**Date:** 2026-07-12
**Status:** Approved (brainstorm session with owner)
**Decision:** Kill the Python/docker local-AI stack for all users. Understanding models move
in-browser (WebGPU/WASM, the shipped Whisper pattern); generative work stays on cloud provider
APIs; small utilities get hosted routes or are hidden for beta. `services/` is deleted entirely
once replacements land.

## Problem

"Local AI" today means `services/ai-backend` (FastAPI, :8420) fronting eight Python
microservices (Ollama, Whisper, TTS/XTTS, image gen, speaker/pyannote, face, CLIP, TurboQuant),
runnable only via a ten-container `docker compose up` with multi-GB model pulls. The in-app
"AI setup guide" literally shows users docker commands. That is not a regular-user path, and it
never will be.

Scrutiny of each service against "users call better models via API for generation" produced:

| Service | Powers | Verdict |
|---|---|---|
| Ollama (LLM) | text-editing panel, commit messages | **Kill** — `/api/llm/*` cloud routes are better |
| TurboQuant (quantized LLM) | alt local LLM tier + model manager UI | **Kill** — same |
| image-service (SD) | local image gen | **Kill** — studio already routes stills multi-provider |
| whisper-service | transcription | **Kill** — in-browser Transformers.js Whisper shipped on main |
| tts-service (XTTS) | voiceover takes default | **Kill local** — flip default to the existing cloud per-segment route, credit-metered |
| clip-service (CLIP ViT-B-32) | visual/semantic library search | **Keep local → move in-browser** |
| face-service (ArcFace-class) | persona/face identity | **Keep local → move in-browser** (deliberate privacy decision) |
| speaker-service (pyannote) | podcast-clip speaker labels, dubbing | **Defer** — won't fit in a browser sensibly; hide dependent features for beta |
| ai-backend orchestrator | denoise, YouTube download + clip detection, engagement scoring, glue | **Split** — engagement → LLM routes; YouTube → small hosted route (or hide, see open questions); denoise → hidden for beta |

## Why not the two obvious alternatives

- **Byorn-hosted understanding**: weighed fully in the next section (revised — the tradeoff
  is closer than this doc's first draft claimed, so we're buying a hedge).
- **Native Mac engine**: weeks of packaging/notarization/auto-update work, an install step,
  Mac-only, with beta 1–2 weeks out. The models worth keeping local are small enough for the
  browser; the browser IS the user's local device. Revisit native only if beta shows users
  hitting an indexing-speed wall on large libraries.

Bonus: browser-first makes the platform question moot (Mac + Windows for free).

## Server-side understanding: what it would buy, and why browser still wins (revised 2026-07-12)

A shared Byorn inference server (or a third-party embeddings API) is genuinely attractive, and
the gains deserve an honest record — they're the mirror image of the costs of crowding the
user's browser:

- **Zero editor contention.** In-browser inference shares the GPU with the WebGL compositor
  and CPU cores with video decode; server-side, playback fps is untouchable by AI work.
- **Uniform speed on every machine.** No WebGPU-less/low-RAM slow path, no laptop battery
  drain; the weakest user's library indexes as fast as the strongest's.
- **No model download or cold start.** Skips the ~340MB first-use pull and per-session model
  load entirely.
- **Bigger models.** Server GPUs fit CLIP variants (and pyannote diarization, currently
  deferred) that a browser never will; model upgrades ship centrally, every user improves
  overnight.

And one correction to this doc's first draft: **"uploading tens of GB" overstated the data-
gravity cost.** Frame/audio sampling happens in-browser either way; a hybrid would upload only
downsampled samples (224px frames, 16kHz mono) — megabytes per asset, not gigabytes.

Why the browser-first decision stands anyway:

1. **Face is biometric data — non-negotiable local.** Shipping face crops or embeddings to any
   server puts us under BIPA-class biometric-privacy law (consent, retention, deletion
   obligations). The "deliberate privacy decision" is also a legal-exposure decision. Face
   never flips server-side.
2. **Marginal cost.** Understanding runs over entire libraries — our highest-volume inference.
   Local is $0/user forever; server-side is a permanent per-user COGS line at a stage with no
   pricing model.
3. **The server doesn't exist and beta is 1–2 weeks out.** GPU serving (queueing, autoscaling,
   abuse controls) is weeks of infra. The realistic near-term variant is a third-party
   embeddings API — viable, but per-call cost plus footage samples flowing to a third party.
4. **The differentiator.** "Your footage never leaves your device" survives only in the local
   design; even sample-upload hybrids soften it to a caveat.

**The hedge we're buying (new in this revision):** the consumer seam (`embedText`/`embedImage`
and the understanding pass's frame-embedding calls) stays **backend-swappable** — the local
CLIP worker and a hosted-API client implement one interface, and sampling/extraction is
identical either way. Flipping CLIP to a server later is a config change, not a rebuild.
Flip triggers: beta users hit an indexing-speed wall on WASM-class hardware; editor contention
the scheduler (below) can't fix; or an owner call that COGS is worth instant-on. Face is
excluded from the flip (point 1).

## Architecture

Four homes, one rule: *does it touch private footage, and can it fit in a browser?*

1. **In-browser understanding** (WebGPU, WASM fallback): Whisper (shipped), CLIP embeddings
   (new), face embeddings (new). Models downloaded on first use with progress UI, cached in
   browser storage. Footage never leaves the device.
2. **Cloud provider APIs** (existing, credit-metered): LLM, image, video, and now TTS voiceover.
3. **Byorn-hosted utility routes** (no private data): YouTube download + clip detection
   (yt-dlp wrapper), engagement scoring via existing LLM routes.
4. **Deleted**: the entire `services/` Python stack. No demoted power-user path — unmaintained
   double paths rot and confuse. docker-compose is trimmed to `db`/`redis`/`serverless-redis-http`/
   `web` (that remains the whole-app self-host story), AI containers removed.

## Components

### New: `lib/local-ai/` worker framework
Generalize the shipped Whisper worker into a small shared framework:
- model download w/ progress + Cache API storage, resumable/retryable
- WebGPU detection with WASM fallback ("slower device" notice)
- a single load queue so low-RAM machines never hold two models at once
- **editor-has-priority scheduler**: understanding inference runs only while the editor is
  idle or paused — active playback, scrubbing, or export pauses (or heavily throttles) worker
  inference, since in-browser models share the GPU with the WebGL compositor and CPU cores
  with video decode. Playback fps is the top-priority workload; AI never competes with it.
- **idle unload**: models are released after a period of no use instead of staying warm for
  the whole session (today's Whisper worker holds ~hundreds of MB resident forever after first
  use — on unified-memory Macs that's the same pool as video frames and GPU textures). Reload
  from Cache API is cheap.
- Whisper worker refactors onto it (transcription output unchanged; it gains the scheduler
  and idle-unload behavior above)

### New: CLIP worker
Transformers.js `clip-vit-base-patch32`-class (~340MB cached). Replaces
`aiClient.embedText`/`embedImage`; `use-visual-search.ts` and the understanding pass's
frame-embedding calls repoint to it. Vector search over locally stored embeddings is already
local — unchanged. Consumers call the embedding *interface*, never the worker directly, so a
hosted-API backend can slot in later (see the server-side hedge above).

### New: face worker
ONNX Runtime Web, ArcFace-class embeddings. Replaces face-service calls in
`asset-understanding-service.ts`. **Open blocker: license-clean weights selection**
(pre-existing decision from director face-identity work, now beta-blocking).

### Rewired
- Voiceover: `generate-voiceover-take.ts` default flips from local XTTS to the existing cloud
  per-segment route, metered like video takes.
- Engagement scoring → `/api/llm/*`.
- YouTube import → new hosted route wrapping yt-dlp (auth-gated, rate-limited, house
  `fetchWithTimeout` patterns) — pending the open question below.

### Hidden for beta (feature-gated, no dead buttons)
Speaker diarization labels, dubbing, denoise. Each gate renders the existing
"feature unavailable" affordance, not a broken control.

### Deleted in the final sweep
`services/` (all nine), AI entries in docker-compose(.gpu), `ai-setup-guide.tsx`,
`use-service-health.ts` + `SERVICE_DOCKER_COMMANDS`, TurboQuant model manager, `/models` page,
dead `ai-client.ts` surface, `NEXT_PUBLIC_*_SERVICE_URL` + `BYORN_*` service env vars from the
env schema and `.env.example`. Tag main before the sweep.

## Sequencing (delete-last, so nothing breaks)

1. `lib/local-ai/` framework + CLIP worker + face worker; repoint consumers; verify visual
   search + persona matching in-browser.
2. TTS default flip; engagement → LLM routes; YouTube route decision (host or hide);
   feature-gate diarization/dubbing/denoise.
3. Deletion sweep (tag first), env-schema cleanup, DEPLOY.md truth pass
   ("local FastAPI backend" paragraph goes away), onboarding/copy pass (Local-AI honesty step).

Each step lands atomically with the house gate: tsc 0, full unit battery, prod build,
`detect_changes` scope check.

## Error handling

- Model download failure → toast with retry; feature stays in "not ready" state, never half-on.
- WebGPU unavailable → WASM fallback + one-time notice; if even WASM init fails, the feature
  degrades to its existing "offline" affordance.
- Worker crash/OOM → queue restarts worker once, then degrades with telemetry via the
  existing `reportError` seam.

## Testing

- Unit: mock-the-worker-seam pattern (as Whisper does) for CLIP/face clients; gating tests for
  hidden features.
- E2E: one smoke — visual search returns results on the WASM path (deterministic, no GPU in CI).
- Sweep gate: full battery + grep proving no `localhost:84xx` / service-URL reference survives.

## Open questions (flagged, non-blocking to start step 1)

1. **ArcFace-class license-clean weights** — must resolve before the face worker ships.
2. **Host yt-dlp or hide YouTube import for beta?** Hosting has ToS/abuse surface; hiding is
   one gate. Owner call at step 2.
3. Post-beta candidates if users ask: in-browser denoise (DSP worker), native engine for
   large-library indexing speed, browser diarization alternatives.

# Audio generation (backend)

Backend-only pass. Two non-interchangeable audio backends, following the same
`GenerationBackend` adapter pattern as video/image (`lib/studio/backends/`):

| Action  | Backend             | Vendor      | What it does                                                    | Env key(s)                       |
| ------- | -------------------- | ----------- | ----------------------------------------------------------------- | --------------------------------- |
| `score` | `fal-mmaudio`         | fal.ai      | Video-to-audio: synced ambience/foley for a video, ~30s max       | `FAL_KEY` (shared with Pika)      |
| `music` | `elevenlabs-music`    | ElevenLabs  | Text-to-music: prompt + optional lyrics, instrumental toggle      | `ELEVENLABS_API_KEY`              |

Both adapters are real, complete code that stay inert (`isAvailable() === false`)
until their key is set — the founder needs to provision `FAL_KEY` (if not
already set for Pika) and `ELEVENLABS_API_KEY` before either backend goes live.

## API

`POST /api/studio/audio` — submit. Body:

```jsonc
{
  "action": "score" | "music",
  "prompt": "string (required)",
  "videoUrl": "string (required for \"score\" — a source video to score)",
  "duration": 8,            // seconds; clamped to the backend's durationRangeSec
  "instrumental": false,    // "music" only
  "lyrics": "string",       // "music" only, ignored when instrumental
  "seed": 42,                // optional
  "model": "fal-mmaudio"    // optional manual pin, must match the action's intent
}
```

Returns `{ id, jobId, action, status, resultUrl, provenance, cost }`. `id` is
the internal `audio_jobs` row id (also the credit-hold ref); `jobId` is the
provider's job id, used to poll.

`GET /api/studio/audio/[jobId]` — poll (MMAudio is async via fal.ai's queue;
ElevenLabs Music is synchronous and already terminal from the POST response,
but polling it just returns the cached row). Ownership-checked against the
signed-in user via the `audio_jobs.owner_id` column (see migration
`0010_audio_jobs.sql`).

Both routes follow the exact reserve → submit/poll → settle/release credit
shape as `/api/studio/generate` and `/api/studio/image` (`lib/credits/metering.ts`,
`lib/credits/ledger.ts`), and are login-gated the same way.

## Pricing (COGS, zero markup — `lib/credits/cost-table.ts`)

- `fal-mmaudio`: fal.ai lists MMAudio V2 at ~$0.001/generated-second →
  0.1 credit/sec, rounded up, 1-credit floor. A 30s (max) score = 3 credits.
- `elevenlabs-music`: ElevenLabs Music is $0.15/minute → $0.0025/sec →
  0.25 credit/sec (≈15 credits/min), rounded up, 1-credit floor.

`costFor(backendId, "audio", { seconds })` throws on an unknown backend —
same fail-loud-never-$0 property as video/image.

## MMAudio output is a VIDEO, not standalone audio

fal's `mmaudio-v2` returns the **source video re-muxed with the generated
audio track** (`{ video: { url } }`), not an audio-only file. A future UI/
export pass that wants the audio track alone must extract it (e.g. during
export mux, or client-side via WebCodecs/ffmpeg.wasm) — not built in this
pass.

## TODO — client span-proxy upload flow (score mode, NOT built in this pass)

`fal-mmaudio` takes a `videoUrl` today and does nothing to produce one. The
intended client flow, for a later UI wave:

1. User picks a timeline span to score (e.g. a scene needing ambience).
2. Client renders a **short, audio-stripped, low-res (≤360p) proxy** of just
   that span — cheap to encode, fast to upload, and avoids leaking any
   existing audio track into MMAudio's conditioning.
3. Client uploads the proxy through the existing `/api/studio/upload` path
   (same R2 rehost seam image/video reference uploads already use) and gets
   back a durable URL.
4. Client calls `POST /api/studio/audio` with `action: "score"` and that
   URL as `videoUrl`.
5. On completion, the returned video (source + generated audio) is muxed
   back against the ORIGINAL full-res span on export — the low-res proxy is
   only ever used to drive generation, never composited into the final cut.

None of steps 2–3 (the proxy renderer) exist yet. This route accepts any
already-uploaded, already-durable video URL today — a hand-crafted request
(or a quick internal test) can exercise the full submit→poll→credit cycle
without the proxy renderer being built.

## Deliberately out of scope for this pass

- UI (Audio tab, generation form, results panel) — later wave.
- DB persistence beyond the minimal `audio_jobs` table (no board/timeline
  attachment, no "promote" flow).
- `composition_plan`-based precise lyric/section timing for ElevenLabs Music
  (current adapter folds `lyrics` into the plain `prompt` field — real
  ElevenLabs feature, looser fidelity than the structured path).
- Standalone prompt-to-SFX (explicitly skipped per the research verdict).
- Google Lyria (text-to-music, Gemini API family) — a candidate third audio
  backend if ElevenLabs Music ever needs a cheaper/alternate text-to-music
  option, and would share `GEMINI_API_KEY` with Veo/Imagen/Nano Banana. Not
  integrated in this pass — noted here for a future audio-backend wave, not
  scoped/priced yet.

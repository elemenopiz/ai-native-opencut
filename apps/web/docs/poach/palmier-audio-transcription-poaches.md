# Palmier audio/transcription/captions poaches — build-order guide

Architectural ideas worth taking from **Palmier Pro** (`palmier-io/palmier-pro`)
for our audio, transcription, captions, and playback stack, sibling to
`palmier-idea-poaches.md` and `palmier-mcp-schema-spec.md` (read both first —
this doc does not repeat their Agent/Tools-layer findings).

> **License boundary — read first.** `palmier-pro` is **GPL-3.0** (Swift). Our
> web app is MIT. **Do not copy any code, types, schema JSON, parameter names,
> or literal strings** from `palmier-pro` — GPL-3.0 is copyleft and would force
> us to relicense. Every recommendation below is an *idea/architecture* poach,
> reimplemented from our own understanding, in our own code and language
> (TypeScript/Web Audio/MediaRecorder instead of Swift/AVFoundation/CoreML).
> `palmier-skills` (the `ugc-editing` skill referenced below) is **Apache-2.0**
> — its *text* could in principle be adapted directly, but per scope this doc
> only *documents* what it covers; it is **not ported** here (see the note at
> the end).

**Sources read:** `Sources/PalmierPro/Audio/` (10 files: `WaveformExtractor`,
`AudioEnvelope`, `AudioEnhancer`, `AudioSyncCorrelator`, `AudioTrackReader`,
`Analysis/VoiceActivity`, `Analysis/SpeechMaskStore`, `Analysis/SpeakerIdentity`,
`Beats/BeatDetector`, `Beats/BeatStore`); `Sources/PalmierPro/Transcription/`
(6 files: `Transcription`, `TranscriptCache`, `CloudTranscription`,
`TranscriptSearch`, `TranscriptionBackend`, `WordCutPlanner`);
`Sources/PalmierPro/Preview/` (13 files, focused on `VideoEngine` and
`CompositionBuilder` — the playback core comparable to ours);
`palmier-skills/skills/ugc-editing/SKILL.md`.

---

## Correction to the brief: this is not a greenfield build

The task that generated this doc assumed we have **zero** audio/transcription/
caption pipeline. That's wrong, and it changes the shape of every
recommendation below, so it's worth stating plainly before the architecture
notes.

We have a **large, functional, but architecturally orphaned** legacy pipeline:

- **`services/ai-backend/`** — a FastAPI service, plus six sibling Docker
  services (`whisper-service`, `tts-service`, `speaker-service`, `face-service`,
  `clip-service`, `turboquant-service`), wired together in
  `docker-compose.yml`. It powers Whisper local STT with word timestamps,
  Sarvam AI cloud STT/TTS/translation (22 Indian languages), Smallest AI cloud
  STT/TTS (39 languages, speaker diarization + emotion detection), and
  multi-engine local TTS (Coqui XTTS v2 with voice cloning, StyleTTS2, Bark,
  Piper, Fish Speech, Kokoro). README.md documents all of it as a current,
  supported feature set (`README.md:36-59`, `README.md:222`).
- **Wired UI**, not stubs: `components/editor/panels/assets/views/captions.tsx`
  is a fully working transcribe → word-level-highlighted subtitle track flow
  (auto-splits the timeline at segment/speaker boundaries, auto-separates
  audio from muted video, supports multi-language translation tracks) and is
  a live tab in `assets/index.tsx`'s `viewMap`. `views/voiceover.tsx` drives
  the TTS engines. `panels/timeline/audio-effects-panel.tsx` has a real
  per-track effect-chain model (`type/params/enabled`, catalog-driven —
  see below). `panels/timeline/audio-waveform.tsx` renders via `wavesurfer.js`.
  Data model: `types/transcription.ts`, `stores/transcript-store.ts`
  (segments/words/speaker/emotion/translations), `lib/transcription/caption.ts`,
  `lib/transcription/speaker-captions.ts`.

**But it is completely disconnected from the Director/GenerationSpec/Take
spine** (`lib/director/*`, `types/timeline.ts`'s `Take`/`GenerationSpec`) that
is the actual current build focus per project memory (the AI-native pivot to
Byorn). Concretely:

1. It requires a 7-container Python/Docker stack running locally
   (`docker compose up -d`) to do anything — a completely different
   dependency shape from the direct-to-provider generation pipeline.
2. No Director verb exposes transcript, captions, or TTS to the agent — this
   matches `palmier-mcp-schema-spec.md`'s verdict (`get_transcript`,
   `remove_words`, `add_captions`, `generateAudio` are all still 🔺 gap
   there), and that verdict is *accurate*: the gap is agent-exposure, not
   underlying capability. The capability already exists in
   `services/ai-backend`; it just isn't reachable from `director-api.ts`.
3. TTS output isn't a `Take` — it carries no seed, no provenance, doesn't
   participate in `remix`/`reroll`, and isn't attached to a generative slot.
4. No denoise-as-a-discrete-operation exists anywhere (confirmed — grepped
   for it; `audio-effects.ts`'s catalog has `noise-gate`, which is a
   threshold gate, not spectral denoise).
5. Playback runs two independently-clocked timers instead of one (detail
   below) — this is the one piece the brief asked to compare directly.

So the real build-order question isn't "build transcription/TTS/captions from
scratch." It's: **(a)** decide the fate of the legacy `ai-backend` pipeline —
keep it as the STT/TTS compute layer (it's genuinely capable) or replace it;
**(b)** if kept, wire it into the Director/GenerationSpec spine using the
patterns below so takes, provenance, and the agent can see it; **(c)** adopt
the Palmier architecture pieces that are missing regardless of what happens to
`ai-backend`, because they're gaps in *design*, not in *compute*: a
stable-word-index transcript model an agent can safely cut against, waveform
data at the right two granularities, denoise as non-destructive, a
cached VAD mask reused across features, and independent beat detection.

---

## Build-order recommendations

### 1. Give the transcript model a stable global word index (P0, wire-existing)

**What Palmier does.** `Transcription.swift`'s `TranscriptionResult` carries
`words: [TranscriptionWord]` and `segments: [TranscriptionSegment]` as flat,
timestamped arrays — but the piece that matters for agent-driven editing is
`WordCutPlanner.swift`: word-level cut ranges are computed purely from
`(startFrame, endFrame, selected)` triples with **no dependency on segment
boundaries or original ordering**. The `ugc-editing` skill's `remove_words`
step passes raw word *indices* (or index ranges) into one batched call, never
frame numbers — "the agent never touches frame numbers — that's the whole
pitch" (`palmier-mcp-schema-spec.md`'s own framing, echoed by the skill).

**Why it matters for us.** `stores/transcript-store.ts`'s `TranscriptionSegment`
has per-segment `words` but no *stable, global* index — `captions.tsx` derives
per-word timing (`w.start`/`w.end`) but nothing external can address "word
#412" and have it survive a re-render or a partial edit. Without that, an
agent `remove_words` verb (a proposed build in `palmier-mcp-schema-spec.md`,
gated on "transcription lands" — it already has) has no addressable unit.

**How to implement.** In `types/transcription.ts`, add a flattened,
project-global `words: { index: number; text: string; start: number; end: number; segmentId: number }[]`
view alongside the existing segment array (computed once after transcription,
stored in `transcript-store.ts`). Port `WordCutPlanner`'s algorithm
conceptually: given selected word indices, walk runs of consecutive selected
words, compute a keep-gap on each side (tunable "tight/balanced/loose"
tightness, matching the skill's `cutAggressiveness` vocabulary), and emit
merged cut ranges via the existing ripple/gap-closing logic already used by
timeline splits. This is the concrete algorithm behind a future
`removeWords` Director verb — build it against `transcript-store.ts`'s data
even before that verb exists, since `captions.tsx`'s own "delete a sentence"
UX (referenced in README.md's "Edit by text" feature) would benefit from it
today.

### 2. Content-hash the transcript cache (P1, wire-existing)

**What Palmier does.** `TranscriptCache.swift` keys every transcript by
`path|mtime|size` (SHA-256'd), splits local vs. cloud variants (language +
range) into distinct keys, and — critically — **caches only the full-file
transcript**; a windowed request (`range:` param) always transcribes-once,
caches-once, then filters the cached full result (`TranscriptCache.filter`).
Re-transcribing a range no engine has seen yet still writes back to the same
full-file cache key.

**Why it matters.** `captions.tsx`'s `handleGenerateTranscript` always calls
the backend fresh — there's no check for "have we already transcribed this
exact file." Every re-open of the Captions tab, or every agent call once
`get_transcript` exists, re-pays the Whisper/Sarvam/Smallest cost. This is
pure waste for iteration-heavy AI-native workflows where a user might reopen
the captions panel repeatedly while editing.

**How to implement.** Add a small IndexedDB-backed cache keyed by
`mediaAssetId + fileSize + fileLastModified` (our analog of Palmier's
path+mtime+size) in `lib/transcription/` — check before calling
`aiClient.transcribe`/`sarvamTranscribe`/`smallestTranscribe`, store the full
result after. This alone makes the existing "Re-transcribe" button in
`captions.tsx` cheap to iterate against for free, with no backend changes.

### 3. Denoise as a non-destructive, blendable operation, not a bake-in (P1, new build)

**What Palmier does.** `AudioEnhancer.swift` runs a speech-enhancement model
over the *dry* audio and writes a separate *wet* file to a
content-hash-keyed disk cache — it never overwrites the source. At
composition time, `CompositionBuilder.insertDenoisedTwin` inserts the wet file
as a **second, parallel audio track** aligned to the same clip range, and
`emitVolumeEnvelope`'s `gain` parameter crossfades between wet and dry using a
single `denoiseAmount` (0–1) knob per clip: the wet twin plays at
`strength`, the dry original is attenuated to `1 - strength`. Disabling
denoise is instant (gain flips back to 1/0) with zero recomputation; changing
strength is a mix-time operation, not a re-render. The README even calls out
the *reason* for a conservative default: "full strength sounds gated."

**Why it matters.** This is the single cleanest idea in the whole Audio
directory and we have **nothing like it**. Our `audio-effects.ts` catalog
(`eq`, `compressor`, `noise-gate`, `reverb`, `de-esser`, `limiter`) is
already a good pattern — a typed registry with `createNodes(ctx, params)` — but
none of those are spectral denoise, and the catalog's whole model assumes
*live* Web Audio node chains, not a *baked, cached, crossfadeable second
signal*. A denoise model (client-side WASM, e.g. RNNoise, or a server-side
job) does not run in real time inside a `BiquadFilterNode` graph — it has to
produce a rendered buffer first, exactly like Palmier's approach.

**How to implement.**
- Add a denoise job (server route or client-side WASM/RNNoise) that takes a
  clip's source audio and produces a "wet" `AudioBuffer`/blob, cached by
  content hash (asset id + size/mtime), mirroring recommendation #2's cache.
- Extend the timeline element/track model with `denoiseAmount?: number` (0–1)
  and `denoiseEnabled?: boolean` per audio-bearing element, not per track —
  match Palmier's per-clip scoping.
- In `audio-manager.ts`'s `runClipIterator`, when `denoiseAmount > 0` and a
  cached wet buffer exists, schedule **two** `AudioBufferSourceNode`s for that
  clip's currently-playing buffer window (dry + wet) through two `GainNode`s
  set to `1 - strength` and `strength` respectively, instead of one. This is
  a direct, mechanical port of the wet-twin gain trick into our existing
  per-clip node-creation code (`audio-manager.ts:404-412`) — no new audio
  graph architecture required, just one more scheduled node per denoised
  clip.
- Add `denoise` as a new `AudioEffectType` in `audio-effects.ts`'s catalog
  for UI discoverability (slider = `denoiseAmount`), even though its
  `createNodes` implementation differs in kind (baked buffer, not a live
  filter node) from its siblings.

### 4. Waveform: two representations for two consumers (P2, mostly already fine)

**What Palmier does.** Two *separate* extractors exist on purpose:
`WaveformExtractor` (200 samples/sec peak-envelope, dB-normalized against a
-50dB noise floor, adaptive rate capped at 240k total samples for very long
files) is for **drawing** — it answers "what does this look like." Distinct
from it, `AudioEnvelope`/`AudioEnvelopeExtractor` (fixed 10ms hop, RMS not
peak) is for **analysis** — voice-activity gating, auto-duck triggers. The
design lesson: don't reuse a UI-oriented peak waveform for level-sensitive
decisions like ducking, and don't over-resolve a waveform meant only for
pixels.

**Why it matters.** Our `audio-waveform.tsx` uses `wavesurfer.js`, which
decodes the *entire* audio buffer client-side to extract peaks
(`extractPeaks` in the same file does its own naive max-per-bucket pass over
a full `AudioBuffer`) — fine for short clips, but it doesn't scale to long
imports the way Palmier's capped, adaptive-rate extractor does, and more
importantly **we have no separate analysis-grade envelope at all**.
`use-auto-duck.ts` exists today but keys ducking off Whisper *segment*
boundaries (speech-recognition units), not true silence/voice-activity — dead
air *inside* a recognized segment won't duck, and any speech Whisper failed
to transcribe won't duck either.

**How to implement.** Lower priority than #1 and #3 (wavesurfer.js is an
acceptable UI-layer choice for now), but when `use-auto-duck.ts` gets
revisited: add a lightweight RMS envelope extractor (same shape as
`AudioEnvelope` — fixed hop, `Float32Array` output) independent of the
transcript, and drive ducking off level crossings instead of segment gaps.
This is also the natural precursor to a real `removeSilence` verb (flagged
🔺 gap in `palmier-mcp-schema-spec.md`).

### 5. Cache the VAD mask once, reuse across features (P2, new build, gated)

**What Palmier does.** `VoiceActivity.swift` runs Silero VAD once per file,
caches a `{chunkCount, segments}` analysis (32ms cells) to disk keyed by
content hash, and exposes a derived boolean `mask: [Bool]`. Two unrelated
features consume the *same* cached analysis: silence removal, and
`SpeakerIdentity.swift`'s snippet selection (`speechSpans`) trims each
candidate voice snippet to VAD-confirmed speech before computing a fingerprint
embedding, so background noise doesn't pollute the speaker vector.

**Why it matters.** If/when we build a real VAD (recommendation #4's natural
extension), the design lesson is: compute it once per asset, cache it
content-hash-keyed (same infra as #2 and #3's caches — this argues for one
shared `lib/media/analysis-cache.ts` rather than three bespoke ones), and let
multiple features subscribe to the same mask rather than each rolling its own
silence heuristic.

**How to implement.** Build the shared cache module first (`analysis-cache.ts`:
`get<T>(assetId, kind)` / `set<T>(assetId, kind, value)`, IndexedDB-backed,
keyed identically across denoise/VAD/transcript/beats), then land VAD as one
consumer. Defer the actual VAD model choice (WASM Silero port exists) until a
real feature needs it.

### 6. Beat detection — independent of everything else, cheap, on-brand (P2, new build)

**What Palmier does.** `BeatDetector.swift` runs a bundled Core ML beat/
downbeat model directly on decoded PCM — **no transcription, no VAD, no
speech dependency at all**. Output (`bpm`, `beats: [Double]`, `downbeats`) is
disk-cached the same way as every other analysis here. This was already
flagged as an "honorable mention, independent!" build in
`palmier-mcp-schema-spec.md` — repeating it here because it's the one Audio
capability with zero dependency on the transcription stack, making it
buildable *this week* regardless of what happens to `services/ai-backend`.

**How to implement.** A small onset-detection pass (spectral flux + peak
picking, doable in Web Audio's `OfflineAudioContext` + a couple hundred lines
of DSP, or a small WASM beat-tracking lib) over an asset's decoded audio,
cached by content hash. Unlocks "cut my reel to the beat" — directly on-brand
for a reel-generation product, and requires no Director-verb work to ship as
a manual editor feature first (auto-place cut markers on the timeline ruler
at beat times).

### 7. TTS as a `Take`, not a side-channel (P0, wiring — the actual fix for the "voice-lock" gap)

**What's already flagged.** `lib/director/consistency-prompt.ts`'s header
documents a voice-lock mechanism marked un-wireable "because this repo has no
TTS/voiceover/dialogue pipeline yet." That statement is about the
*Director-integrated* pipeline, and on that narrow point it's correct — but
the underlying compute (Coqui XTTS v2 with voice cloning, Sarvam/Smallest
cloud TTS) already exists in `services/ai-backend` and is driven today by
`views/voiceover.tsx`, entirely outside `GenerationSpec`/`Take`.

**What Palmier does differently, worth adopting regardless of TTS provider.**
Their `generate_audio` tool (per `palmier-mcp-schema-spec.md`'s cataloguing)
has one design keeper: passing a *timeline span* auto-places the result on
the timeline at that span — no separate placement call, no orphaned asset the
agent has to remember to place.

**How to implement.**
- Model TTS output as an audio-typed `Take` attached to a generative slot
  (mirroring image/video takes), carrying provenance (voice id/clone
  reference, engine, script text, seed if the engine supports it) the same
  way `GenerationSpec` does for visual takes — this is what actually lets
  `consistency-prompt.ts`'s voice-lock concept attach to something.
  `views/voiceover.tsx`'s existing engine-selection UI (local/Sarvam/Smallest)
  can become the UI for setting up an audio `GenerationSpec` rather than a
  standalone panel.
  scoped, in-place execution once the audio-take shape exists.
- Follow Palmier's auto-place-on-span behavior: an agent-facing
  `generateAudio({ kind: "tts", prompt, voiceId?, span? })` verb should place
  the resulting take directly at `span` on submit, not return a bare asset id.

---

## Playback comparison (as requested — the one piece we do have)

**Palmier's model (`VideoEngine.swift` + `CompositionBuilder.swift`).** A
single `AVPlayer` is the one source of truth. `CompositionBuilder.build`
constructs one `AVMutableComposition` (video + audio tracks + volume/transform
"instructions") from the *entire* timeline in one pass, and `VideoEngine`
caches that composition keyed by structural equality of its inputs
(`RebuildInputs`: involved timelines, media URLs, asset sizes, missing-media
set) — an unrelated UI update that doesn't touch any of those fields is a
guaranteed cache hit, skipping composition rebuild entirely. Playback state
(`currentFrame`) is derived *from* `player`'s periodic time observer, not
maintained independently and pushed *into* the player. Seeking has two modes
— `exact` (zero tolerance, used for programmatic jumps) vs. `interactiveScrub`
(tolerance that scales with how many video layers are active at that frame,
throttled to 30fps dispatch) — a deliberate trade of seek precision for
scrub smoothness while dragging the playhead, tightening back to exact the
moment the drag ends.

**Our model (`playback-manager.ts` + `audio-manager.ts`).** Two independent
clocks: `PlaybackManager` runs its own `requestAnimationFrame` loop computing
`currentTime` from wall-clock deltas (with shuttle-speed support Palmier's
model doesn't have — J/K/L style, which is a genuine feature edge for us).
`AudioManager` does *not* read that clock directly during playback; instead it
snapshots `playbackStartTime`/`playbackStartContextTime` once at playback
start and schedules Web Audio buffer sources against `AudioContext.currentTime`
independently, resyncing via a drift-compensation heuristic
(`playbackLatencyCompensationSeconds`, `consecutiveDroppedBufferCount >= 5`
triggers a resync) rather than a single shared clock. The two are kept
loosely coupled via `playback-seek`/`playback-update` `CustomEvent`s on
`window`. This is a well-known class of bug surface in browser-based editors
(the two clocks drift on tab backgrounding, GC pauses, etc. — the resync
heuristic in `audio-manager.ts:414-452` exists precisely because of this) that
Palmier's single-`AVPlayer.currentTime`-as-truth model doesn't have, because
AVFoundation owns both audio and video scheduling under one clock natively.
We can't get that for free in a browser (no equivalent of AVComposition —
`<video>`/WebCodecs render video, Web Audio renders audio, and they are
genuinely two clocks at the platform level), but two pieces of the *shape*
are portable:

- **Rebuild-on-structural-equality, not rebuild-on-every-change.**
  `audio-manager.ts`'s `handleTimelineChange` unconditionally calls
  `disposeSinks()` and rebuilds `this.clips` on *any* timeline or media
  store event — even ones that don't affect audio (a text-element color
  change, say). Palmier's `RebuildInputs`-equality cache is a cheap, direct
  port: compute a lightweight fingerprint of "audio-relevant" timeline state
  (track audio clips + their trims/volume/mute + media URLs) and skip
  `disposeSinks()`/rescheduling when it's unchanged.
- **Scrub-tolerance scaling.** Our `setScrubbing`/seek path doesn't vary seek
  precision by scene complexity. Not urgent, but worth noting as the reason
  scrubbing a heavy multi-track timeline feels worse than a simple one — a
  cheap tolerance-scales-with-active-layer-count knob (Palmier's
  `interactiveTolerance`) is a plausible fix if scrub perf ever becomes a
  complaint.

---

## `ugc-editing` skill (Apache-2.0, `palmier-skills`) — documented, not ported

Per scope, this is catalogued only; do not port it in this pass. It's a
prompt-engineering playbook (not code) covering the **assemble → trim →
layout → caption** pipeline for UGC-style vertical video, explicitly
footage-source-agnostic (AI-generated or real phone footage). Structure:

- **Step 0 pre-flight:** force 9:16 *before* placing any clip (their canvas
  snaps to the first clip's aspect ratio — costly to fix after), inspect A-roll
  word timestamps as prose before cutting anything.
- **Step 1–2:** place A-roll only, then cut retakes/fillers/false starts/dead
  air via one batched word-index `remove_words` call (never sequential calls
  — indices shift after each cut) with a tunable `cutAggressiveness`
  (tight/balanced/loose) — directly the `WordCutPlanner` algorithm from
  recommendation #1 above, exposed at skill level.
- **Step 3:** choose one of four b-roll layout formats by *narrative role*
  (supplementary → straight intercut; proof → b-roll-top/talking-head-bottom;
  filler/retention → talking-head-top/b-roll-bottom; hero visual → full-bleed
  with floating head) — a decision framework, not just a transform preset
  list.
- **Step 4–5:** b-roll placement rules (never specify a track index — that's
  what auto-creates the correct stacked layer; muting b-roll audio
  immediately to avoid captions transcribing the wrong track) and
  `apply_layout` (the compound-op idea from `palmier-idea-poaches.md` #9) for
  the actual compositing.
- **Step 6:** caption placement rules keyed to the chosen layout (seam-centered
  for stacked splits, lower-third for full-frame), and a hard rule to always
  scope caption generation to A-roll clip ids only — the exact
  `indexStatus`/scoping lesson also shows up as "captions show b-roll
  dialogue" in their own failure-mode table.
- **Step 7 + failure-mode table:** verify via rendered-frame inspection
  (`palmier-idea-poaches.md` #10), plus nine named failure modes with root
  cause and exact fix each — the most concrete evidence anywhere in Palmier's
  material for *why* self-describing refusals and verify-after-mutate loops
  (both flagged in `palmier-mcp-schema-spec.md`'s cross-cutting mechanisms
  section) matter in practice.

This is a strong candidate for the same treatment as the two already-ported
UGC playbooks in `apps/web/src/lib/studio/playbooks/` — but it assumes a tool
surface (`add_clips`, `apply_layout`, `remove_words`, `add_captions`,
`set_project_settings`) that mostly doesn't exist yet in `director-api.ts`.
Porting the *playbook* productively should follow, not precede, building
enough of the underlying verbs (recommendations #1 and #7 above, plus the
`placeAsset`/`applyLayout` gaps already catalogued in
`palmier-mcp-schema-spec.md`) for the playbook's calls to resolve to real
tools.

---

## Priority summary

| # | Recommendation | Kind | Priority |
|---|------|------|----------|
| 1 | Stable global word index on the transcript model | Wire-existing | **P0** |
| 7 | TTS as a `Take` (audio-typed `GenerationSpec`) | Wire-existing | **P0** |
| 2 | Content-hash the transcript cache | Wire-existing | P1 |
| 3 | Denoise as non-destructive wet-twin blend | New build | P1 |
| 4 | Split waveform (UI) from envelope (analysis) | New build, low urgency | P2 |
| 5 | Shared content-hash analysis cache + VAD mask | New build, gated | P2 |
| 6 | Independent on-device beat detection | New build | P2 |
| — | `ugc-editing` skill port | Deferred | after #1/#7 + verb gaps close |

The two P0s are both *wiring*, not new capability — which is the headline
finding of this pass: the compute already exists in `services/ai-backend`,
and the highest-leverage work is making it a first-class citizen of the
Director/`Take`/`GenerationSpec` model, not building STT/TTS from nothing.

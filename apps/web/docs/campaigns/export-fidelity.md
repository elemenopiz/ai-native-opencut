# C24 · Export fidelity — "what you preview is what you export"

> Campaign log. Branch: `campaign/export-fidelity` (off main @6b4a1de2).
> L1 orchestrator worktree: `.claude/worktrees/agent-afa271bf73df7ae3a`.
> ID range: BUG40–BUG49. Budget ~120 min. Status tables record only what HAS happened.

## Objective

The founder hit this dogfooding: changing a clip's audio volume has NO effect on the
exported file. BUG32 (broadened): the export mixdown drops the ENTIRE gain path — static
per-clip volume AND volume automation keyframes (C9 auto-duck). BUG17: audio-only export
emits a blank 1920×1080 H.264 stream. Deliverable: fix BUG32 at "verified locally",
resolve BUG17, and land a preview-vs-export **fidelity matrix e2e**.

## Root-cause recon (verified in source, 2026-07-18)

- `apps/web/src/lib/media/audio.ts:22` — `CollectedAudioElement` **explicitly omits
  `volume`** from `AudioElement`; `collectAudioElements` (L127) never reads
  `element.volume`, the element's `volume` animation channel, or `track.volume`.
- `mixAudioChannels` (L701) sums raw source samples: `outputData[i] += sourceData[j]` —
  no gain of any kind is ever applied. Mute is honored (element+track), gain is not.
- Playback truth source (what export must match): `core/managers/audio-manager.ts` —
  static path gain = `clip.volume ?? 1` × track gain (`track.volume ?? 1`, L310);
  automation path = per-clip GainNode scheduled from the `volume` number channel via
  `buildVolumeAutomationPlan` (L53): linear ramps between keyframes, `hold`
  interpolation → step-set, anchor value from `getNumberChannelValueAtTime`, fallback
  `clip.volume ?? 1`. Keyframe `time` is element-local (0..duration) — same timebase as
  the mixdown's output slot, and **unaffected by pitch-preserving stretch** (slot
  duration is fixed; `resolveMixElement` normalizes stretched clips to rate-1/trim-0
  before mixing, so gain must be applied in the timeline/output domain).
- BUG17: `services/renderer/scene-exporter.ts:184` — `output.addVideoTrack` is
  unconditional; audio-only scenes still render+encode ~90 background frames.
- Call-site: `core/managers/renderer-manager.ts:166` passes `tracks`/`mediaAssets` into
  `createTimelineAudioBuffer` — the BUG32 fix is containable inside `audio.ts` with no
  signature change.
- E2E landscape: real-export pattern = `playwright.real-export.config.ts` (port 3211,
  `NEXT_PUBLIC_E2E_STUB_EXPORT=0`, `build:e2e:real`/`test:e2e:real`) +
  `e2e/real-export/golden-path-export.e2e.ts` (ffprobe recipe, base64 buffer pull).
  Codec-real runs need `channel: "chrome"` (pattern: `playwright.fixtures-w2.config.ts`,
  port 3212 — bundled Chromium lacks H.264/HEVC decode, silent fallback). Audio seeding
  pattern: `e2e/auto-duck-playback.e2e.ts` (+ `e2e/fixtures/tiny-tone.wav`). Unit-test
  home: `src/lib/media/__tests__/audio-mixdown.test.ts`.

## Plan — partition by file cluster (no shared files)

| Worker | Task | Owned files | Branch |
|---|---|---|---|
| W-A mixdown-gain | BUG32 fix: static clip volume × track volume + `volume`-channel automation envelope in the mixdown; sample-level unit tests | `apps/web/src/lib/media/audio.ts`, `apps/web/src/lib/media/__tests__/audio-mixdown.test.ts` | `task/c24-mixdown-gain` |
| W-B fidelity-matrix | Fidelity matrix e2e: per-clip volume, mute, volume automation, detached audio, speed+pitch, audio-only, masks/transitions/text frame probes; real export + ffprobe + decoded-PCM RMS windows; `channel: "chrome"` config | `apps/web/e2e/export-fidelity/**`, `apps/web/playwright.export-fidelity.config.ts`, `apps/web/e2e/fixtures/**` (new files only), `apps/web/package.json` (scripts only) | `task/c24-fidelity-matrix` |
| W-C audio-only-export | BUG17: suppress the video stream for exports with no visual content (documented call); unit coverage | `apps/web/src/services/renderer/scene-exporter.ts`, `apps/web/src/core/managers/renderer-manager.ts`, new test file beside them | `task/c24-audio-only-export` |

Sequencing: all three dispatched in parallel (disjoint files). W-B's BUG32/BUG17 matrix
cases are EXPECTED red on W-B's own branch (they assert the fixed behavior) — that red
run is the bug-evidence baseline; they must go green on the campaign branch after W-A and
W-C merge. L1 integrates worker branches into `campaign/export-fidelity` in this worktree
only, runs the battery (judged vs baseline: lint ~346e/225w no-worse; bun test
order-dependence fail-set ~52/5 files) + the matrix, and closes out.

Known fidelity gaps already spotted in recon, to verify/file in-range if not absorbed:
track pan (StereoPannerNode in playback, absent in mixdown), solo semantics, keyframed
(variable) speed curves (`hasVariableRate` fallback warns + uses base rate).

## Worker status (updated as events happen)

| Worker | Status |
|---|---|
| W-A mixdown-gain | DONE — `task/c24-mixdown-gain` @ae697a2a, diff-reviewed by L1, merged to campaign @846b840d. `CollectedAudioElement` + volume/trackVolume/volumeKeyframes; `computeVolumeEnvelope` forward-cursor walker parity-tested vs `getNumberChannelValueAtTime` (1e-6 over sampled points, linear/hold/eased); gain keyed on output-domain local time, applied pre-accumulation; playback path + resolveMixElement untouched. Verified on campaign tip by L1: `bun test apps/web/src/lib/media` 114/0. Worker detect_changes: low, 6 symbols, 0 affected processes |
| W-B fidelity-matrix | STALLED pre-commit (park-on-notification failure mode, twice: initial + one resume nudge); work SALVAGED by L1 per L0 ruling — spec/helpers/config + package.json script read+reviewed in its worktree, ported and committed to campaign @6b94ef8e. Spec quality high: 7 cases, correct assertion polarity (BUG32/BUG17 cases assert fixed behavior), measured-number logging throughout |
| W-C audio-only-export | in progress on `task/c24-audio-only-export` — scene-exporter.ts + renderer-manager.ts edits + new audio-only-export.test.ts present in its worktree (uncommitted); verification reported queued behind host contention |

BUG17 behavior call (L1 decision, given to W-C): suppress the video stream when the
scene has no visual content — audio-only MP4/WebM is valid and least surprising; keep
container/extension; "no visual + no audio" ⇒ fail fast with a clear error; GIF path
unchanged.

## Evidence

(collected as produced — decoded-sample numbers, ffprobe output, spec results)

## Bugs filed (BUG40–BUG49)

Verified in source by L1 before filing (deduped against queue §2 — none present):

- **BUG40** — Track PAN is applied in playback (`audio-manager.ts` StereoPannerNode per
  track; `track.pan` in `types/timeline.ts:87`) but silently dropped by the export
  mixdown (`createTimelineAudioBuffer` mixes straight L/R with no panning). Preview-vs-
  export fidelity gap, same class as BUG32. Fix home: `lib/media/audio.ts` mix path
  (constant-power pan per output channel).
- **BUG41** — SOLO semantics dropped on export: playback silences non-soloed tracks when
  any track is soloed (`audio-manager.ts:415` `isSoloMode`; `track.solo` in
  `types/timeline.ts:73,88`), but `collectAudioElements` only honors `track.muted` — an
  export made while a track is soloed includes ALL tracks. Product call embedded: should
  export honor solo (WYHIWYE) or ignore it as a monitoring-only affordance? Either way
  the current silent divergence is wrong; if solo is monitoring-only, playback/export
  should at least be documented as intentionally divergent.
- **BUG42** — Keyframed (variable) playbackRate curves fall back to constant base rate
  in the export mixdown (`mixAudioChannels` warns + uses base rate; flagged
  `hasVariableRate` in `resolveClipPlaybackRate`) while the preview renders the curve.
  Pre-existing, documented in code as "tracked as a follow-up" but never queued. With
  BUG32 fixed, the gain envelope is correct regardless (output-domain time), but the
  audio content itself diverges from preview for speed-ramped clips.

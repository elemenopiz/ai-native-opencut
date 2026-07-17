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
| W-A mixdown-gain | — |
| W-B fidelity-matrix | — |
| W-C audio-only-export | — |

## Evidence

(collected as produced — decoded-sample numbers, ffprobe output, spec results)

## Bugs filed (BUG40–BUG49)

(none yet)

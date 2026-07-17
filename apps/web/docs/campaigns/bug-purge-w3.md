# Campaign: bug-purge-w3 (C7 wave 3) — regression hunt over the integrated main

- **Branch:** `campaign/bug-purge-w3` off main @6cbcbef0
- **Run:** 2026-07-17 (complete)
- **Objective:** Regression-hunt the golden path after today's 15-campaign integration
  (Palmier-15, SSRF guard, MCP relay + board verbs, perf fps60 fix, char-consistency fold,
  export presets/GIF/captions, audio-suite reconcile, tenancy fix, BUG12 401 fix). Plus two
  surgical fix-forwards (BUG30, BUG31).

## Verdict up front

**NO golden-path regression found.** Every most-changed surface re-verified green on the
integrated tree. One NEW bug found (BUG33, captions download unreachable — low, not a
regression: gate predates today). BUG30 + BUG31 fixed, tested, merged to campaign branch.

## Part 1 — regression-hunt results (all driven on the integrated tree, chrome/Chromium real browsers)

| # | Surface (why hot) | Method | Verdict | Evidence |
|---|---|---|---|---|
| H1 | Golden path end-to-end | `happy-path.e2e.ts` on E2E build | **PASS** | ✓ open → slot → generate → lands → export kicks off (720ms) |
| H2 | REAL export → ffprobe (C11/C12 churn) | `real-export/golden-path-export.e2e.ts` on `build:e2e:real` | **PASS** | ✓ generate → trim+split → real export playable; ffprobe h264+aac in test output |
| H3 | Voiceover/audio reconcile holds (C9) | `voiceover-single-ui.e2e.ts` (3) + `audio-gen.e2e.ts` (2) + `auto-duck-playback.e2e.ts` (1) | **PASS 6/6** | single VoiceoverView canonical, mocked TTS lands on timeline, Generate-panel redirect works; Music/Score land; audible duck during real playback |
| H4 | Export presets + GIF + SRT/VTT valid files (C11) | unit (26/0: captions, gif encoder, export) + w3 harness UI drive → ffprobe | **PASS** (one adjacent find → BUG33) | TikTok preset → probed 1080x1920 h264; GIF export → `GIF89a` magic + ffprobe codec `gif`; SRT import lands both cues on a `Subs:` text track (shots w3-02/03/04) |
| H5 | Char-consistency fold on manual generate (C2) | `persona-consistency.e2e.ts` | **PASS** | ✓ one persona consistent across 3 generations + cross-project reuse (2.5s) |
| H6 | Anon editor survives background 401s (BUG12, C13) | `anon-editor-stability.e2e.ts` | **PASS** | ✓ 20.6s soak, no /signup redirect |
| H7 | MCP board verbs reachable (C3) | `src/lib/mcp/` suites 67/0 (incl. HTTP e2e-smoke, reliability, token-auth) + `director-board.test.ts` 31/0 | **PASS** (unit/smoke tier) | catalog board section live; no HTTP-server-level drive this wave |
| H8 | Heavy media: HEVC/HDR/portrait/alpha/audio-only + 60fps + large | `fixtures-w2-hunt.e2e.ts` 4/4 (chrome channel) + w3 harness: 60fps 1280x720 import→trim→split→export; 45MB 1080p30 import→preset export | **PASS** | fps60 asset probes fps:60, no decodeUnsupported, export h264+aac ~3.0s; large file imports clean; shot w3-01 |
| — | Takes/board routing invariants | `takes-board-routing.e2e.ts` I1–I5b | **PASS 7/7** | singles→Assets, batches→Board, 402 modal, resume dedup |
| — | Pitch-preserve speed ramp | `pitch-stretch.e2e.ts` | **PASS 2/2** | 440Hz stays 440Hz at 2x and 0.5x |

Suites: main e2e 18 passed / 0 failed (10 skips = auth-flow Upstash [known C6 chore],
real-export/fixtures/bug14 specs that self-skip under the stub config and were run
separately under their own configs).

### Unit-suite characterization (integrated main)

Full-suite `bun test` on the tip: 1720 pass / 52 fail / 39 errors — **all 5 failing files
pass 100% in isolation** (video-cache 33/0, add-to-editor 4/0, pitch-stretch 12/0, health
6/0, proxy-encoder-controller 15/0). The whole fail set is the known bun
`mock.module`/global-leak order-dependence class (queue chore C8), now slightly wider than
the documented 44 (also trips video-cache/add-to-editor/pitch-stretch in full runs). NOT a
regression: same code passes solo; no env dependency (reproduced with and without
`.env.local`).

### Incidental observations (noise-class, logged not filed)

- 8420 health-poll `ERR_CONNECTION_REFUSED` bursts still present all session (queue chore C5).
- BUG17 re-confirmed unchanged: audio-only export still emits a blank video stream.
- Anon editor's MCP bridge poll (`/api/mcp/bridge?projectId=…`) 401s into the console every
  cycle alongside `/api/studio/sets` — BUG18-class console noise, new caller since C3's
  relay merge. Candidate: silent-mode/anon-skip for the bridge poll (BUG18 umbrella).

### NEW bug filed

- **BUG33 (low/UX):** captions panel's "Export subtitle file" (Download .srt/.vtt) and
  "Subtitle tracks" sections are gated on transcript `segments.length > 0`
  (`views/captions.tsx:1061`), but `handleImportSubtitles` (line ~594) only creates a
  `Subs:` text track and never touches the transcript store — so an imported-subtitles-only
  project can never reach SRT/VTT export or see its track listed, even though
  `collectSubtitleCues` (lib/export/captions.ts) explicitly supports the timeline-track
  source as its PREFERRED source. Verified live: after `.srt` import, track lands with both
  cues but `Download .srt` is not rendered (shot w3-04). Fix = gate those sections on
  `segments.length > 0 || activeSubtitleTracks.length > 0` (or hasAnyCues). Not a regression
  (gate predates today); owner: captions panel (C4-B/C10-adjacent).

## Part 2 — fix-forwards (merged to campaign branch)

| Worker | Bug | Branch @ sha | Result |
|---|---|---|---|
| W-A (sonnet) | BUG30 MediaDragOverlay identical copy | `fix/bug30-drag-overlay-mode` @b095cc41 | `mode?: "empty" \| "drag-active"` prop (default empty); drag-active copy = "Drop files to import"; call site passes `isDragOver ? … : …`. Typecheck 0, no new lint. Impact HIGH = breadth artifact (1 direct caller), detect_changes LOW/expected. **Browser-verified on merged tip**: copy flips on synthetic file-drag (shots w3-05/06) |
| W-B (sonnet) | BUG31 buildSpec undefined-clobbers-defaults | `fix/bug31-buildspec-defaults` @e93fc0a7 | strip-undefined before spread (auto-cut `resolveOptions` idiom); repro test unskipped + reframed as regression pin. director suite 470→471 pass / 0 fail. Impact HIGH = hub-breadth (reserveSlot/storyboard funnel, expected shape); detect_changes artifact (line-shift) verified against `git diff -U0` |

Both branches parented on 6cbcbef0 exactly (audited); diffs read in full by L1 before merge.

## Battery on the merged tip (fc9fcffb)

- typecheck: exit 0
- lint: 339 errors / 225 warnings == tip baseline (no worse)
- `bun run build`: exit 0 · `bun run build:e2e`: exit 0 · `bun run build:e2e:real`: exit 0
- `bun test` full: 1721 pass (+1 = unskipped BUG31 pin) / 52 fail == pre-merge order-dependence set, unchanged
- `bun test src/lib/director/`: 471/0

## Verification harness (scratch, untracked — reproducible)

`e2e/w3-regression-hunt.e2e.ts` + `playwright.w3-hunt.config.ts` (port 3213, chrome
channel, real-export build) — 5/5 green. Fixtures minted with ffmpeg into
`e2e/fixtures/w3/` (untracked; 45MB large file kept out of git):

```
ffmpeg -f lavfi -i "testsrc2=size=1280x720:rate=60:duration=6" -f lavfi -i "sine=frequency=440:duration=6" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest fps60_1280x720_h264.mp4
ffmpeg -f lavfi -i "testsrc2=size=1920x1080:rate=30:duration=30" -f lavfi -i "sine=frequency=330:duration=30" -c:v libx264 -pix_fmt yuv420p -b:v 12M -c:a aac -shortest large_1920x1080_30s.mp4
```

Suggest C12 adopt it with runtime-minted fixtures (presets/GIF/captions UI drive is new
coverage; the w2 spec's minting pattern applies directly).

## Next-wave suggestions

1. BUG33 fix (small, captions panel gate — one condition + a test).
2. MCP bridge anon-poll 401 noise → silent-mode/anon-skip (BUG18 umbrella).
3. C12: adopt the w3 harness (preset/GIF/captions UI coverage) with minted fixtures.
4. Update queue chore C8 with the wider order-dependence fail set (done this campaign).
5. H7 at HTTP tier: an external-process MCP client driving board verbs over SSE (C3 Q-rows).

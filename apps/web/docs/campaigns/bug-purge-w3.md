# Campaign: bug-purge-w3 (C7 wave 3) — regression hunt over the integrated main

- **Branch:** `campaign/bug-purge-w3` off main @6cbcbef0
- **Started:** 2026-07-17
- **Objective:** Regression-hunt the golden path after today's 15-campaign integration
  (Palmier-15, SSRF guard, MCP relay + board verbs, perf fps60 fix, char-consistency fold,
  export presets/GIF/captions, audio-suite reconcile, tenancy fix, BUG12 401 fix). Plus two
  surgical fix-forwards (BUG30, BUG31).

## Plan

### Part 1 — regression hunt (L1 drives; existing e2e suites + hands-on browser + ffprobe)

| # | Surface (why hot) | Method | Verdict | Evidence |
|---|---|---|---|---|
| H1 | Golden path end-to-end (all of today) | `happy-path.e2e.ts` + hands-on drive | — | — |
| H2 | REAL export → ffprobe (C11/C12 churn) | `real-export/golden-path-export.e2e.ts` (ffprobe assertions) | — | — |
| H3 | Voiceover/audio tab reconcile holds (C9) | `voiceover-single-ui.e2e.ts` + `audio-gen.e2e.ts` + `auto-duck-playback.e2e.ts` | — | — |
| H4 | Export presets + GIF + SRT/VTT produce valid files (C11) | unit suites (`captions.test.ts`, `gif/encoder.test.ts`, `export.test.ts`) + hands-on export → ffprobe | — | — |
| H5 | Char-consistency fold on manual generate (C2) | `persona-consistency.e2e.ts` | — | — |
| H6 | Anon editor survives background 401s — BUG12 holds (C13) | `anon-editor-stability.e2e.ts` | — | — |
| H7 | MCP board verbs reachable (C3) | `mcp-e2e-smoke` + reliability/catalog unit suites | — | — |
| H8 | Heavy fixtures: HEVC/HDR/portrait/alpha/audio-only (+60fps mint) | `fixtures-w2-hunt.e2e.ts` (channel:chrome) + hands-on 60fps import/play | — | — |

Rules: E2E bridge / mocked generation only — NEVER real credits. Battery serial (shared
host). `build:e2e` prerender flakes = verify environmental before filing.

### Part 2 — fix-forwards (Sonnet workers, disjoint file clusters)

| Worker | Bug | Owned files | Status |
|---|---|---|---|
| W-A | BUG30 MediaDragOverlay resting-vs-drag copy | `components/editor/panels/assets/drag-overlay.tsx`, `components/editor/panels/assets/views/assets.tsx` | — |
| W-B | BUG31 buildSpec undefined-clobbers-defaults | `lib/director/director-api.ts` (buildSpec only), `lib/director/adapter-defaults.test.ts` | — |

Off-limits for fixes (queue-row instead): stores/*, ai-client.ts, route table, packages/env,
package.json, migrations, renderer/video-cache internals, auth/money/credits, export mixdown
(BUG32 stays filed).

## Log

- 2026-07-17: branch cut @6cbcbef0; plan committed; workers dispatched.

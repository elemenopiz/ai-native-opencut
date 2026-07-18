# C21b · Bug-purge wave 4 — wave-closer regression hunt

> **Campaign log (crash-survival state).** Status tables record only what HAS happened.
> Branch: `campaign/bug-purge-w4` (created from `main` @29a06429 = wave-3 integrated tip,
> which contains b272f7af and the 7 wave-1/-2 merges: C26 assets, C14 docs, C25
> audio-lifecycle, C15a+C15 UI, C16 test-infra, C24 export-fidelity).

## Mission

Regression hunt over the integrated result of the 7 merged campaigns. Drive the app like a
paying stranger: real media (`e2e/fixtures/**`), real flows, E2E bridge for **seeding only**.
ID range **BUG85–BUG99** (dedupe vs SPEEDRUN-QUEUE §2). Budget ~120 min. Fix-forward ONLY
trivial finds in files NO live campaign owns (live territory: C27 lib/commands, C17
services/renderer, C18 lib/mcp, C33 assets folders+media-store, C28 services/storage +
editor-provider) — when in doubt, FILE.

## Hunt charter (priority order)

1. **GOLDEN PATH e2e** — open → import real media (HEVC/portrait/audio) → edit
   (trim/split/transitions) → REAL export → ffprobe + play-verify. Zero crashes, A/V sync.
2. **C15 NEW UI** — docked tasks mini-bar (never occludes timeline/dialogs?), Board dialog
   (open/promote/discard/empty), first-run guide placement (composer visible too?), timeline
   empty-state hint, focus rings on all 8 primitives (keyboard walk), generation-glow,
   micro-type legibility.
3. **C24 contract** — clip volume 0.5 → export → decoded audio actually quieter. Run
   `bun run test:e2e:fidelity` + one manual browser export.
4. **C25 contract** — delete audio asset → ⌘Z → asset + clips restored, audio plays;
   record → discard.
5. **C26 DEFERRED drag/context-menu matrix** — run-ready suite `e2e/hunt/w-drag.hunt.e2e.ts`
   + `playwright.hunt-w-drag.config.ts` (M8/M14/M15/M17/M18/M19/M20). Host is quiet — its window.

## Server budget (HARD): max 2 dev servers total across the campaign

- W1 owns the export/fidelity server slot: real-export (port 3211) + fidelity (3213) run
  **sequentially** (one webServer at a time) + golden-path real Chrome. 1 slot.
- W2 owns the interaction/UI server slot: manual `NEXT_PUBLIC_E2E=1 PORT=3303 bun run dev`
  for w-drag + C25 + C15 browser drive. 1 slot.

## Partition (2 workers, disjoint scenario clusters, background sonnet, own worktrees)

| Worker | Scenario cluster (priorities) | Server | Suites / drives |
|---|---|---|---|
| **W1 — Export & Fidelity** | P1 golden path + P3 C24 contract | 3211→3213 (seq) | `test:e2e:real`, `test:e2e:fidelity`, ffprobe, 1 manual volume-0.5 export |
| **W2 — Interaction, Lifecycle & UI** | P4 C25 + P5 C26 matrix + P2 C15 UI | 3303 | w-drag hunt suite, C25 delete→undo + record→discard drive, C15 UI walk |

Fixtures on disk: `e2e/fixtures/w2/{portrait_1080x1920_h264.mp4, hdr_hevc_1280x720_10bit.mp4,
audio_only_3s.m4a, alpha_overlay_512.png, tiny_640x360_h264.mp4}`, `e2e/fixtures/tiny-tone.wav`,
`e2e/fixtures/w2-scratch/{big_res, corrupt, vfr}`.

## Baselines (judge batteries as deltas)

- full `bun test` = 2175 pass / 5 skip / 12 fail (known Bun-race residual: 10 proxy-encoder
  + 2 add-to-editor; 0-fail under `--isolate`).
- typecheck 0; lint ~334e/224w (bar = no-worse).

## Hunt matrix (surface × scenario × PASS/FAIL/NOT-RUN) — filled as evidence lands

| Surface | Scenario | Result | Evidence |
|---|---|---|---|
| Golden path | import HEVC/portrait/audio → trim/split/transition → real export → ffprobe | NOT-RUN | W1 |
| C24 fidelity | volume 0.5 → export → decoded quieter (e2e matrix) | NOT-RUN | W1 |
| C24 fidelity | one manual browser export, volume 0.5 | NOT-RUN | W1 |
| C25 | delete audio asset → ⌘Z → asset+clips+audio restored | NOT-RUN | W2 |
| C25 | record → discard = zero artifacts | NOT-RUN | W2 |
| C26 matrix | M8 rename via context menu (edge cases) | NOT-RUN | W2 |
| C26 matrix | M14/M17 drag-to-timeline + overlay states | NOT-RUN | W2 |
| C26 matrix | M15 alternate entry points / drop targets | NOT-RUN | W2 |
| C26 matrix | M18/M19 context-menu sweep per asset type | NOT-RUN | W2 |
| C26 matrix | M20 | NOT-RUN | W2 |
| C15 UI | tasks mini-bar occlusion (timeline + dialogs) | NOT-RUN | W2 |
| C15 UI | Board dialog open/promote/discard/empty | NOT-RUN | W2 |
| C15 UI | first-run guide placement (composer visible?) | NOT-RUN | W2 |
| C15 UI | timeline empty-state hint | NOT-RUN | W2 |
| C15 UI | focus rings on 8 primitives (keyboard walk) | NOT-RUN | W2 |
| C15 UI | generation-glow + micro-type legibility | NOT-RUN | W2 |

## Worker log

- (pending dispatch)

## Bugs filed (BUG85–BUG99, deduped vs queue §2)

- (none yet)

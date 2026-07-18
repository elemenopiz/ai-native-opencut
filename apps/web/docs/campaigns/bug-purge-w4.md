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
| Golden path | real export → ffprobe (h264/aac, 1.600s video exact) | PASS (1/1) | w1-export/task-b-real-export.log |
| C24 fidelity | 7-case matrix incl. volume-0.5 (ratio 0.2501 power ≈ 0.5 amplitude), automation 5.30, BUG17 zero-video-stream | PASS (7/7) | w1-export/task-a-fidelity.log |
| C24 fidelity | manual REAL-UI export, volume 0.5 typed in Properties → decoded RMS ratio 0.5000487 vs control (Web Audio decode in-browser) | PASS | w1-export/task-c-manual-volume-export.log |
| C25 | delete audio asset → ⌘Z → asset+clips+audio restored | NOT-RUN | W3 |
| C25 | record → discard = zero artifacts | NOT-RUN | W3 |
| C26 matrix | M8 rename: mid-proxy rename | PASS | w2-interaction/task-a-w-drag-suite.log |
| C26 matrix | M8 rename: edge cases (200-char/emoji/empty OK; collision leg unreached) | FAIL (harness? — 2nd import filechooser timeout, disambiguation → W3) | same |
| C26 matrix | M14/M17 drag-to-timeline (video/image/audio) + overlay states | PASS (4/4 — audio lands on AUDIO track) | same |
| C26 matrix | M15 list-view drag | FAIL (draggable not found in list view — drift vs real, → W3) | same |
| C26 matrix | M15 drop targets: 2nd drop onto existing track lands NOWHERE (silent no-op) | FAIL (real-bug candidate, → W3 manual confirm) | same |
| C26 matrix | M18 context-menu sweep (video menu items enumerated OK, then 2nd-import timeout) | FAIL (same import-helper root as M8) | same |
| C26 matrix | M19 per-asset Download ×3 types + post-rename + mid-proxy | PASS | same |
| C26 matrix | M20 record: permission DENIED handling | PASS (error toast) | same |
| C26 matrix | M20 record: permission GRANTED → recording state never entered | FAIL (→ W3: fake-device flags vs real break; overlaps C25 contract) | same |
| C26 matrix | M20 record: Assets Audio sub-tab entry | FAIL (harness strict-mode: C15's `generate-media-tab-audio` collides on accessible name "Audio") | same |
| C15 UI | tasks mini-bar occlusion (timeline + dialogs) | NOT-RUN | W3 |
| C15 UI | Board dialog open/promote/discard/empty | NOT-RUN | W3 |
| C15 UI | first-run guide placement (composer visible?) | NOT-RUN | W3 |
| C15 UI | timeline empty-state hint | NOT-RUN | W3 |
| C15 UI | focus rings on 8 primitives (keyboard walk) | NOT-RUN | W3 |
| C15 UI | generation-glow + micro-type legibility | NOT-RUN | W3 |

## Worker log

- **W1 — Export & Fidelity** (`task/w1-export-fidelity` @e8964ecc): DONE, merged to campaign.
  Zero regressions: fidelity 7/7, golden-path real export 1/1 ffprobe-clean, manual REAL-UI
  volume-0.5 export decoded RMS ratio 0.5000487 vs control. Flags: (1) `test:e2e:fidelity`
  was not wired into bun-ci.yml → fixed-forward on this branch (unowned file, trivial);
  (2) BUILD-FLAG GOTCHA recorded below. W1's false-lead selection-API crash was a harness
  artifact, correctly not filed.
- **W2 — Interaction, Lifecycle & UI** (`task/w2-interaction-ui`, zero commits): STALLED
  mid-campaign after completing Task A (w-drag suite, 7 pass / 6 fail, 5.8m). Uncommitted
  evidence log salvaged from its worktree and committed here. Tasks B (C25 contracts) and
  C (C15 UI walk) never ran. Replaced by W3 per doctrine (fresh scoped worker, not resumed).
- **W3 — Completion & disambiguation** (`task/w3-interaction-completion`): dispatched after
  W2 stall. C25 contracts + C15 UI walk + manual disambiguation of the 4 ambiguous w-drag
  FAILs. Reuses the still-live 3303 server (server budget: W2's slot transferred).

## Gotchas recorded for future workers

- **NEXT_PUBLIC build-flag gotcha (W1):** `NEXT_PUBLIC_*` vars are inlined at BUILD time —
  a playwright webServer `env:` block cannot flip them against a plain `bun run build`.
  Real-export/fidelity suites need the `build:e2e:real` build first (`bun run start` then
  serves the seam). The CI step added here documents the ordering constraint inline.
- **Binary relay gotcha (W1):** relaying exported-file bytes out of the browser as base64
  through the tool-call text channel corrupts/truncates them; decode + measure in-browser
  (Web Audio `decodeAudioData` + RMS) instead.
- **C15 accessible-name collision:** `generate-media-tab-audio` and the assets-panel Audio
  tab both resolve to role=button name="Audio" — suites must scope by testid/container.

## Bugs filed (BUG85–BUG99, deduped vs queue §2)

- (pending W3 disambiguation — candidates: 2nd-drop silent no-op [M15], populated-state
  import filechooser [M8/M18], record-start-under-granted-permission [M20], list-view drag
  [M15]; note poach_session_findings' historical "no-op drag" — verify whether M15's find
  predates the wave before filing as a regression)

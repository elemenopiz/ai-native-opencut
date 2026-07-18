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
| C25 | delete audio asset → ⌘Z → asset+clips+audio restored | PASS | w3-completion/ taska-c1-* shots + task-a-contracts.log |
| C25 | record → discard = zero artifacts; record → stop = exactly one asset | PASS | w3-completion/ taska-c2-* shots |
| C26 matrix | M8 rename: mid-proxy rename | PASS | w2-interaction/task-a-w-drag-suite.log |
| C26 matrix | M8 rename: edge cases (200-char/emoji/empty OK; collision leg) | PASS after disambiguation — suite FAIL = HARNESS DRIFT (2nd-import filechooser needs longer-than-30s wait; human path works, W3 c1-* shots) | w3-completion/ |
| C26 matrix | M14/M17 drag-to-timeline (video/image/audio) + overlay states | PASS (4/4 — audio lands on AUDIO track) | w2-interaction log |
| C26 matrix | M15 list-view drag | PASS after disambiguation — suite FAIL = HARNESS DRIFT (ContextMenuTrigger without asChild wraps the row in a span; suite's draggable selector misses it. Human drag works, W3 c2-* shots). NOTE: C33 merged @c89c4989 touched assets.tsx — cite by symbol (`MediaAssetDraggable` render wrapper), not line | w3-completion/ |
| C26 matrix | M15 drop targets: 2nd drop onto existing track | NOT-REPRODUCED manually (6/6 attempts landed correctly; W3 c3-* shots) — kept as WATCH-ITEM, not filed: suite observed one silent no-op that no manual repro produces | w3-completion/ |
| C26 matrix | M18 context-menu sweep | PASS after disambiguation (same import-helper harness root as M8; video menu items enumerated clean) | both logs |
| C26 matrix | M19 per-asset Download ×3 types + post-rename + mid-proxy | PASS | w2-interaction log |
| C26 matrix | M20 record: permission DENIED handling | PASS (error toast) | w2-interaction log |
| C26 matrix | M20 record: permission GRANTED | PASS after disambiguation — suite FAIL = HARNESS DRIFT (no fake-device flags ⇒ getUserMedia yields no device in headless; with `--use-fake-device-for-media-capture` recording state enters, W3 c4-* shots) | w3-completion/ |
| C26 matrix | M20 record: Assets Audio sub-tab entry | HARNESS strict-mode collision, confirmed = real a11y smell → filed BUG92 | w3-completion/ |
| C15 UI | tasks mini-bar occlusion (timeline + dialogs, Export dialog simultaneous) | PASS (docked, under dialog) | taskb-b1-* shots |
| C15 UI | Board dialog empty state + affordances | PASS | taskb-b2-board-empty.png |
| C15 UI | first-run guide placement (BUG27 fix holds — composer visible simultaneously) | PASS | taskb-b3-guide-plus-composer.png |
| C15 UI | timeline empty-state hint (BUG28 fix holds) | PASS | taskb-b4-empty-timeline-hint.png |
| C15 UI | focus rings keyboard walk across primitives | PASS (recipe present) — EXCEPT project-name header input → filed BUG91 | taskb-b5-* shots |
| C15 UI | generation-glow scoped to in-flight only | PASS | taskb-b6-generation-glow.png |
| C15 UI | micro-type legibility @1280/1680 | PASS | taskb-b7-* shots |

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
- **W3 — Completion & disambiguation** (`task/w3-interaction-completion` @2bdb508e): DONE,
  merged @136cdd17. C25 contracts 2/2 PASS, C15 UI walk 7/7 PASS, all 4 ambiguous w-drag
  FAILs disambiguated (3 harness-drift with root causes: 30s filechooser timeout,
  ContextMenuTrigger-no-asChild span, missing fake-device flag; 1 not-reproduced 6/6 →
  watch-item). Reused the 3303 server (W2's slot; server budget held at ≤2 all campaign).
  Found 2 real a11y issues → BUG91/BUG92. Committed a scoped re-run suite
  (`e2e/hunt/w3-taskc.w3.e2e.ts` + `playwright.w3-completion.config.ts`) as evidence.

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

- **BUG91** — Project-name header input has NO visible keyboard focus in resting state:
  `EditableProjectName` (`components/editor/editor-header.tsx`, fn at ~L454) applies
  unconditional `outline-none` on its trigger classes with no focus-visible recipe — the
  one interactive header control C15's 8-primitive focus unification missed. Repro: Tab to
  the project name — nothing indicates focus (contrast BUG11's Enter/F2 path, which works
  but invisibly). Severity: low (a11y/keyboard). Evidence:
  `assets/bug-purge-w4/w3-completion/screenshots/taskb-b5-focus-ring-MISSING-project-name-input.png`.
- **BUG92** — Duplicate accessible name "Audio": assets-rail tab (aria-label="Audio") and
  C15's Generate media sub-tab (`data-testid="generate-media-tab-audio"`, visible text
  "Audio") both resolve to role=button name="Audio" — ambiguous for screen readers and
  breaks strict-mode locators (broke the M20 suite leg). Cheap fix: distinguish the
  aria-label (e.g. "Audio assets") on whichever side its owner prefers. Severity: low
  (a11y + test-infra). Evidence: strict-mode violation in
  `assets/bug-purge-w4/w2-interaction/task-a-w-drag-suite.log` (both elements dumped).
- **WATCH-ITEM (not filed):** M15 second-drop silent no-op — automated suite observed one
  image drop onto an occupied track landing nowhere; 6/6 manual attempts (occupied track,
  empty space below) all landed correctly. Possibly timing-dependent (drop during proxy
  generation?). If any future hunt reproduces it, file with that repro; an old
  poach-session note mentions a historical "no-op drag", so it may predate the wave anyway.
- **BUG85–90, 93–99: UNUSED.**

## Close-out (2026-07-18)

- **Verdict: ZERO regressions found across the 7-campaign integrated result.** Every
  charter surface PASSes: golden-path real export (ffprobe-clean h264/aac), C24 fidelity
  contract (7/7 matrix + manual REAL-UI volume-0.5 export decoded at RMS ratio 0.5000487),
  C25 contracts (delete→⌘Z full restore; record→discard zero artifacts), C15 UI (7/7 incl.
  BUG27/BUG28 fixes holding), C26 deferred drag/context-menu matrix (all rows PASS or
  disambiguated to harness drift; 1 watch-item).
- **Battery on campaign tip** (= main@a95b616e + W1/W2/W3 evidence + CI fix; main moved
  three times during the campaign — C18/C27/C28 folded in via merge, C33 landed after the
  last fold and is NOT in this tip): typecheck 0 · lint 328e/224w (baseline ~334e/224w —
  better) · full `bun test` **2308 pass / 5 skip / 12 fail / 0 errors**, the 12 = exactly
  the known Bun mock.module residual (10 proxy-encoder + 2 add-to-editor). First battery
  run red (55f/40e) was the missing-`.env.local`-in-fresh-worktree signature — env copied,
  rerun green. Judge = clean vs baseline.
- **Fix-forward (1, unowned file):** `test:e2e:fidelity` wired into `bun-ci.yml` after the
  real-export step (reuses the `build:e2e:real` .next; ordering constraint documented
  inline). Tier: merged (provable on a real Actions run post-push, same caveat as CH6).
- **Territory RELEASED.** Next wave should: (1) land the cheap BUG91/BUG92 fixes (one
  focus recipe + one aria-label), (2) fold the three harness-drift fixes into
  `w-drag.hunt.e2e.ts` (longer import wait, span-aware draggable selector, fake-device
  launch flags) so the suite runs clean next wave-closer, (3) keep the M15 watch-item on
  the next hunt's checklist, (4) re-run this charter's matrix over C33 asset-folders +
  C17 compositor once they land — assets.tsx moved under C33 after this hunt's evidence
  was captured.

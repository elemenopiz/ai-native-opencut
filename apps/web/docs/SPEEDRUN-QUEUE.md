# SPEEDRUN QUEUE — live improvement backlog

> The single pull-queue for all Fable speedrun sessions (see `.claude/fable-core.md` for
> doctrine). **Update this file every loop iteration** — claim items in the in-flight table
> before dispatching, move them to the done log with evidence when verified. Seeded
> 2026-07-17 from git + PROD-READINESS + the perf/poach/director docs; every row is a
> claim to re-verify cheaply before acting, not gospel.
>
> Status legend: `open` · `in-flight(session)` · `gated(user)` · `done(sha, tier)`

## 0 · Human gates & ops (user-action queue — surface these, don't self-serve)

| # | Item | Why now | Status |
|---|---|---|---|
| G1 | **B3 hands-on verify ON prod** — seed owner credits, then run `docs/beta-b3-verification-runbook.md`: real export → play the file + one paid Director gen with reserve→settle observed | The last beta gate; beta ≈2026-07-19 | gated(user) |
| G2 | **Push cadence decision** — local `main` is now ~50 commits ahead of origin (5 merged campaigns: C4-A, C7-w1, C12, C13, C7-w2, C1/Palmier wave); push = prod deploy | Unpushed work doesn't exist for users | gated(user) |
| G3 | Resend sender-domain verification — reset/verify emails are log-only in prod | Strangers can't reset passwords | gated(user) |
| G4 | Provider spend caps on dashboards (BytePlus $25 pool, Gemini, Kimi, fal if upscale lands) | Courtesy-credit chunks make runaway spend possible | gated(user) |
| G5 | Rotate the Vercel token used during B2 | Standing hygiene item from the deploy | gated(user) |
| G6 | Commit untracked docs: `apps/web/docs/compliance/`, `docs/plans/2026-07-15-hevc-cross-browser-decode-design.md`; gitignore `.playwright-mcp/` artifacts | Work product sitting untracked in the shared checkout | done(2026-07-17, L0 mission control) |
| G7 | **C4 UI taste-gate** — review `apps/web/docs/design/2026-07-17-ui-direction-phase-a.md` (+11 screenshots in `docs/design/assets/`): pick direction A/B/C, answer the 6-question set in §7 (export CTA, accent policy, icon rail, mechanical-batch pre-approval, tasks popover). Phase B implementation is blocked on this | Wave-1 C4-A merged @c5864ac4; recommendation = A "Instrument-Grade Minimal" | gated(user) |

## 1 · Integration sweep (built work parked on branches — decide merge/kill, then delete)

Branches with real deltas (`git rev-list --count main..<b>` on 2026-07-17):

All rows dispositioned by C1 (`campaign/ship-parked-inventory`, 2026-07-17 — full
evidence in `docs/campaigns/ship-parked-inventory.md`):

| Branch | Δ | What it is | Disposition |
|---|---|---|---|
| `integrate/palmier-2026-07-14` | 15 | The 6-item Palmier delta wave (Waves A/B/C; Wave D = keyframe-verbs/ElevenLabs was never built — not on the branch) | **merged-to-campaign** @3af26f35; 3 conflicts union-resolved; battery green; browser-smoked |
| `fix/credit-audit-money-gated` | 6 | Money packet: credit LOWs #6–#10 + #14 async persona-still + money tests | **gated(user)** — review packet prepared in campaign log; 208 behind main ⇒ needs rebase-and-reconcile session, not textual merge |
| `poach/verb-telemetry` | 6 | Director verb telemetry | merged via palmier-15 → kill after C1 lands |
| `poach/staged-export-jobid` | 5 | Staged export w/ job id | merged via palmier-15 → kill after C1 lands |
| `integrate/palmier-wave-a` | 4 | Strict subset of the 07-14 integrate (patch-id verified) | **kill-list** |
| `feat/upscale-backend` | 2 | Tiered fal.ai upscale + migration 0012; **all 5 fal APIs now VERIFIED current (2026-07-17), adapters work as-coded**; one pre-merge fix: clamp Topaz/Clarity factor ≤4 | **gated(user)** — migration packet prepared in campaign log |
| `feat/beta-gate-models-audio-templates` | 2 | feat + its own revert ⇒ net-zero diff | **kill-list** |
| `poach/scrub-audio-vu-meter` / `poach/mcp-project-binding` / `poach/chroma-luma-lut-check` / `poach/agent-undo-origin` | 1 each | Small poach tail | merged via palmier-15 → kill after C1 lands |
| `wip/local-ai-session-rescue-2026-07-12` | 1 | Local-AI is FROZEN (ADR-004) | **kill-list** (fork-network-sweep doc salvaged @399aa759) |
| `claude/admiring-goodall-623ae4` | 1 | Jul-11 render-guard fix, superseded (main has the finally-guard) | **kill-list** (optional: port reportFromException + unit test first) |

**Branch hygiene: VERIFIED 2026-07-17 (C1).** All ~13 named 0-ahead branches
(`fix/project-switch-hardening` @c2a0f815 and `fix/b1-text-background-crash`
@164fd049 are exact ancestors of main — the "held un-merged" memories are stale;
plus `perf/hevc-passthrough-hw-decode`, `perf/export-decode-tier`,
`fix/scope-playback-perf`, `poach/subtitle-import`, `poach/keyframe-clipboard`,
`feat/director-*`, `feat/audio-gen-backends`, `feat/openai-google-models`,
`axis4-export-bench`, `archive/virality-score`) and all 17 `worktree-agent-*`
branches confirmed ahead=0 ⇒ landed verbatim. **Kill-list ready for L0 to
execute** (C1 deleted nothing — several are worktree-attached).
(`ci/test-depth-workflow` Δ1 = C12 territory, untouched.)

## 2 · Live bugs

| # | Bug | Evidence | Status |
|---|---|---|---|
| BUG1 | `generateProxy()` 480p odd-dimension crash (853×480 rejected by AVC encoder — scale math doesn't round to even) | perf audit B2; verify whether the proxy-worker-offload merge (@20066e26) fixed it | done(20066e26, merged) — verified by bug-purge-w1: `computeProxyDimensions` floors to even, regression tests cover 853×480 exactly, 9/9 pass |
| BUG2 | **fps60 decode-starvation wedge: REPRODUCED 3/3 (was N=1)** — 4×1080p60 layers @ project fps 60 starve `VideoCache`: prefetch ring (cap 4) drains → playhead outruns the 2.0s `SEQUENTIAL_WINDOW` → every `getFrameAt` escalates to a fully-awaited `seekToTime` keyframe re-seek on the render path → self-sustaining re-seek storm (renders in flight 3–15s+; one 12s hard wedge with playhead running and 0 frames; original 81s = same loop on heavier fixture). Self-recovers when decode catches up; 1-layer control clean (0.2ms avgDecode). Files: `services/video-cache/service.ts` (`getFrameAt`/`seekToTime`), `services/renderer/nodes/video-node.ts`. Fix candidates: don't await `seekToTime` under `tolerateStale` (serve stale + background re-seek), scale ring/window with fps×layers, or subsume under worker-compositor (P1). Repro script + JSON evidence in bug-purge-w1 scratchpad (`bug2-repro.js`, `result-fps60-*.json`) | perf audit B4 → characterized by bug-purge-w1 2026-07-17; **fix owner: C5 only** | open(C5) |
| BUG3 | Sign-in rate limit shows the same generic toast as a bad password | 429 → distinct "Too many attempts" toast, unit-tested; copy-only, no auth logic; diff reviewed by L0 | done(merged 2026-07-17, tier: merged+unit-tested — browser-verify capped: rate limiting is prod-only) |
| BUG4 | Onboarding tour arrow-key nav unresponsive (buttons/dots work) | onboarding merge note — OBSOLETE: the first-run onboarding overlay was deleted @184d1989; surviving collab-only `shared-project-onboarding.tsx` has no keyboard nav at all → fold into C3 collab pre-unhide checklist | done(184d1989, obsolete) |
| BUG5 | Two duplicate voiceover UIs — reconcile into one | gen-UI packet flag | open |
| BUG6 | Dual LUT systems (`lut` inline picker vs registry `lut-3d`, intensity 100-vs-1 scale ambiguity) | poach-wave note | open (product call) |
| BUG7 | Command palette doesn't open on Cmd/Ctrl+K under headless Chromium — repro'd headed+headless, identical behavior: `Ctrl+K` is ignored **by design** on Apple hosts (`keybindings-store.ts:223` maps `ctrl` bindings to `metaKey` when `isAppleDevice()`); `Meta+K` opens the AI panel fine headless; the actual palette is `⇧⌘P` (works headless, both modifiers). Automation rule: send Meta, not Control, on Apple hosts | bug-purge-w2 hands-on repro 2026-07-17 (evidence in `docs/campaigns/bug-purge-w2.md`) | done(harness artifact, verified locally) |
| BUG8 | Export-popover × anon-signup-tooltip z-order — **characterized precisely** (bug-purge-w2, fix deferred: export surfaces under active integration): the "tooltip" is the sonner toast from `unauthorized.ts:111`; Toaster is global `position="top-center"` (`ui/sonner.tsx:15`) with z 999999999 vs popover z-50 → toast ALWAYS occludes the top-center VC pill (x 741–940 @1680w; visible in C4-A shots 02+08) and horizontally overlaps the export popover at viewports ≲1030px. Fix = reposition Toaster (bottom-left clears both) or offset below header (y>54); owner = whoever holds header/toaster chrome (C4-B or C10) | bug-purge-w2 measured repro 2026-07-17, geometry in `docs/campaigns/bug-purge-w2.md` | open (documented, fix queued) |
| BUG9 | Background-tasks toast/popover occludes timeline clips (and overlaps Export dialog watermark section) | C4-A shots 03/04/08 | open |
| BUG10 | Text-preset labels render doubled truncation fragments ("Body Text…ext") — root cause: `draggable-item.tsx` middle-ellipsis with mismatched thresholds (`>8` guard, head 16 + tail 3) doubled any 9–19-char name; fixed via `middleTruncate` helper + 7 unit tests | bug-purge-w2 @7e82d204; Text panel browser-verified clean | done(campaign/bug-purge-w2, verified locally) |
| BUG11 | `EditableProjectName` has no keyboard path into edit mode — Enter/F2 now enter edit (guarded on `isEditing`), aria-label added; idiom from `editable-timecode.tsx` | bug-purge-w2 @09caee10; full keyboard loop browser-verified (Enter→edit→commit, F2→Esc→revert) | done(campaign/bug-purge-w2, verified locally) |
| BUG12 | **Any client-side API 401 hard-redirects the editor to /signup, destroying session state** — `byorn:unauthorized` (fired by e.g. `/api/studio/board`, `/api/credits/balance` background polls) → `SessionExpiredListener` redirects unconditionally. Killed two automated editor sessions mid-run (bug-purge-w1); C12's worker independently hit the same bug via the Takes-history hydration 401 breaking `happy-path.e2e.ts` on clean main. A single stray 401 from a background poll while a user has unsaved editor state does the same. Files: `src/lib/auth/unauthorized.ts`, `src/components/auth/session-expired-listener.tsx`. Also breaks E2E-build benches (the `proxy.ts` E2E bypass covers middleware only, not this client path) — harness workaround: Playwright-route non-auth `/api/**` to 200s. Fix is auth-adjacent → route to C6/C10, not a drive-by | bug-purge-w1 hunt + test-depth worker A, both 2026-07-17 | done(3cd3acd4, verified locally — RED→GREEN regression spec + happy-path 5/5 + both-directions browser verify; L0 diff-reviewed, user-approved merge) |
| BUG13 | `DeleteElementsCommand.execute` throws raw `TypeError` on malformed input — fixed: fail-fast constructor guard with descriptive error (`"elements" must be an array of { trackId, elementId }`), empty array stays valid no-op; +6 unit tests, 39/39 element-command tests green. NOTE for L0 merge review: GitNexus upstream impact = CRITICAL (breadth artifact: 19 transitive dependents of the shared class; detect_changes = LOW, 0 affected processes; change is additive validation only) | bug-purge-w2 @358f5430 | done(campaign/bug-purge-w2, merged+unit-tested) |
| BUG14 | **Timeline mutations during heavy-media import leave the main thread unresponsive 10–30s** (asset drag-insert, text-preset add after a 4K HEVC import) — mutation lands in store state but UI/automation stalls; correlates with proxy/thumbnail generation + Understanding-Pass ONNX work competing for main thread. Reproduced 3×. Confirms "main thread is the wall" specifically on interactive edit actions, not just playback. Needs a flame-graph profile; **fix owner: C5** | bug-purge-w1 hunt 2026-07-17 | open(C5) |
| BUG15 | **`generation-status-store.ts` resume-poll (~L152, `apiFetch(\`/api/studio/generate/${jobId}\`)`) is the last background-poll `apiFetch` call site still in prompt mode** — BUG12's fix added `{ on401: "silent" }` for background hydration (loadHistory `/api/studio/sets`, use-board-items `/api/studio/board`) but `stores/*` was off-limits to that campaign. Residual exposure: an anon/expired session with a persisted in-flight job gets the redirect from a background poll. One-line fix + comment, mirror `use-board-items.ts` refetch; owner = whichever campaign holds `stores/*` (C5 currently) | fix-401-redirect campaign 2026-07-17 | open |
| BUG16 | **HDR HEVC source loses all HDR color handling on export** — 10-bit bt2020/smpte2084 (PQ) clip imports fine (no crash, plays), but real export emits bt709-tagged SDR with NO tonemap step: canvas compositing is inherently SDR/bt709, so real HDR footage renders washed-out/crushed, not just mislabeled. Suspect: `services/renderer/scene-exporter.ts` unconditional H.264/bt709 path — needs explicit PQ→SDR tonemap at decode/composite. Repro: `e2e/fixtures-w2-hunt.e2e.ts` "10-bit HDR HEVC" + `fixtures/w2/hdr_hevc_1280x720_10bit.mp4`; owner: renderer = C5 territory | bug-purge-w2 hunt 2026-07-17, ffprobe evidence | open(C5) |
| BUG17 | Audio-only project export still emits a blank 1920×1080 H.264 video stream alongside the audio (90 static frames, ~39kbps) — wasted encode time/bytes and confusing in players. Repro: `e2e/fixtures-w2-hunt.e2e.ts` "audio-only" case | bug-purge-w2 hunt 2026-07-17 | open (low) |
| BUG18 | Brand-new anon project route logs `console.error` "Failed to load project: … not found" (`project-manager.ts:157`) on the EXPECTED first-load path (app then creates the project and proceeds) — noise that could trip error-rate alerting; downgrade to info/debug on this path | bug-purge-w2 hunt 2026-07-17 (seen in all 4 hunt tests) | open (low/cosmetic) |
| BUG19 | Anon editor's Generate panel rendered NO composer (0 `<textarea>` in DOM) in a local E2E-flag dev session, while C4-A shots show the composer for anon — suspect backends-list hydration failing silently for anon and the form not rendering a fallback; needs a targeted repro (dev vs e2e-build difference matters) | bug-purge-w2 BUG8 repro side-find 2026-07-17 | open (needs repro) |
| BUG20 | route-protection test red ON MAIN: `studio/upload-url/route.ts` is session-gated but missing from the executed SWEEP table in `app/api/__tests__/route-protection.test.ts` — the "every route classified" assertion fails on a clean checkout | C1 battery triage 2026-07-17 (fails identically on main and campaign) | open |
| BUG22 | `claude/admiring-goodall-623ae4` branch held for one salvage item: port `reportFromException` render-guard observability wiring + its unit test to main, then delete the branch (C1 disposition; low) | C1 2026-07-17 | open (low) |
| BUG21 | polar/webhook signature-verification tests red ON MAIN (2 tests: `polar provider — rejects a signature made with the wrong secret`, `webhook route — rejects a bad signature with 401`) — pre-existing, but it's the payments floor; needs triage (env-shape vs real bug) | C1 battery triage 2026-07-17 (fails identically on main and campaign, in isolation too) | open |

(Perf-audit B1 text-node crash and B3 mounted-loadProject crash: branches show 0-ahead ⇒
landed — **confirm in git log, then strike.**)

## 3 · Perf (measured truth in `apps/web/docs/perf/`)

| # | Item | Why | Status |
|---|---|---|---|
| P1 | **Worker compositor: flag-ON verify → default-ON → re-baseline** | The flagship structural fix (audit #6: main thread is the wall; 3–6fps → 20–30fps extrapolated); merged flag-OFF | open |
| P2 | Re-run the 7-axis baseline vs Palmier post-wave-1 (HEVC ingest skip, auto-proxy, export tier all landed) | Numbers in the audit predate the fixes; need the new deltas | open |
| P3 | HEVC cross-browser follow-ups (4 open items listed in the hevc memory/design doc `docs/plans/2026-07-15-hevc-cross-browser-decode-design.md`) | Option A merged @b668a4c0; tail remains | open |

## 4 · Features (moat-first ordering)

| # | Item | Why / source | Status |
|---|---|---|---|
| F1 | **Character-consistency deepening** — persona/seed-lock UX polish + Runway Aleph interim route for real-face VFX (BytePlus verified-asset partner access is the blocked long pole — asset:// picker already shipped) | Moat #1; Higgsfield's #1 captured gap | wave-1 done on `campaign/char-consistency` (C2): StyleBible fold closed on manual+rerun paths, persona-seed single-shot threading, consistency strip UI, Aleph seam env-flagged inert. Wave-2 rows: F1a–F1c below |
| F1a | Derive ConsistencyContext from probe-set `styleBible` at hydration (`project-bible.ts` `hydrateDirectorStateFromBible`) — probe-only projects currently neither fold nor show the chip | C2 wave-1 find (chip truthfulness fix exposed it) | open |
| F1b | Board "generate again with this character" affordance (`components/editor/board/reel-board.tsx`) — chain a board item's persona+seed into a new generation | C2 deferred for territory leanness | open |
| F1c | Aleph wave-2: set `RouteInput.realFaceReference` from persona photo-provenance (may need a provenance bit on personas — schema ⇒ gated) + UI badge when interim route fires; env contract `REAL_FACE_VIDEO_BACKEND=runway` (server process.env, read in `backends/router.ts`) | seam landed inert in C2; wiring is the remaining half | open |
| F2 | **MCP surface expansion** — finish deferred Redis pub/sub relay, widen the tool catalog, reliability hardening | Moat #2; Palmier's MCP reliability is cracking publicly | open |
| F3 | Director context gaps Tier 2/4 + beat-grid/LUFS audio grounding | Director context-gap audit (3/4 fixes landed; this is the tail) | open |
| F4 | Upscale (video+image) — verify the 4 fal APIs, then gated merge (see branch row above) | Built 2026-07-14, never verified | open |
| F5 | Transcript **edit-by-text** (delete words → cut media) | Fork-sweep gap; Descript-class differentiator; on-device Whisper + transcripts already shipped | open |
| F6 | Multicam flatten | Fork-sweep gap | open |
| F7 | Background fill + curves UI | OpenCut-ecosystem poach opens | open |
| F8 | Reconcile the two voiceover UIs into the audio tab (MMAudio + ElevenLabs) | gen-UI packet | open (= BUG5) |

## 5 · Poach targets (license-gate first — see `.claude/fable-poach-orchestrator.md`)

Sourcebooks: `apps/web/docs/poach/*` (Palmier delta, CapCut, Descript, Higgsfield, Runway,
Vyra, ecosystem + 6,689-fork sweep). Standing rule: maintained-package-first → lift the
module → clean-room reimplement. Ledger: `docs/poach/POACH-LEDGER.md`.

Top unpoached veins from the sweeps: transcript edit-by-text interaction model (Descript),
multicam, Palmier delta items not yet integrated (see branch row), CapCut poach doc opens.

## 6 · Chores / debt (needs a quiet tree or a decision)

| # | Item | Status |
|---|---|---|
| C1 | biome #5c — triage the ~454 pre-existing check errors | open (quiet tree) |
| C2 | `ownerId` NOT-NULL flip #13 + drop parent-set fallback (after prod backfill verified) | open (migration ⇒ gated) |
| C3 | Collab security pass — REQUIRED before un-hiding collab (ADR-003) | open |
| C4 | `services/` (9 Python dirs) resume-or-delete decision (ADR-004 said delete-last) | gated(user) |
| C5 | 8420 health-poll leak (verify-lane finding) — re-confirmed 2026-07-17 by bug-purge-w1: 3–4 `ERR_CONNECTION_REFUSED` bursts every ~20–60s all session, no backoff/circuit-breaker | open |
| C6 | auth-flow e2e permanently self-skips in CI — better-auth rate limiter hits unreachable Upstash before any DB touch; real auth CI coverage needs a redis-compatible CI service or a test seam (NOT a Postgres service — determination documented in bun-ci.yml) | open |
| C7 | happy-path.e2e.ts flake in CI will worsen until the BUG12 fix lands (longer suites widen the anon-401 race window) — expect it, don't chase it; goes green as a BUG12 side effect | open (watch) |
| C8 | **44 unit-test failures are pre-existing on main** (confirmed identical fail sets main @423efd82 vs campaign tips): `generateProxyOffThread` suite (10 uniques) + redis-health probes (3 uniques) fail in full-suite local runs — smells like the known bun `mock.module`/global-leak order-dependence class; triage whether env-only or real | bug-purge-w2 battery 2026-07-17 | open |
| C9 | Playwright's bundled Chromium has NO H.264/HEVC WebCodecs decode (avc1/hvc1 unsupported) — any e2e work with real codec fixtures must use `channel: "chrome"` (pattern: `playwright.fixtures-w2.config.ts`, port 3212); bundled-Chromium runs silently exercise the `unsupported` fallback instead of real ingest | bug-purge-w2 hunt 2026-07-17 | done(documented — recipe in config header) |

## 7 · Campaign roster (Mission Control — see `.claude/fable-mission-control.md`)

| Campaign | L1 status | Branch | Territory | Last update |
|---|---|---|---|---|
| C1 · Ship the parked inventory | **complete — awaiting L0 merge gate** (§1 fully dispositioned: palmier-15 merged-to-campaign, 2 gated packets, kill-list verified; filed BUG15–16) | `campaign/ship-parked-inventory` | queue §1 branches (merge-shaped, broad); money branch = prep-only; upscale = verify-then-gate | 2026-07-17 C1 |
| C7 · Bug purge wave 1 | **done — merged** (BUG1 fixed-prior, BUG2 repro'd→C5, BUG3 fixed, BUG4 obsolete; filed BUG12–14); wave 2 relaunchable | `campaign/bug-purge-w1` | golden-path browser hunt + queue §2 repros | 2026-07-17 L0 |
| C12 · Test depth | **done — merged @0ebedaf6** (real-export e2e + takes/board invariants + CI; zero new flakes) | `campaign/test-depth` | tests only | 2026-07-17 L0 |
| C7 · Bug purge wave 2 | **done — merged @0ab8fc0b** (BUG7 artifact-closed, BUG10/11/13 fixed, BUG8 documented, filed BUG16-19; wave 3 relaunchable) | `campaign/bug-purge-w2` | C4-A bug crop + fresh-fixture hunt | 2026-07-17 L0 |
| C13 · Fix anon 401 redirect race (BUG12) | **done — merged @3cd3acd4** (user-approved; BUG15 follow-up filed for stores/* owner) | `campaign/fix-401-redirect` | client auth-signal plumbing: unauthorized.ts, session-expired-listener.tsx, use-studio-generation.ts + new e2e spec | 2026-07-17 L0 |
| C4 · UI excellence — phase A | **done — merged @c5864ac4**; phase B gated on user taste-gate (G7) | `campaign/ui-direction-phase-a` | design-only (delivered: direction doc + 11 shots) | 2026-07-17 L0 |
| C2 · Character-consistency moat | **complete — awaiting L0 merge gate** (fold gap closed, persona-seed threading, consistency UI strip, Aleph seam; battery green, fail set == main; e2e walkthrough + screenshots on branch) | `campaign/char-consistency` | studio generation UI + hooks + lib/studio (+ additive backends/router seam); log: `docs/campaigns/char-consistency.md` | 2026-07-17 C2 |

## In-flight (claim before dispatching — session · items · owned files)

| Session | Item(s) | Owned files | Since |
|---|---|---|---|
| — | — | — | — |

## Done log (move rows here with sha + verification tier)

- 2026-07-17: Queue seeded (prompt-suite v2 revamp session).
- 2026-07-17: G6 untracked docs committed + `.playwright-mcp/` gitignored @3c7e41c8 (L0, docs-only).
- 2026-07-17: C4 phase A UI direction pass merged @c5864ac4 (tier: merged — docs+screenshots only, no product code). Deliverable: `docs/design/2026-07-17-ui-direction-phase-a.md`; recommendation = direction A "Instrument-Grade Minimal"; phase B blocked on G7 taste-gate. Found BUG7–BUG11.
- 2026-07-17: C1 ship-parked-inventory merged @e67f1860 (tier: verified locally, smoke depth). Palmier-15 wave (A/B/C; D never built) + 6 poach branches landed; combined battery on merged tip GREEN (typecheck 0, lint 346<347 baseline, build 0, bun test 1887/11 == pre-existing set). Kill-list executed: 35 branches + 26 worktrees deleted after 0-ahead re-verification; survivors = fix/credit-audit-money-gated (gated packet), feat/upscale-backend (gated packet), claude/admiring-goodall (BUG22 salvage hold). Filed BUG20/21 (renumbered from branch's 15/16).
- 2026-07-17: C7 bug-purge wave 2 merged @0ab8fc0b (tier: verified locally; user-approved — BUG13's CRITICAL rating is a breadth artifact, additive guard only). BUG10 truncation + BUG11 keyboard rename + BUG13 input guard fixed; BUG7 closed as Apple-host Meta-vs-Control harness artifact; portrait/HDR/alpha/audio-only fixture hunt green except new BUG16 (HDR→bt709 untonemapped) BUG17 (audio-only export blank video) BUG18/19 (minor). Battery green, e2e 11/0 incl. happy-path stable post-BUG12.
- 2026-07-17: C13 fix-401-redirect merged @3cd3acd4 (tier: verified locally; user-approved CRITICAL-radius merge). Additive on401 silent/prompt mode on apiFetch; anon editor survives background 401s (20s-soak e2e green, was red), user-initiated 401s still prompt+redirect (browser-proven); happy-path de-flaked 5/5. Follow-up BUG15: generation-status-store resume-poll still prompt-mode (stores/* owner = C5).
- 2026-07-17: C12 test-depth merged @0ebedaf6 (tier: merged; specs verified green on the campaign tip — real-export e2e 2/2 deterministic w/ ffprobe h264/aac 1.600s exact, takes/board 7/7 x4 runs, +10 unit tests, zero new failures vs baseline). CI: ffmpeg + real-export steps; auth-flow e2e blocked on reachable Upstash (not Postgres) — new row below. Bridge additions E2E-gated only, diff reviewed by L0.
- 2026-07-17: C7 bug-purge wave 1 merged (campaign tip f5999ce9). BUG1 done (fixed-prior @20066e26, 9/9 regression tests); BUG2 reproduced 3/3 + mechanism traced (re-seek storm in VideoCache), fix → C5; BUG3 fixed (tier: merged+unit-tested); BUG4 obsolete. Golden-path real export PASS frame-exact (47.09s vs 47.0s). Filed BUG12–14, re-confirmed C5 chore (8420 poll). Battery: typecheck 0, lint == baseline, build 0, tests == baseline +5 green.
- 2026-07-17: C1 ship-parked-inventory complete on `campaign/ship-parked-inventory` (awaiting L0 merge gate). §1 fully dispositioned: palmier-15 (all 6 items, Waves A/B/C) merged-to-campaign @3af26f35 (tier: verified locally, smoke — VU meter + both e2e-bridge seams live, 0 console errors); money + upscale gated packets in `docs/campaigns/ship-parked-inventory.md` (all 5 fal APIs verified current); kill-list verified (0-ahead proofs incl. the two "held" fix branches = ancestors of main); fork-sweep doc salvaged @399aa759. Filed BUG15–16. Battery: typecheck 0, lint == baseline (347e/225w), build 0, bun test 1846 pass / 14 fail all triaged pre-existing or order-dependent.

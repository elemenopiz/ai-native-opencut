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
| G2 | **Push cadence decision** — local `main` is ahead of origin (was 7 commits on 2026-07-17: board/takes review-fix batch); push = prod deploy | Unpushed work doesn't exist for users | gated(user) |
| G3 | Resend sender-domain verification — reset/verify emails are log-only in prod | Strangers can't reset passwords | gated(user) |
| G4 | Provider spend caps on dashboards (BytePlus $25 pool, Gemini, Kimi, fal if upscale lands) | Courtesy-credit chunks make runaway spend possible | gated(user) |
| G5 | Rotate the Vercel token used during B2 | Standing hygiene item from the deploy | gated(user) |
| G6 | Commit untracked docs: `apps/web/docs/compliance/`, `docs/plans/2026-07-15-hevc-cross-browser-decode-design.md`; gitignore `.playwright-mcp/` artifacts | Work product sitting untracked in the shared checkout | done(2026-07-17, L0 mission control) |
| G7 | **C4 UI taste-gate** — review `apps/web/docs/design/2026-07-17-ui-direction-phase-a.md` (+11 screenshots in `docs/design/assets/`): pick direction A/B/C, answer the 6-question set in §7 (export CTA, accent policy, icon rail, mechanical-batch pre-approval, tasks popover). Phase B implementation is blocked on this | Wave-1 C4-A merged @c5864ac4; recommendation = A "Instrument-Grade Minimal" | gated(user) |

## 1 · Integration sweep (built work parked on branches — decide merge/kill, then delete)

Branches with real deltas (`git rev-list --count main..<b>` on 2026-07-17):

| Branch | Δ | What it is | Call needed |
|---|---|---|---|
| `integrate/palmier-2026-07-14` | 15 | The 6-item Palmier delta wave (built clean-room, freeze-held; Wave D never approved) | Freeze is over → review, re-battery against current main, merge or split |
| `fix/credit-audit-money-gated` | 6 | Money packet: credit LOWs #6–#10 + #14 async persona-still + money tests | **Money floor — user-reviewed gated merge only** |
| `poach/verb-telemetry` | 6 | Director verb telemetry | Verify + merge or kill |
| `poach/staged-export-jobid` | 5 | Staged export w/ job id | Verify + merge or kill |
| `integrate/palmier-wave-a` | 4 | Likely subsumed by the 07-14 integrate | Confirm subsumed → delete |
| `feat/upscale-backend` | 2 | Tiered fal.ai upscale (Topaz default) + migration 0012; **4 fal APIs unverified** | Verify APIs against fal docs first; migration ⇒ gated |
| `feat/beta-gate-models-audio-templates` | 2 | Uninspected | Inspect → decide |
| `poach/scrub-audio-vu-meter` / `poach/mcp-project-binding` / `poach/chroma-luma-lut-check` / `poach/agent-undo-origin` | 1 each | Small poach tail | Verify + merge or kill |
| `wip/local-ai-session-rescue-2026-07-12` | 1 | Local-AI is FROZEN (ADR-004) | Almost certainly delete |

**Branch hygiene:** ~13 branches at 0-ahead (landed or superseded — incl.
`fix/project-switch-hardening`, `fix/b1-text-background-crash`, `perf/hevc-passthrough-hw-decode`,
`perf/export-decode-tier`, `fix/scope-playback-perf`, `poach/subtitle-import`,
`poach/keyframe-clipboard`, `feat/director-*`, `feat/audio-gen-backends`,
`feat/openai-google-models`, `axis4-export-bench`) plus ~13 stale `worktree-agent-*` branches
and any orphaned worktrees → confirm landed, then delete. `open`

## 2 · Live bugs

| # | Bug | Evidence | Status |
|---|---|---|---|
| BUG1 | `generateProxy()` 480p odd-dimension crash (853×480 rejected by AVC encoder — scale math doesn't round to even) | perf audit B2; verify whether the proxy-worker-offload merge (@20066e26) fixed it | open |
| BUG2 | fps60 playback wedge — one `getFrameAt` stalled 81s (N=1), decode-scheduler starvation under over-demand | perf audit B4; needs repro attempt | open |
| BUG3 | Sign-in rate limit shows the same generic toast as a bad password | auth sweep papercut | open |
| BUG4 | Onboarding tour arrow-key nav unresponsive (buttons/dots work) | onboarding merge note | open |
| BUG5 | Two duplicate voiceover UIs — reconcile into one | gen-UI packet flag | open |
| BUG6 | Dual LUT systems (`lut` inline picker vs registry `lut-3d`, intensity 100-vs-1 scale ambiguity) | poach-wave note | open (product call) |
| BUG7 | Command palette doesn't open on Cmd/Ctrl+K under headless Chromium — hands-on repro needed (focus-dependent or real binding bug?) | C4-A capture pass | open |
| BUG8 | Export-popover × anon-signup-tooltip z-order collision | C4-A shot 08 | open |
| BUG9 | Background-tasks toast/popover occludes timeline clips (and overlaps Export dialog watermark section) | C4-A shots 03/04/08 | open |
| BUG10 | Text-preset labels render doubled truncation fragments ("Body Text…ext") | C4-A shot 10 | open |
| BUG11 | `EditableProjectName` has no keyboard path into edit mode (`editor-header.tsx:449-523`) | C4-A a11y finding | open |

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
| F1 | **Character-consistency deepening** — persona/seed-lock UX polish + Runway Aleph interim route for real-face VFX (BytePlus verified-asset partner access is the blocked long pole — asset:// picker already shipped) | Moat #1; Higgsfield's #1 captured gap | open |
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
| C5 | 8420 health-poll leak (verify-lane finding) | open |

## 7 · Campaign roster (Mission Control — see `.claude/fable-mission-control.md`)

| Campaign | L1 status | Branch | Territory | Last update |
|---|---|---|---|---|
| C1 · Ship the parked inventory | launching | `campaign/ship-parked-inventory` | queue §1 branches (merge-shaped, broad); money branch = prep-only; upscale = verify-then-gate | 2026-07-17 L0 |
| C7 · Bug purge wave 1 | launching | `campaign/bug-purge-w1` | golden-path browser hunt + queue §2 repros; surgical non-hot-file fixes only | 2026-07-17 L0 |
| C12 · Test depth | launching | `campaign/test-depth` | tests only (`*.test.ts`, `*.e2e.ts`, e2e harness, CI yaml) | 2026-07-17 L0 |
| C4 · UI excellence — phase A | **done — merged @c5864ac4**; phase B gated on user taste-gate (G7) | `campaign/ui-direction-phase-a` | design-only (delivered: direction doc + 11 shots) | 2026-07-17 L0 |

## In-flight (claim before dispatching — session · items · owned files)

| Session | Item(s) | Owned files | Since |
|---|---|---|---|
| — | — | — | — |

## Done log (move rows here with sha + verification tier)

- 2026-07-17: Queue seeded (prompt-suite v2 revamp session).
- 2026-07-17: G6 untracked docs committed + `.playwright-mcp/` gitignored @3c7e41c8 (L0, docs-only).
- 2026-07-17: C4 phase A UI direction pass merged @c5864ac4 (tier: merged — docs+screenshots only, no product code). Deliverable: `docs/design/2026-07-17-ui-direction-phase-a.md`; recommendation = direction A "Instrument-Grade Minimal"; phase B blocked on G7 taste-gate. Found BUG7–BUG11.

# Palmier delta-refresh — 2026-07-14

**A delta pass, not a cold start.** Baseline = our 2026-07-09 pass
(`palmier-delta-refresh-2026-07-09.md`, pinned at v0.6.3 / HEAD `cd74ce3`,
MCP surface frozen at 45 tools, verdict QUIET). This pass diffs exactly
**`cd74ce3..092bc9e`** (36 commits, 2026-07-08 → 2026-07-13, releases
v0.6.4 / v0.6.5 / v0.6.6). Method: seven parallel Sonnet sub-agents (release
delta, agent/MCP surface, generation pipeline, timeline core, color/scopes,
UI/UX, traction), each handed the baseline docs so they report *delta only*;
Fable synthesis. All findings from `palmier-pro` are **IDEA-ONLY** (GPL-3.0
vs. our MIT) — clean-room reimplementation of mechanisms, never code. The one
code-poachable item comes from `palmier-skills` (Apache-2.0), flagged
separately.

---

## 1. Header

- **Competitor:** Palmier Pro (`palmier-io/palmier-pro`), Palmier Inc. (YC S24).
- **One line:** "The video editor built for AI" — macOS-native NLE with an
  in-app Claude agent and a local MCP server.
- **License / stack / platform:** GPL-3.0, Swift + Metal/Core Image,
  macOS 26 Tahoe + Apple Silicon only. **IDEA-ONLY for us.**
- **Pricing (re-verified 2026-07-14, unchanged):** Free / Pro $29 launch
  (reg. $49, 5,000 credits ≈ "333 images or 3–7 min video") / Max $69 (reg.
  $99, 12,000 credits) / Custom. Still **no BYO API key**.
- **Traction:** **10,556★ / 794 forks / 80 open issues** (2026-07-14). Delta
  vs. 07-09: +~350★, +33 forks in 5 days (~70★/day — no longer flat). Still
  2-person team, $500K seed, no Series A (Crunchbase/PitchBook re-checked).
- **Baseline pin:** v0.6.3 / `cd74ce3` (2026-07-09 pass). **This pass:**
  v0.6.6 / `092bc9e` (2026-07-13), verified 2026-07-14.

---

## 2. Delta verdict

**ACTIVE — the quiet week is over.** Three releases in five days shipped four
real capabilities (multicam v2, audible scrub + timeline meter, cancellable
export queue, ElevenLabs voice-cleanup/dubbing), one tool-surface change
(45→46), and a strategically interesting MCP-session hardening — while their
**identity wedge stayed absent, their scopes UI stayed absent, and their MCP
reliability publicly cracked under real automation workloads** (issues #302,
#320). Nothing they shipped erodes our core wedges; two things they shipped
are cheap, high-fit poach ideas for us; and their bug tracker handed us a new
attackable weakness.

---

## 3. Priority table

Every row **idea** (GPL clean-room) unless marked. Tiers: T1 = close or
can't-win, T2 = credibility gap, T3 = nice-to-have. `S`=hours, `M`=1–3 days,
`L`=1–2 weeks.

| # | Poach | idea\|code | Relevance | Effort | Tier |
|---|---|---|---|---|---|
| 1 | **MCP session→project binding + read/write split** (refuse stale-session mutations; read-only allowlist) — 🟡 **BUILT 2026-07-14**: mismatch refusal on `poach/mcp-project-binding` @4b0d3973 + origin-tagged agent undo on `poach/agent-undo-origin` @1215e783 (held by B3 freeze, founder merge gate; ledger rows 19–20). Audit finding: token binding, `mutating`-flag read/write split, short-id, and mutation-delta were ALREADY on main — this table's P0 framing was stale at write time | idea | Agent-reliability is our claimed wedge; their users are hitting this bug class publicly *now* | S | **T1** |
| 2 | **Grain-based audible scrub + timeline VU meter** (50ms faded PCM grains while dragging playhead; L/R peak meter w/ decay + clip-latch) — 🟡 **BUILT 2026-07-14** on `poach/scrub-audio-vu-meter` @086c258d (ledger row 24; freeze-held) | idea | "Serious editor" timeline feel; most web NLEs mute during scrub | M | **T2** |
| 3 | **Chroma-key low-luma gate** (third smoothstep excluding near-black noisy-hue pixels from the key mask) — 🟡 **BUILT 2026-07-14** on `poach/chroma-luma-lut-check` @08bfca01 (gate WAS missing; ledger row 21; freeze-held) | idea | Concrete, evidence-backed fix; only shows on real footage | S | **T2** |
| 4 | **Cancellable FIFO export queue + staged-output atomic write** (`.partial` file → atomic move; cancel never corrupts destination) — 🟡 **PARTIAL 2026-07-14**: staged handoff gate + jobId contract seam BUILT on `poach/staged-export-jobid` @4224682b (ledger row 22; freeze-held); queue itself deliberately deferred. Audit: our export is in-memory→download, no partial-file corruption path existed | idea | Export credibility; agent + manual exports share one queue | M | T2 |
| 5 | **`keyframe-animation` agent skill** (palmier-skills PR #4 — playbook for keyframe verbs: clip-relative frames, layout-deletes-keyframes ordering, verify-via-inspect) | **code** (Apache-2.0, **unmerged external PR** — founder-gate) | We *have* timeline keyframes; Director has no keyframe verbs yet | S | T2 |
| 6 | **Per-verb telemetry + "MCP activation = first successful call"** metric — 🟡 **BUILT 2026-07-14** on `poach/verb-telemetry` @f1b98315 (ledger row 23; freeze-held; extends the @2b8cecce baseline another session shipped) | idea | We log nothing per Director verb today | S | T3 |
| 7 | **Voice-cleanup / dubbing as AI-edit kinds on the existing generation surface** (declarative gating enum + `targetLanguage` + source-as-reference-tile) | idea | Extends our audio story; ElevenLabs adapter fits our router | M | T3 |
| 8 | **Multicam v2 mechanism** (audio cross-correlation sync w/ capture-date seeding; coverage-clamped angle switching on a flat program track; layout slots) | idea | Real-footage depth; off-thesis during beta — document, don't build | L | T3 |
| 9 | **65+-point `.cube` LUT check** (their bug: stale 64-cap rejected Resolve's default 65-pt exports — verify our parser accepts ≥65) — ✅ **VERIFIED FINE 2026-07-14**: our parser bounds are 2–128, 65 passes; acceptance test banked @08bfca01 | idea | One-line sanity check on our LUT import | S | T3 |
| 10 | 10-bit HDR export (HEVC Main10, BT.2020+HLG) | idea | SDR→HLG remap bolted on at export; PQ path is dead code; WebCodecs Main10 is a platform gate; our distribution is SDR social | — | **SKIP for now** |

---

## 4. Per-poach detail

### 1. MCP session→project binding + read/write split (T1, idea)

**What it is.** PR #299 (`b8a1491`, 2026-07-13) looks like tool consolidation
(4 project tools → 1 `manageProject{action}`) but the load-bearing change is
architectural: **external MCP sessions now bind to a specific project**
(`boundProject`) instead of tracking whichever project is frontmost. If the
user switches projects mid-session, mutating tool calls are *refused* with
"This session is on 'X', but 'Y' is active…" — while read-only tools
(`get_timeline`, `get_media`, …) stay allowed via a `canReadInactiveProject`
allowlist.

**Why now.** Issue #302 (2026-07-12) is a studio operator batch-producing
reels over their MCP who hit `manage_tracks` silently mis-targeting tracks,
an **unauthenticated localhost MCP endpoint**, and open headless questions —
answered only with "let's hop on a call." Issue #320 (2026-07-14) is an
`NSUndoManager` crash during MCP agent edits in v0.6.6. Real users are
stress-testing agent-driven editing and finding it brittle.

**Our reimplementation.** Our MCP server (`sprint2` — HTTP/SSE, per-project
token auth, relay-bridge to EditorCore) already has per-project *tokens*, which
partially covers this. Audit the seam: (a) when the browser session's active
project ≠ the token's project, mutating verbs must refuse with a structured
error naming both projects — not silently act on the wrong store; (b) classify
our ~51 Director verbs read vs. mutate and allow reads cross-session;
(c) verify every relay path resolves the project from the token, never from
"current editor state." Also fold in #307's lesson (below): stable IDs over
indexes in every verb contract.

### 2. Grain-based audible scrub + timeline VU meter (T2, idea)

**Mechanism (theirs, #293 `f8b6048` + hardening #305 `07d1644`/#306
`5188652`).** Not time-stretch: a classic tape-scrub grain player at native
pitch. Decode a ~2s PCM window (96k samples @48kHz) around the playhead on a
background task; on each scrub tick extract a 50ms grain (2,400 samples)
centered on the current sample, built forward or reverse by scrub direction,
with 3ms linear fades to kill clicks. Single-frame arrow-key stepping plays an
audible blip at the landed frame. #305 moved playback off the main thread onto
a hand-rolled output after the naive audio-graph version glitched.
Meter: per-channel peak (their `vDSP_maxmgv`) → dB with asymmetric decay
(level 24dB/s; held peak 18dB/s after 1.5s hold), −60dB floor, and a **red
clip segment that latches until clicked**. Docked as a fixed-width panel right
of the timeline.

**Our reimplementation.** Grain player keyed off playhead-drag deltas,
decoupled from normal playback: decode window via mediabunny (already our
decode stack), grains through a Web Audio `AudioBufferSourceNode` with gain
ramps for the 3ms fades. Hook into the timeline playhead drag path — note our
`notifyTime` tick channel (playback-tick work, @2b2079c4) is exactly the seam
to drive it without tree reconciles. Meter: `AnalyserNode` (or tap the same
PCM window) + a small decay state machine mirroring their dB thresholds;
render on canvas next to the timeline. The clip-latch-until-click detail is
worth keeping.

### 3. Chroma-key low-luma gate (T2, idea)

#291 (`6304cda`) added a third `smoothstep(0.04, 0.12, dd)` factor to their
key mask — regression test: *"near-black chroma noise stays opaque."* Without
it, near-black pixels with noisy/undefined hue (shadows, compression
artifacts) get falsely keyed out. This bug class only appears on real footage,
not synthetic green-screen tests. **Action:** check our chroma-key shader for
an equivalent low-luma exclusion before the hue-distance mask; if absent, add
a luma-floor gate. Same PR also added `premultiplyingAlpha()` normalization
around the composite path — worth a matching audit if we see fringing.
(The eyedropper UX itself we already have; their one nice detail — entering
sample mode *temporarily disables* the key effect so you pick from the raw
frame, auto-cancelling on selection/tab change — is a T3 nicety.)

### 4. Cancellable export queue + staged-output write (T2, idea)

#298 (`0388343`): app-wide FIFO `ExportQueue` singleton, one active job,
statuses `queued→preparing→rendering→(canceling)→completed|failed|canceled`,
per-destination dedup, agent exports (`source: agent`) routed through the same
queue, `manage_exports {list|cancel}` agent tool, and `export_project` now
returns `jobId` instead of blocking. **Load-bearing idea:** all writes go
through a staged output — hidden `.{stem}-{uuid}.partial` file, atomically
moved to the destination only after write + final cancellation check succeed.
A cancelled/crashed export never leaves a corrupt file, and re-export never
clobbers the old good file early. UI: settings pane + queue log pane, primary
button flips "Export"→"Add to Queue" when a job is active, pulsing title-bar
dot while running. **Ours:** when we outgrow single-shot export, this is the
shape — for web, "staged write" = render to temp OPFS file/blob (or staged R2
key), swap on success; Director's export verb returns a jobId and gains
list/cancel.

### 5. `keyframe-animation` agent skill (T2, **CODE** — founder-gated)

The only code-poachable finding. `palmier-io/palmier-skills` is Apache-2.0
(license re-verified via API this pass). Merged content is unchanged since our
4-skill port — but **open PR #4** (external contributor Ripwords/JJ Teoh,
2026-07-12, commit `e69b5c1`, unmerged) adds `skills/keyframe-animation/SKILL.md`:
a complete agent playbook for keyframe animation. Highlights: frames are
clip-relative not timeline-absolute; whole-track replacement semantics (never
patch); ≥2 keyframes, no extrapolation; position = top-left not center, scale
= canvas fraction; **order-of-operations traps** (apply_layout *deletes*
keyframe tracks → layout first, keyframe last; retimes clamp-and-drop
keyframes; opacity keyframes *multiply* with fade handles = double-fade risk);
recipes (Ken Burns, PIP slide-in, duck-under-VO); verify via inspect at
start/mid/end because scrub previews seek coarsely. Our baseline marked
keyframe verbs "⛔ until our timeline has keyframes" — **we have keyframes
now** (bezier easing, keyframe clipboard). When Director grows keyframe verbs,
this doc is the system-prompt skill to adapt. Caveats: unmerged, unreviewed
external PR (Apache still covers the contribution, but treat as unvetted
design authority); founder-gate before lifting text. CANDIDATE row added to
POACH-LEDGER.

### 6. Per-verb telemetry + activation metric (T3, idea)

#297 (`f0f5b47`) + #317 (`d671db4`): every tool call fires an analytics event
(name, source `agent|mcp`, project, status, duration, `timelineChanged`), and
"MCP session activated" counts on **first successful tool call, not TCP
connect**. We log nothing per Director verb today; when we add telemetry, copy
the activation≠connection distinction and the `timelineChanged` flag (it's
the cheap proxy for "did the agent actually do something").

### 7. Voice-cleanup / dubbing pattern (T3, idea)

#294 (`0e53593`): ElevenLabs Voice Isolator + Dubbing wired as two new
categories (`.cleanup`, `.dubbing`) on the *existing* `generate_audio` tool —
no new tool, no new panel. Patterns worth copying when we do audio AI-edits:
(a) a declarative availability enum per edit kind (asset type, has-audio,
in-flight, span bounds — each with a human-readable disabled reason); (b)
trim-aware source extraction (clip's trimmed range → .m4a before upload, not
the whole asset); (c) the source clip rendered as a standard reference tile in
the shared generation panel + a `targetLanguage` picker fed from the model
catalog. Fits our provider-router; our ledger already has DeepFilterNet as the
local-isolation HUNT candidate — ElevenLabs becomes the hosted-quality rung.

### 8. Multicam v2 (T3 now — document, don't build)

#283 (`141c69b`, 2,627 insertions/32 files, 758 lines of tests) — their
biggest delta, and much bigger than our fork-sweep's "multicam flatten-export"
framing. Mechanism worth recording for a post-beta decision:

- **Model:** project-level `MulticamSource` entity (members typed
  `angle|mic|both`, per-member `SyncMap{offsetSeconds, confidence, locked}`,
  master member = group clock); clips carry a denormalized `multicamGroupId`.
  Both fields optional → zero migration.
- **Sync:** audio envelope cross-correlation (FFT) against a growing anchor
  set, **seeded by embedded capture-date metadata** (narrow window first, full
  search fallback), timecode-only fallback for silent members, earliest-member
  rebase to offset 0, per-member confidence + manual lock.
- **Editing:** no multi-monitor switcher — a flat **program track** built by
  hole-filling coverage, angle switches via right-click submenu or
  range-selection "Switch Angle in Range"; `MulticamEngine` splits at range
  bounds, **clamps to the target angle's actual coverage** (reports the
  culprit), rewrites source refs, merges through-edits back. 10 named PIP/grid
  layouts place overlay clips. Guardrails: groups move as a unit, trims
  clamped by sibling coverage, silence-removal intersects dead-air masks
  across all mics.
- **Flatten:** free — the program track *is* flat; ungroup just strips tags.
- **Agent:** 3 tools (`manage_multicam`, `change_cam` batched switches in one
  undo step, `get_multicam` run-length program readout).

For a generation-first product in beta week this stays off-thesis. If
"serious editor" positioning later demands real-footage depth, this flat
program-track design (vs. Premiere-style nested sequences) is the shape to
clean-room — it composes with our existing auto-cut (their dead-air×multicam
intersection is the proof).

### 9–10. Small checks / skips

- **LUT 65-pt check (#296 `a6dec08`):** their 64-entry cap was a stale
  holdover; 65 is Resolve's default `.cube` export size. Verify our parser
  accepts ≥65 (S, one test).
- **HDR export (#138 `58c9429`): SKIP.** Real per-pixel SDR→HLG conversion
  (not a tag relabel), but the compositor still grades in SDR Rec.709 — it's a
  tone-mapped-up export, not an HDR pipeline; the PQ path is dead code
  (`exportHDR` hardcodes HLG). For us the gate is WebCodecs HEVC Main10
  encoder availability (platform ceiling) and our 8-bit canvas pipeline; our
  distribution targets (Reels/TikTok/Shorts) are SDR. Revisit only if a
  10-bit web encode path materializes.
- **Agent undo (#318 `cfe6425`):** their bug was `NSUndoManager`
  event-grouping — platform-specific, doesn't transfer. The transferable rule:
  **every agent mutation = one explicit, atomically-named undo group**, even
  multi-step. Reinforces (doesn't change) our P1 origin-tagged agent-undo
  design. Their same-day regression #320 shows how easy this is to get wrong.
- **Track addressing (#307 `d87faae`):** indexes drift mid-batch; fix = stable
  `trackId` preferred, index as legacy fallback, system prompt steers to IDs.
  Direct confirmation of our mutation-delta spec's staleness warning — keep
  stable-ID addressing non-negotiable in verb contracts.

---

## 5. Three-column ledger — already / newly-available / still-a-gap

| # | Already-poached (don't re-mine) | Newly-available (this pass) | Still-a-gap (unbuilt backlog) |
|---|---|---|---|
| 1 | 45-tool MCP catalog (`palmier-mcp-schema-spec.md`) | **45→46**: 4 project tools → `manageProject`; +`manageExports`, +`manageMulticam`/`changeCam`/`getMulticam` (spec needs a delta note) | Our MCP one-click installers |
| 2 | Mutation-delta algorithm | `trackId` joined their short-id universe (#307 — validates the design) | Mutation-delta returns on our mutating verbs (P0) |
| 3 | Short-id prefix algorithm | unchanged | `lib/director/short-id.ts` (P0) |
| 4 | Agent-scoped undo mechanism | #318 lesson: one explicit atomic named group per tool call; their v0.6.6 regression #320 proves fragility | Origin-tagged agent undo (P1) |
| 5 | sixsevenstudio (exhausted) | still stale | — |
| 6 | palmier-skills 4 skills ported | **`keyframe-animation` skill in open PR #4** (Apache-2.0, unmerged — CANDIDATE) | Port when Director grows keyframe verbs (timeline keyframes already exist on our side) |
| 7 | Colorist engine mapped; our LUT UI shipped | 65-pt LUT fix (check our parser); **chroma-key low-luma gate**; premult-alpha normalization; **still no vectorscope/waveform UI at HEAD** | Color scopes engine (fake auto-correct), wheels/curves |
| 8 | Reference-image-token-only consistency | **Wedge re-verified in code at `092bc9e`**: zero persona/character/identity entity; `VideoModelConfig` byte-identical | Persona→omni-reference routing; multi-character ceiling; reference-sheet mode (unchanged backlog) |
| 9 | Model catalog shape | Catalog is **server-side Convex** (`models:list`) — model/pricing changes now invisible to code audit; only audio schema grew (`.cleanup`/`.dubbing`, `targetLanguages`) | Server-driven live catalog on our side |
| 10 | Their brain = Sonnet 5 | **Free tier now gets Sonnet 5** (#292 — dropped Haiku gating; burn signal for a 2-person seed co) | ~~Director off Ollama~~ **partially closed our side** (Gemini Flash native brain landed @d92c2e76; live smoke + picker still open) |
| 11 | Beat/silence/sync shipped (pre-baseline) | v0.6.3 release notes *headline* on-device silence-removal + beat-snap (parity pressure on our auto-cut — ours landed 07-13) | Wire beat-grid/LUFS verb (our context-gap audit item) |
| 12 | `palmy` (no license) | unchanged, still not copyable | — |
| 13 | — (multicam untracked before) | **Multicam v2 full mechanism** documented (§4.8) | Multicam story = post-beta decision, not a beta gap |
| 14 | — | **Export queue + staged atomic write + `manage_exports`** | Our export queue/cancel + jobId verb when needed |
| 15 | — | **MCP session→project binding + read/write allowlist** (#299); their MCP reliability cracking publicly (#302/#320, unauthenticated localhost endpoint) | Audit our MCP/Director seam for stale-session mutation refusal (T1 row) |

---

## 6. Their weakness = our wedge

1. **Their agent surface breaks under real automation — ours can claim
   reliability.** Power users batch-producing over their MCP hit silent track
   mis-targeting (#302), an **unauthenticated localhost MCP endpoint** (#302),
   and an undo-manager crash in the release that shipped that morning (#320).
   Their founder's answer was "hop on a call." Ours has per-project token
   auth and a smaller, testable verb layer. Headline: *"Byorn's agent tools
   are authenticated, project-bound, and don't corrupt your undo stack."*
   (Claim it **after** we run the #1 audit on ourselves.)
2. **Still no character identity system — re-verified in code at HEAD.** Zero
   persona/character entity; reference arrays rebuilt per call. Headline
   unchanged: *"Seed-locked characters that persist across every shot vs.
   re-uploading a reference image every generation."*
3. **Still no vectorscope/waveform UI** (grep-verified at `092bc9e`). Their
   rich `ColorScopes.measure()` engine remains agent-only numbers. A visual
   scopes panel remains a place we can *lead*.
4. **Platform lock unmoving; the community is routing around them.** #195/#262
   have zero maintainer replies; two unofficial cross-platform rewrites now
   exist (TimLai666/fronda, Voidsprog/palmier-pro-windows). Demand for
   cross-platform Palmier is being served by strangers.
5. **They ship silently.** 0.6.5/0.6.6 have empty changelogs, no release
   descriptions, `/changelog` 404s; multicam, dubbing, and the export queue
   appear nowhere in marketing. Feature velocity without narrative = free air
   cover for our announcements.
6. **Credit economics complaints recur; free Sonnet 5 raises their burn.** HN
   still gripes "$30–50/mo for 3–7 min of video"; no BYO key; and #292 now
   serves Sonnet 5 to free users — costly generosity on a $500K seed.

---

## 7. Freshness note

- **Range diffed:** `cd74ce3..092bc9e` (36 commits, 2026-07-08 → 2026-07-13;
  releases v0.6.4 2026-07-10, v0.6.5 2026-07-11, v0.6.6 2026-07-14 UTC), fresh
  `--depth=400` clone, verified 2026-07-14. All seven axes primary-source
  (git show / gh api / live site).
- **Org sweep 2026-07-14:** same 7 repos, none new. `palmier-skills`
  Apache-2.0 re-verified via API; `main` unchanged since 2026-06-30 (its
  `updated_at` is PR noise); `palmy` still unlicensed.
- **Corrections vs. prior docs:** (a) MCP spec tool count 45→46 with the
  §5-row-1 composition — spec doc needs the delta note; (b) fork-sweep's
  "multicam flatten-export" gap description undersold what shipped (see §4.8);
  (c) 07-09 doc's "still-a-gap: Director off Ollama" is now partially closed
  on **our** side (Gemini native brain landed).
- **Blind spot to accept:** their model catalog + credit pricing moved
  server-side (Convex) — future model/pricing deltas will NOT show in code.
  Watch palmier.io/pricing and release notes instead.
- **Re-check triggers:** next `feat`/`[agent]` commit touching
  `ToolDefinitions.swift`; any maintainer reply on #302/#320 (MCP reliability
  story); any Series A / platform announcement; palmier-skills PR #4 merging
  (upgrades our CANDIDATE from unvetted to reviewed).

---

## The 3 highest-leverage moves this delta implies (ranked)

1. **Run the agent-reliability audit on ourselves, then claim the wedge**
   (§4.1 + #318/#307 lessons): stale-session mutation refusal on our MCP
   seam, one atomic named undo group per Director verb, stable-ID addressing
   in every verb contract. Small effort, directly attacks the failure class
   their users are complaining about in public, and hardens the exact surface
   our "real tools, not passthrough" positioning rests on.
2. **Grain scrub audio + timeline VU meter** (§4.2): the cheapest
   "feels like a serious editor" upgrade on the table, proven demand (they
   shipped and immediately hardened it), and it rides our existing mediabunny
   decode + playback-tick seams. Post-beta wave 1.
3. **Bank the two S-size correctness checks now, spend later:** chroma-key
   low-luma gate (§4.3) and ≥65-pt `.cube` acceptance (§4.9) — trivial to
   verify, embarrassing to be caught missing; plus file the staged-output
   export pattern (§4.4) as the design for whenever export queueing lands.

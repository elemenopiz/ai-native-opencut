# Palmier conformance pass — 2026-07-17

Precise, evidence-cited delta of Byorn's **actual current** MCP/agent tool
surface against the reverse-engineered Palmier spec. Sibling to (and
supersedes the staleness of) `apps/web/docs/poach/palmier-mcp-schema-spec.md`
§"Our surface today (19 verbs)" and its "Coverage summary" table — both were
written against an early snapshot and are now badly stale.

**License boundary (binding, inherited from the spec doc header):**
`palmier-pro` is GPL-3.0. Nothing below reproduces their code, schema JSON,
parameter names, or description strings — tool names are paraphrased
descriptions of behavior, and every citation points at OUR files.

**Method:** every row below was verified by reading the cited file/line
directly at `campaign/mcp-moat` @`9d3c936e` (branch `task/mcp-w5-conformance`),
not by trusting prior docs' verdicts. Several claims in the spec doc and the
campaign plan turned out to be stale or unverifiable — see the **Caveats**
section before relying on any single row.

---

## 0. Caveat — campaign doc status table does not match source

`apps/web/docs/campaigns/mcp-moat.md` (as committed on `campaign/mcp-moat`)
lists workers W1–W5 as `done — merged @<hash>` with specific commit hashes
(`6da77b7f`, `66ecb54a`, `36de5db3`, `01e93b21`, `1949a55c`). **None of those
hashes resolve in this repository** (`git cat-file -t <hash>` → "Not a valid
object name" for all five, checked from the shared checkout). `git worktree
list` shows the sibling worker branches (`task/mcp-w1-reliability`,
`task/mcp-w2-relay`, `task/mcp-w3-board-verbs`, `task/mcp-w4-guards`) each
pinned at commit `9d3c936e` — the exact same commit as `campaign/mcp-moat`
itself, i.e. the plan doc and nothing else. Corroborating: this checkout's
`apps/web/src/lib/director/tool-catalog.ts` has no
`getBoard`/`promoteBoardItem`/`discardBoardItem` entries, `editor-bridge.ts`
still documents its relay as in-memory/single-instance (not Redis-backed —
see §3), and no `mcp-reliability-e2e.test.ts` file exists anywhere in the
tree.

**Disposition below:** rows that the campaign brief names as in-flight
sibling work (Board verbs, Redis relay, reliability e2e, command-input
guards) are marked `landing-this-campaign (per plan; UNVERIFIED as of
2026-07-17)` rather than a flat `gap` — honoring the campaign brief's intent
while flagging that the completion claims could not be substantiated against
source. Treat those specific rows as gaps until an actual commit lands on
`campaign/mcp-moat`.

**Verb count:** `apps/web/src/lib/director/tool-catalog.ts` currently
declares **53** verb descriptors (every `name: "..."` entry in the returned
array of `toolCatalog()`, lines 507–1914; cross-checked against 53
occurrences of `mutating: true|false`). The task brief's "~54" and the
campaign doc's "57 tools" are both close but not exact against this
checkout — 53 is the verified count as of this pass.

---

## 1. Per-tool delta table (Palmier v0.6.6, 46-tool surface)

Legend: ✅ covered · 🟡 partial · 🔺 gap · ⛔ n/a.
Disposition: **done** (verb exists, evidenced) · **landing-this-campaign**
(see caveat above) · **queue-row** (paste-ready text follows the table) ·
**n/a** (one-line reason inline).

### Projects (v0.6.6: 4 tools consolidated into 1 router)

| # | Their tool (paraphrased) | Our equivalent | Evidence | Status | Disposition |
|---|---|---|---|---|---|
| 1 | project router: list/open/create/close, MCP-only, session binds to a project | none — a Byorn MCP token is minted per-project (`POST /api/mcp/tokens`) and the session pins to it for its whole life; there is no in-band list/open/create/close | `apps/web/src/lib/mcp/auth.ts:47-70` (`verifyProjectToken` resolves one `{userId,projectId}` pin per token); `apps/web/src/app/api/mcp/route.ts:107-121` (session pinned to that grant at `initialize`, 403 on mismatch) | 🔺 gap | queue-row Q1 |

Our token-per-project model is actually a *stronger* binding primitive than
their frontmost-window one (see §2 "project binding"), but it means an
external client can't discover or switch projects in-session — it must
already hold the right token. That asymmetry is the real gap, not the
binding mechanism itself.

### Timeline reads & settings (v0.6.6: 6 + new export-queue tool = 7)

| # | Their tool | Our equivalent | Evidence | Status | Disposition |
|---|---|---|---|---|---|
| 2 | timeline read (windowed reads, gap listing, default-field omission, linked-audio folding) | `getReel` | `apps/web/src/lib/director/tool-catalog.ts:507-518`; `director-api.ts` `getReel()` ~L889-899, `toSnapshot()` L668-679 | 🟡 partial — no windowing param, no gap listing, no default-field omission (every `SlotSnapshot` field is always emitted); covers generative slots only, not plain media/text/audio elements | queue-row Q2 |
| 3 | composited-preview inspect (render N frames + visible-clip-ids) | `reviewTake` (decodes a take's frames) + `extractFrame` (single still) — narrower than a full composited-preview observation | `director-api.ts` `reviewTake()` L3555, `extractFrame()` L2981; `tool-catalog.ts:1303-1336`, `:1124-1167` | 🟡 partial (upgraded from the spec doc's flat "gap" — we now have SOME frame-as-observation capability, just scoped to one take/still, not a composited multi-clip preview at a timestamp) | queue-row Q3 |
| 4 | create/switch timeline (multi-timeline, duplicate-as-branch) | none — single timeline per reel | n/a by architecture | ⛔ n/a | n/a — no multi-timeline model exists; revisit only if the project store grows sequences |
| 5 | project canvas settings (fps/aspect/resolution + auto-refit) | none | no `setReelFormat`/equivalent verb found in `director-api.ts` or `tool-catalog.ts` | 🔺 gap | queue-row Q4 |
| 6 | export render (async, returns jobId) | `export` | `director-api.ts` `exportReel()` L4358-4448 — mints a `jobId`, typed against the full future `ExportJobStatus` lifecycle, but is single-shot/synchronous today (comment at L4347-4356 says explicitly: "no queue, no manage-exports verb, no queued/preparing/rendering state exists yet") | 🟡 partial | queue-row Q5 (shared with #7) |
| 7 | export-queue list/cancel over a FIFO queue | none | same citation as #6 — the jobId contract is a deliberate forward-compatible seam, but list/cancel don't exist | 🔺 gap | queue-row Q5 |

### Media library (5 tools, unchanged)

| # | Their tool | Our equivalent | Evidence | Status | Disposition |
|---|---|---|---|---|---|
| 8 | full media inventory (pending-status filter) | `getLibraryManifest` — faceted digest (counts by role, named heroes, face-anchor personas, searchable tail), not a full itemized inventory | `tool-catalog.ts:573-578`; `director-api.ts` `buildManifest()` ~L923-946 | 🟡 partial | queue-row Q6 |
| 9 | deep per-asset inspect (EXIF/frames/transcript) | none dedicated — `getTranscript` covers the timeline-transcript half; no single-asset deep-inspect verb | `tool-catalog.ts:581` (`getTranscript`, timeline-scoped, not asset-scoped) | 🔺 gap | queue-row Q7 |
| 10 | semantic search (CLIP visual + spoken, index-health signal) | `searchMedia` | `tool-catalog.ts:530-545` ("semantic search over indexed footage (CLIP embeddings)") | ✅ covered — spec doc's own "build #3" item, already shipped | done |
| 11 | media import (URL/local-path/base64/matte) | none | no `importAsset`/import verb found | 🔺 gap | queue-row Q8 |
| 12 | library housekeeping (folders, batch rename/move/delete) | none | no folder tree in the media panel | ⛔ n/a | n/a — no folder model exists; matches spec doc's own verdict |

### Clip & track operations (12 tools incl. undo, per the spec doc's own correction note)

| # | Their tool | Our equivalent | Evidence | Status | Disposition |
|---|---|---|---|---|---|
| 13 | batch place existing footage, auto-track creation | `addClip` (single, existing media → real clip) | `director-api.ts` `addClip()` L1336; `tool-catalog.ts:1866-1899` | 🟡 partial — single-clip only, no batch/auto-track-creation mode | queue-row Q9 |
| 14 | ripple insert (non-destructive) | none — `reserveSlot` appends/places but never ripples later clips | `director-api.ts` `reserveSlot()` area (no ripple option in signature) | 🔺 gap | queue-row Q10 |
| 15 | batch move, linked-partner delta | `move` (single) | `director-api.ts:3901-3918` — takes `targetTrackId` (stable id, not index) | ✅ covered (single-element; batch is a nicety) | done |
| 16 | batch delete, link-group aware | `remove` (single) | `director-api.ts` ~L3985 | ✅ covered | done |
| 17 | batch split, two addressing modes | `split` (single, id+time) | `director-api.ts:3921-3936` | ✅ covered for the single case | done |
| 18 | batch cut-and-close-gaps | none — agent must `split`+`remove`+`reorder` across 3+ calls | no `cutRange` verb found | 🔺 gap | queue-row Q11 |
| 19 | batch speed/volume/opacity/transform set | none dedicated — `trim` covers timing only | `director-api.ts` `trim()` area L1615 (catalog), no speed/volume/opacity/transform setter verb | 🔺 gap | queue-row Q12 |
| 20 | whole-track keyframe replace | none — Director has no keyframe verb (manual timeline UI has keyframes per project memory, but the agent boundary doesn't expose them) | no keyframe verb in `tool-catalog.ts` | 🔺 gap | queue-row Q13 |
| 21 | named compound layouts, correct-by-construction | none | no `applyLayout` verb found | 🔺 gap | queue-row Q14 (lower priority — behind text/search per spec doc's own ranking) |
| 22 | track ops (reorder/mute/hide/sync-lock), stable trackId addressing | none dedicated, BUT the trackId-not-index lesson is **already the norm** across our verb surface | `move()`'s `targetTrackId: string` param (`director-api.ts:3901-3904`); `addText`/`addClip`/`applyEffect` all address elements/tracks by stable id, never index | 🟡 partial/deferred | queue-row Q15 |
| 23 | multicam/dual-system audio sync | none | n/a — generation-first product, no multi-camera capture workflow | ⛔ n/a | n/a — matches spec doc's own verdict; revisit only if real-footage editing becomes a priority |
| 24 | agent-scoped undo (refuses on human-edit-since) | `undo`/`redo` — origin-tagged, refuses when the top of the stack isn't the agent's own | `director-api.ts:4301-4331` (`undo()`/`redo()`, checks `peekUndoOrigin()`/`peekRedoOrigin()` against `"agent"`); origin tagging at `withAgentOrigin()` L4485-4507, applied to every verb except lifecycle via `wrapVerbs()` L4509-4526; test coverage `apps/web/src/lib/director/agent-undo.test.ts` (refusal + atomicity + mutation-delta-after-atomicity-fix, 3 `describe` blocks, 9+ `it`s) | ✅ covered — **exceeds** the spec (self-describing refusal messages naming whose edit it is) | done |

### Multicam (v0.6.6 NEW category, 3 tools)

| # | Their tool | Our equivalent | Evidence | Status | Disposition |
|---|---|---|---|---|---|
| 25 | multicam group/member sync management | none | no multicam entity anywhere in `director-api.ts` | ⛔ n/a | n/a — off-thesis for a generation-first product; `palmier-delta-refresh-2026-07-14.md` §8 already recommends "document, don't build" |
| 26 | batched angle switch | none | same | ⛔ n/a | n/a — same reason |
| 27 | program-track readout | none | same | ⛔ n/a | n/a — same reason |

### Transcript-driven editing (4 tools)

| # | Their tool | Our equivalent | Evidence | Status | Disposition |
|---|---|---|---|---|---|
| 28 | timeline-mapped, word-indexed transcript | `getTranscript` | `tool-catalog.ts:581-612` | ✅ covered — on-device Whisper pipeline backs this (project memory: `on_device_whisper.md`, @419a5c14) | done |
| 29 | word-index text-based editing | none | no `removeWords` verb in either file | 🔺 gap | queue-row Q16 |
| 30 | amplitude-based dead-air removal, ripple-close | `removeSilence` | `director-api.ts` `removeSilence()` L4003-4013, full `AutoCutApplySummary` return shape (threshold/margins/minKeep/minCut params) | ✅ covered — **better than the spec's framing**: ours is level-relative amplitude detection (project memory: `auto_cut_silence_removal.md`, shipped @0a921956), so it does NOT gate on a transcription pipeline the way the spec doc assumed | done |
| 31 | onset/BPM detection, independent of transcription | none | no `detectBeats`/bpm verb found | 🔺 gap | queue-row Q17 |

### Text & captions (3 tools)

| # | Their tool | Our equivalent | Evidence | Status | Disposition |
|---|---|---|---|---|---|
| 32 | batch text overlay | `addText` (single) | `director-api.ts` `addText()` L4204-4248; `tool-catalog.ts:1743-1773` | ✅ covered (single; batch is a nicety) | done |
| 33 | restyle/rewrite text by id or group | `updateText` | `director-api.ts` `updateText()` L4249-4286; `tool-catalog.ts:1774-1808` | ✅ covered (per-id; no caption-group addressing — we have no caption groups yet) | done |
| 34 | one-shot transcribe-and-style caption track | none | no caption-track-generation verb; `addText`/`updateText` require per-clip authoring | 🔺 gap | queue-row Q18 |

### Color, effects, audio cleanup (4 tools)

| # | Their tool | Our equivalent | Evidence | Status | Disposition |
|---|---|---|---|---|---|
| 35 | full colorist surface, merge semantics | none | no grading verb; no color-grade engine in `director-api.ts` | 🔺 gap, deferred | n/a for now — needs a grading engine first; not worth a queue row until one exists |
| 36 | live effect stack, registry-generated schema | `applyEffect` | `director-api.ts` `applyEffect()` L4136-4169 — validates `effectType` against `getAllEffects()` (a real registry, not a hardcoded enum), matching the exact "generate the catalog into the tool doc from the registry" pattern the spec doc praises | 🟡 partial — merge-by-type/enable-without-remove/canonical render order not verified present; the registry-driven validation is the piece that *is* confirmed | queue-row Q19 (small — verify/extend merge semantics) |
| 37 | color measurement / grade-vs-reference gap readout | none | n/a — needs the grading engine (#35) first | ⛔ n/a near-term | n/a — same blocker as #35 |
| 38 | on-device speech-enhancement denoise | none | n/a | ⛔ n/a | n/a — platform-specific model; would be a media-pipeline job, not a Director verb, if ever built |

### Generation (5 tools)

| # | Their tool | Our equivalent | Evidence | Status | Disposition |
|---|---|---|---|---|---|
| 39 | model capability catalog | `getBackends` | `tool-catalog.ts:613-637` ("list the generation models available now — each with modality, safety tier, seed-lock/reference-edit support, and a RELATIVE cost tier") | ✅ covered | done |
| 40 | async T2V/I2V/V2V generation, multi-reference, entitlement guard | `generate`/`reroll`/`remix` + `GenerationSpec` | `tool-catalog.ts:1029` (`generate`), `:1060` (`reroll`), `:1111` (`remix`); budget/entitlement gate in `director-api.ts` `evaluateSpend()` ~L2420-2460 (down-route/pause decisions against a live spend cap — a different but arguably richer entitlement mechanism than a flat signed-in/credits check) | ✅/🟡 covered in our generate-to-slot model; multi-reference input and trimmed-range-only source scoping are the genuine deltas still worth folding into `GenerationSpec` | queue-row Q20 (small refinement, not a new verb) |
| 41 | still generation | `generate` with `GenerationSpec.mode` | same citations as #40 | ✅ covered | done |
| 42 | TTS + music + video-to-audio scoring, v0.6.6 gained dubbing/cleanup + target-language | `addVoiceover` + `addMusicBed` (two separate verbs, not one kind-routed tool) | `tool-catalog.ts:1337-1392` (`addVoiceover`), `:1393-1434` (`addMusicBed`) | 🟡 partial — no video-to-audio "scoring" mode, no dubbing/voice-cleanup fields, no target-language param; auto-place-on-span behavior IS present (`addVoiceover` "Pass slotId to place it at that shot's start and match its length") | queue-row Q21 |
| 43 | async AI upscale | none | no upscale verb in `director-api.ts` or `tool-catalog.ts` | 🔺 gap | queue-row Q22 |

### Meta (2 tools)

| # | Their tool | Our equivalent | Evidence | Status | Disposition |
|---|---|---|---|---|---|
| 44 | agent-side capability-gap feedback | none | no `reportLimitation` verb found | 🔺 gap | queue-row Q23 |
| 45 | lazy-load full playbook body | none — we have the FIRST half only | `agent.ts:299` `PLAYBOOK_POINTER` (titles/descriptions only, embedded at `agent.ts:1462` and `:1756`); no `readPlaybook` verb exists to fetch the full body | 🔺 gap — cheap, spec doc calls this "nearly free" | queue-row Q24 |

### Sibling-campaign row (Board verbs — not in Palmier's surface, called out per task brief)

| # | Item | Evidence | Status | Disposition |
|---|---|---|---|---|
| 46 | Board verbs (get/promote/discard board item) | grep for these names across `tool-catalog.ts`/`director-api.ts` → zero matches; `task/mcp-w3-board-verbs` pinned at the same commit as the plan doc (`9d3c936e`, no additional commits) | 🔺 gap (not a Palmier tool — internal roadmap item) | landing-this-campaign (per plan; **UNVERIFIED** — see §0 caveat) |

**Tallies over the 46-row Palmier table (rows 1–45; row 46 is the
non-Palmier Board addendum):** **13 ✅ covered · 8 🟡 partial · 17 🔺 gap ·
7 ⛔ n/a** (n/a: create/switch-timeline, organize-media, sync-clips, the 3
multicam tools, inspect-color's near-term grading-engine dependency,
denoise-audio).

---

## 2. Cross-cutting mechanisms audit

Each mechanism from `palmier-mcp-schema-spec.md` §"Cross-cutting mechanisms",
checked against actual code:

| Mechanism | Implemented? | Evidence |
|---|---|---|
| **Short-id boundary** (shorten on output, expand on input, ambiguity errors) | ✅ yes | `apps/web/src/lib/director/short-id.ts` (86 lines) — `createShortIdMap()` builds shortest-unique-prefix map (`MIN_PREFIX = 8`, L16); wired at the agent boundary in `agent.ts:312-318` (`reelShortIdMap()`) and `agent.ts:517,704,737,859` (`expandIdArgs()` before every dispatch); unit tests in `apps/web/src/lib/director/short-id.test.ts` |
| **Mutation-delta returns** (before/after diff, shift-compression ≥3, capped at 30) | ✅ yes | `director-api.ts:735-806` (`diffReel()` — added/removed/changed + `shifts` compression grouping by `(trackId, delta)` with a `>= 3` threshold, matching the spec's algorithm almost exactly); 30-item cap; `withDelta()` wrapper L848-854 attaches it to every mutating verb (28 call sites found via `grep -c "withDelta("`) |
| **Shift compression** (rule-based, not per-clip) | ✅ yes | same citation — `diffReel()`'s `groups` map + `>= 3` gate, `UniformShift` shape with `track`/`fromSeconds`/`bySeconds`/`count` |
| **Agent-scoped undo** (origin-tagged, refuses on human-edit-since) | ✅ yes | `director-api.ts:4301-4331` (`undo`/`redo` check `peekUndoOrigin()`/`peekRedoOrigin()` against `"agent"`); origin tagged at the verb choke point `withAgentOrigin()` L4485-4507 and applied via `wrapVerbs()` L4509-4526 to every verb except lifecycle; `withAgentBatch()` L876-886 for synchronous multi-mutation clusters (storyboard etc.); test suite `agent-undo.test.ts` explicitly covers origin tagging, refusal, atomicity, and delta-after-atomicity |
| **Unknown-key rejection** (reject with allowed-fields message) | 🔺 no — declared, not enforced | Schemas DO declare `additionalProperties: false` (`tool-catalog.ts` — 10 occurrences, e.g. L406, L490, L559); but `tool-catalog.ts:2020-2026`'s own comment on the Gemini-schema translator states plainly: *"`additionalProperties` is dropped (unsupported; handlers ignore extras)"* — confirming handlers are lenient by design and there is no runtime validator (no `ajv`/schema-validate call found anywhere in `agent.ts`, `tool-catalog.ts`, or `build-mcp-server.ts`) that actually rejects an unrecognized key with an error. A well-behaved MCP *client* may refuse to send extra fields because the schema says so, but our own server never checks. |
| **Non-finite number rejection** (with a path to the offending value) | 🔺 no — silently coerced, not rejected | `tool-catalog.ts:50` (`Number.isFinite(n) && n > 0 ? n : fallback`), `:61` (`Number.isFinite(n) ? n : undefined`), `:67` (`Number.isFinite(n) ? n : 0`) — all three arg-coercion helpers silently substitute a fallback/undefined/zero for a non-finite number rather than failing the call with a path-qualified error. A model passing `NaN` for a duration gets a silent `0`, not a refusal naming the field. |
| **Batch atomicity** (validate-all-then-commit, no partial state) | ✅ yes, where batch verbs exist | `storyboard()` wraps its per-shot loop in `editor.command.beginTransaction()`/`commitTransaction()`/`rollbackTransaction()` (`director-api.ts:1483-1509`); `reorder()` does the same (~L3973-3981); `withAgentBatch()` (L876-886) is the general-purpose helper for any synchronous mutation cluster. We have fewer true "batch" verbs than Palmier (most of ours are single-entity), so this mechanism is proven correct on the batch verbs that exist, not yet exercised on the missing ones (`add_clips`-equivalent, `set_clip_properties`-equivalent, etc. — see gaps above). |
| **Per-tool telemetry** (name, source, duration, changed-timeline flag, status) | ✅ yes — on both the MCP path and the in-app path | `apps/web/src/lib/mcp/telemetry.ts` (`recordMcpEvent`, `tool_call` events carry `status`/`durationMs`/`timelineChanged`/`mutating` in `meta`, per the module doc L14-29); fired from `build-mcp-server.ts`'s `tools/call` handler at every exit path (success, scope-blocked L206-224, rate-limited L227-260, and the bridge-refusal paths); a distinct `mcp_activated` marker fires once per session on first success (`build-mcp-server.ts:169-179` comment + closure flag `activated`); the in-app agent path has its own beacon via `apps/web/src/lib/mcp/verb-telemetry-client.ts` → `POST /api/telemetry/verb`, tested in `apps/web/src/lib/director/agent-telemetry.test.ts` and `apps/web/src/app/api/telemetry/__tests__/verb-route.test.ts` |
| **Entitlement-guard pattern** (fail early, user-facing next step) | ✅ yes — different shape, arguably richer | `director-api.ts` `evaluateSpend()` ~L2420-2460 returns a `BudgetGateDecision` (proceed / down-route to a concrete cheaper `downrouteBackendId` / pause) rather than a flat allow/deny; `getBudgetStatus()`/`setBudget()` verbs (`tool-catalog.ts:1222-1247`) expose the running spend to the agent so it can reason about entitlement *before* calling `generate`. No literal `canGenerate` boolean on `getReel`, but the budget-gate decision object carries more information than a flag would. |
| **Project binding** (mutations refused when off-project; reads allowed cross-session) | ✅ yes — **token-pinned, not frontmost-window** | `apps/web/src/lib/mcp/auth.ts:47-70` (`verifyProjectToken` resolves a token to exactly one `{userId, projectId}`); `route.ts:107-121` refuses (403) a session whose token doesn't match its pin; `build-mcp-server.ts:82-140` (`McpBridgeRefusal`) distinguishes a MUTATING verb's refusal (`"project-mismatch"`) from a READ verb's (`"bridge-unavailable"`) — reads still surface a structured refusal rather than silently succeeding against nothing, but are correctly NOT framed as a binding violation since there's no mutation risk. **This is genuinely stronger than Palmier's mechanism**: theirs binds to "whichever project is frontmost" (a UI-state signal that can drift if the user clicks around); ours binds to the bearer token issued for one project, checked server-side on every single request, independent of any UI state — a session can't be redirected to a different project by ANY client-side action, only by presenting a different token. |

**Score: 7 of 9 cross-cutting mechanisms fully implemented and evidenced; 2
(unknown-key rejection, non-finite rejection) are declared in schema shape
but not enforced at runtime — genuine, cheap gaps.**

---

## 3. Reliability posture vs. theirs

This is the marketing-truth backbone for "their MCP reliability is cracking
publicly (`palmier-delta-refresh-2026-07-14.md` §4.1, issues #302/#320);
ours demonstrably is not." Evidence, not adjectives:

- **Per-request bearer auth, no loopback trust.** Every `/api/mcp` request —
  including `initialize` and `DELETE` — requires `Authorization: Bearer
  <token>`; `apps/web/src/app/api/mcp/route.ts:66-73` returns 401 with no
  token, and `apps/web/src/lib/mcp/auth.ts` module doc states explicitly:
  *"This is a web app, so there is NO loopback trust — each call must carry a
  per-project scoped bearer token."* Contrast with Palmier's issue #302: an
  **unauthenticated localhost MCP endpoint**.
- **Token hashing, not plaintext storage.** `auth.ts:29-31` — only SHA-256
  hashes are stored; the module never logs or returns the raw token.
- **Session→project pinning enforced on every request, not just at
  handshake.** `route.ts:107-121` re-checks `session.userId`/`session.projectId`
  against the presented token's grant on EVERY request with that session id,
  403ing a mismatch rather than trusting the session was set up correctly
  once.
- **Structured, two-flavor bridge refusal** (`project-mismatch` for mutating
  verbs vs. `bridge-unavailable` for reads) — `build-mcp-server.ts:82-140` —
  so a client can programmatically distinguish "you're pointed at the wrong
  project, don't retry blindly" from "no tab is open, this is transient."
  This is the direct fix for the *class* of bug behind Palmier's #302 (silent
  track mis-targeting from a stale binding).
- **Session eviction is a documented, deterministic policy, not silent
  loss.** `mcp-session-store.ts:27-31` — 30-minute idle timeout (swept every
  60s) + a 64-session LRU cap; an evicted session id 404s (per the
  Streamable HTTP spec) rather than silently misbehaving, telling the client
  to re-initialize (`route.ts:99-105`).
- **Dual-layer rate limiting.** A blanket transport-level cap
  (`mcp:transport`: 300/min, 20,000/day per user — `route.ts:76-90`,
  `rate-limit.ts:159-163`) catches protocol-level abuse (reinit loops, SSE
  churn) BEFORE any tool-name context exists; a verb-aware second layer
  inside `tools/call` picks `mcp:read` (120/min, 6,000/day) vs. `mcp:write`
  (30/min, 1,500/day) by the catalog's own `mutating` flag
  (`build-mcp-server.ts:227-260`, `rate-limit.ts:165-173`) — mutations are
  deliberately throttled tighter than reads. Test coverage:
  `apps/web/src/lib/mcp/__tests__/mcp-rate-limit.test.ts`.
- **Per-call scope gate, independent of session-level trust.**
  `build-mcp-server.ts:200-224` re-checks `scopeForTool(name)` against
  `extra.authInfo.scopes` on every SINGLE call — a read-only token can hold
  an active session and still can't sneak a write through, because the check
  is per-call, not per-session. `MCP_SCOPES = ["reel:read", "reel:write"]`
  (`auth.ts:21`). Test coverage: `mcp-project-binding.test.ts`.
- **Origin-tagged undo prevents cross-actor history corruption.** Directly
  answers Palmier's #318/#320 undo-manager crash class (documented in
  `palmier-delta-refresh-2026-07-14.md` §9-10 as "the transferable rule:
  every agent mutation = one explicit, atomically-named undo group"). Our
  `withAgentOrigin`/`wrapVerbs` (`director-api.ts:4485-4526`) makes this
  structural, not a per-verb discipline — a new verb gets the guarantee for
  free by construction, so it can't regress the way their #320 regression
  did the same release cycle as their fix landed.
- **Telemetry captures failure modes, not just successes.**
  `build-mcp-server.ts`'s `tools/call` handler records a `tool_call` event
  on the scope-blocked path, the rate-limited path, AND every bridge-refusal
  path — not only the happy path (`telemetry.ts:10-15` module doc states this
  explicitly: *"including calls blocked by the scope gate, the per-verb rate
  limit, or a ... structured bridge refusal (so abuse/reliability patterns
  are visible, not just successes)"*). This is the observability Palmier's
  founder visibly lacked when the only answer to #302 was "let's hop on a
  call."
- **Test evidence, not just code comments claiming correctness:**
  `mcp-e2e-smoke.test.ts` (connect+read+scope over the real route handler),
  `mcp-project-binding.test.ts`, `mcp-rate-limit.test.ts`,
  `mcp-telemetry-enrichment.test.ts`, `agent-undo.test.ts` (origin/refusal/
  atomicity/delta), `short-id.test.ts`. **Not yet present:** a documented
  double connect→edit→disconnect→reconnect reliability loop test (the
  campaign brief's W1 scope) — see §0 caveat; this specific claim ("survives
  reconnect churn") is unverified in this checkout.

**One documented, honest limitation to disclose alongside any external
claim:** the relay from `/api/mcp` to a live editor tab
(`apps/web/src/lib/mcp/editor-bridge.ts`) is **in-memory and
single-instance by design today** — the module's own header names this: *"a
multi-instance deployment needs a shared pub/sub (e.g. Redis) behind this"*
(`editor-bridge.ts:34`). On a single-process deployment this is a non-issue;
on a horizontally-scaled one, an MCP call could land on a server instance
with no live connection to the user's tab even though the tab is genuinely
open elsewhere. The campaign brief names a Redis-relay fix as in-flight
(`task/mcp-w2-relay`), but per §0 that branch currently carries no code
beyond the plan doc — **do not claim this is fixed** until a real commit
lands.

---

## 4. Ranked remaining gaps worth building (max 8)

| Rank | Gap | Effort | Why this rank |
|---|---|---|---|
| 1 | **Unknown-key rejection** (cross-cutting) | S | Cheapest possible reliability win — one validation pass in the arg-coercion boundary (`agent.ts`/`build-mcp-server.ts`) catches model typos that currently silently no-op. Directly closes one of only 2 unimplemented cross-cutting mechanisms. |
| 2 | **Non-finite number rejection with a path** (cross-cutting) | S | Same boundary as #1 — replace the silent-fallback coercion in `tool-catalog.ts:50,61,67` with a rejection that names the offending field. Prevents a model's `NaN`/`Infinity` typo from silently landing as `0`. |
| 3 | **`reportLimitation` verb** (Q23) | S | Spec doc calls this "cheap and sneaky-valuable" — it's the only channel that tells us which verbs to build next from real agent usage, and we have zero of that signal today. |
| 4 | **`readPlaybook` verb** (Q24) | S | We already did the hard half (`PLAYBOOK_POINTER` in `agent.ts:299`); this is one verb that returns the full body from `lib/studio/playbooks.ts`. One afternoon per the spec doc's own estimate. |
| 5 | **Export list/cancel over a real queue** (Q5) | M | The jobId contract is already forward-compatible (`exportReel`'s doc comment says so explicitly) — this closes the gap between "returns a jobId" and "the jobId is actually useful," and it's the one Palmier shipped specifically because agent + manual exports colliding on one queue is a real failure mode. |
| 6 | **`cutRange` / ripple-delete-ranges** (Q11) | M | Collapses a 3+-step agent dance (split → remove → reorder) into one call; poster child for the mutation-delta shift-rule we already built — this verb would exercise that machinery at its intended scale. |
| 7 | **`detectBeats`** (Q17) | M | Independent of the transcription-pipeline gate that blocks most of the transcript-driven category — unlocks "cut my reel to the beat," which is on-brand and buildable with web-audio onset detection alone, no Whisper dependency. |
| 8 | **`setSlotProperties` (speed/volume/opacity/transform)** (Q12) | M | `trim` only covers timing; an agent asked to "make this clip louder" or "slow this down 2x" currently has no verb at all — this is a frequently-requested edit class with no path today. |

---

## Queue-row texts (paste-ready for `apps/web/docs/SPEEDRUN-QUEUE.md` §4/§5)

- **Q1 — project discovery for external MCP.** Our MCP token is minted
  per-project with no in-band list/open/create/close; an external client
  must already hold the right token. Add a lightweight
  `listProjects`/`resolveProject` read verb (or handle it at the
  `/api/mcp/tokens` issuance layer) once more than one external client needs
  to pick among a user's projects in-session.
- **Q2 — `getReel` windowing + default-field omission.** Add an optional
  `{ window?: { start, end } }` param and drop default-valued `SlotSnapshot`
  fields from the serialized response (mirrors Palmier's windowed-timeline-
  read design) — pure token-cost win on every large-reel read.
- **Q3 — composited multi-clip frame inspection.** Extend beyond
  `reviewTake`/`extractFrame` to a `getReel`-adjacent `inspectFrame({ time,
  endTime?, maxSamples? })` that renders the ACTUAL composite (not just one
  take) with per-frame visible-element-id lists, gated on a vision-capable
  agent model.
- **Q4 — `setReelFormat({ orientation?, resolution?, fps? })`.** No agent
  verb exists for the project canvas today; the auto-refit-on-change
  behavior (existing clips rescale) is the part worth copying, not just the
  setter.
- **Q5 — wire `export` into a real async queue + list/cancel verb.** The
  jobId is already minted per `exportReel()` (`director-api.ts:4358`); this
  closes the loop so a client can actually poll/cancel instead of just
  receiving a jobId that only ever resolves synchronously.
- **Q6 — `getAssets({ ids?, pendingOnly? })` full inventory read**,
  complementing `getLibraryManifest`'s faceted digest with an itemized list
  including per-asset generation-status polling.
- **Q7 — `inspectAsset({ assetId, window? })`** deep single-asset look:
  stage 1 (cheap) metadata + stored thumbnails; stage 2 (needs vision +
  transcription) sampled frames + transcript.
- **Q8 — `importAsset({ url, name? })`** for URL-based media ingestion into
  the library (client-side fetch → OPFS/IndexedDB); local-path/directory
  modes stay n/a (no filesystem in a web app).
- **Q9 — batch mode for `addClip`.** Accept an array of placements with
  optional auto-track-creation when all entries omit `trackId` (mirrors the
  "all-or-none" track-index rule of Palmier's batch-place tool).
- **Q10 — ripple-insert option.** Either a new `insertSlot({ atTime, ... })`
  verb or a `ripple: true` flag on `reserveSlot`/`addClip`, implemented as a
  transaction that shifts later elements before placing.
- **Q11 — `cutRange({ ranges: {start, end}[], trackId? })`** batch
  cut-and-close-gaps verb returning a `MutationDelta` with a shift rule —
  the fast path for dead-air/filler removal in one call instead of 3+.
- **Q12 — `setSlotProperties({ slotId, speed?, volume?, opacity?,
  transform? })`** delegating to the existing element-update path; `trim`
  stays timing-only.
- **Q13 — keyframe verbs.** Timeline keyframes already exist in the manual
  UI (bezier easing, keyframe clipboard per project memory); Director has no
  verb to read/write them yet. When built, adapt the design principles from
  the unmerged `palmier-skills` PR #4 keyframe-animation playbook
  (Apache-2.0, founder-gated — see `palmier-delta-refresh-2026-07-14.md`
  §4.5) as inspiration for our OWN system-prompt playbook, never its literal
  text without founder sign-off.
- **Q14 — `applyLayout({ layout, slots })`** named compound layouts
  (side-by-side, PIP corners, grid) — lower priority, behind search/text
  per the original spec doc's own ranking.
- **Q15 — `setTrack({ trackId, muted?, hidden? })`.** Deferred until a
  multi-track visual-layout use case actually needs it; the stable-id
  addressing convention this would follow is already the norm elsewhere in
  our verb surface.
- **Q16 — `removeWords({ wordIndices?, matchTokens? })`.** Highest-value
  transcript verb once `getTranscript`'s word-index output is agent-facing
  (it already exists — `tool-catalog.ts:581`); this is the "agent never
  touches frame numbers" pitch.
- **Q17 — `detectBeats({ assetId })`** returning `{ bpm, beats, downbeats }`
  via web-audio onset detection — independent of the transcription-pipeline
  gate blocking most of the transcript category.
- **Q18 — `addCaptions()`** one-shot transcribe-and-style caption-track
  generation, returning a group summary (id/count/frame-range/style/text
  preview) rather than per-clip ids — this return-shape design (not holding
  N caption ids) is the keeper detail from the spec.
- **Q19 — verify/extend `applyEffect` merge semantics.** Confirm
  merge-by-type, enable/bypass-without-remove, and canonical render order
  actually hold (only registry-driven type validation is confirmed today);
  the registry-generated-schema pattern is already right.
- **Q20 — fold multi-reference input + trimmed-range-only source scoping
  into `GenerationSpec`.** Refinement to the existing `generate`/`reroll`/
  `remix` verbs, not a new verb.
- **Q21 — unify `addVoiceover`/`addMusicBed` toward a kind-routed audio
  verb** with dubbing/voice-cleanup fields + target-language param,
  matching Palmier's v0.6.6 audio-generation delta (cleanup/dubbing
  categories folded onto one tool, not new tools).
- **Q22 — `upscaleTake({ slotId, takeId? })`** appending a higher-res take
  to the same slot (keeps the takes-as-versions story intact) — pending an
  upscale-capable provider in the adapter.
- **Q23 — `reportLimitation({ category, summary })`** agent-side
  capability-gap telemetry, paraphrase-only per privacy convention, POSTing
  to a simple endpoint or logging via the existing `recordMcpEvent`/
  telemetry seam.
- **Q24 — `readPlaybook({ id })`** returning the full body from
  `lib/studio/playbooks.ts` for a playbook whose title/description already
  rides `PLAYBOOK_POINTER` (`agent.ts:299`).

---

## Verified but out of scope for this doc

- Command-input guards (BUG13-class sweep, campaign W4 /
  `task/mcp-w4-guards`) were named in the task brief as sibling in-flight
  work but were not independently re-verified here — they touch
  `lib/commands/**`, outside this doc's owned-file scope, and the same
  branch-emptiness caveat in §0 applies equally to that branch (pinned at
  `9d3c936e`, no additional commits).

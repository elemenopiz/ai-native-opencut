# Palmier idea-poach implementation guide

Architectural and product ideas worth taking from **Palmier Pro**
(`palmier-io/palmier-pro`) and how to implement each in our codebase.

> **License boundary — read first.** `palmier-pro` is **GPL-3.0** (Swift). Our
> web app is MIT. **Do not copy any code, types, or literal strings** from
> `palmier-pro` into this repo — GPL-3.0 is copyleft and would force us to
> relicense. Everything below is an *idea/architecture* poach: reimplement from
> our own understanding, in our own code. (The permissively-licensed poaches —
> `sixsevenstudio` MIT code and `palmier-skills` Apache-2.0 prompts — are already
> landed; see `THIRD_PARTY_NOTICES.md`. This doc is only the GPL-sourced ideas.)

## Priority summary

| # | Idea | Relevance | Effort | Priority |
|---|------|-----------|--------|----------|
| 1 | Mutation-delta tool responses | High | M | **P0** |
| 2 | UUID prefix-shortening for agent I/O | High | S | **P0** |
| 3 | Strict frames-vs-seconds convention | High | S | **P0** |
| 4 | Shared tool layer (agent + future MCP) | High | M | **P1** |
| 5 | Placeholder-clip → finalize (harden ours) | High | M | **P1** |
| 6 | Server-driven model catalog + job contract | Medium | M | **P1** |
| 7 | Agent-scoped undo | Medium | M | **P1** |
| 8 | CLIP: best-per-shot dedup + relative cutoff | High | S | **P1** |
| 9 | `apply_layout` declarative compound ops | Medium | M | P2 |
| 10 | Rendered-frame-as-tool-result (self-verify) | Medium | M | P2 |
| 11 | Search index-health object | Medium | S | P2 |
| 12 | Clip generation-provenance panel | High | M | P2 |
| 13 | First/last-frame control (UI surfacing) | High | S | P2 |
| 14 | Film-simulation style presets | High | M | P2 |
| 15 | Local MCP server + `.mcpb` proxy shim | High | L | P3 |
| 16 | One-click MCP installers | Medium | S | P3 |
| 17 | Pricing: free editor, metered generation | Strategic | — | P3 |

`S`=hours, `M`=1–3 days, `L`=1–2 weeks.

---

## Agent / tool-layer

### 1. Mutation-delta tool responses (P0)

**What it is.** After a timeline-mutating tool call, Palmier returns a *diff* of
what changed rather than the full timeline: the touched/created clips (capped),
and — critically — when ≥3 clips shift uniformly it emits a single rule
`{ track, fromFrame, by, count }` instead of enumerating every moved clip. Also
returns `removedClipIds`, `createdTracks`, and a note when track indices went
stale.

**Why it matters.** Our Director agent (`lib/director/agent.ts`) feeds tool
results back as observations each ReAct step. On a reel with many shots, echoing
full state after every edit burns tokens and latency and pushes us toward the
`MAX_STEPS` ceiling faster. A diff keeps the loop cheap and the model focused on
what changed.

**How to implement.**
- In `lib/director/director-api.ts`, have each mutating verb return a
  `MutationDelta` alongside `ok/message`: `{ changed: Shot[], shifted?: ShiftRule[],
  removedIds?: string[], createdTracks?: number[], truncatedNote?: string }`.
- Add a helper `computeDelta(before, after)` that diffs the `ReelSnapshot`:
  detect "pure shifts" (same track + duration, only start moved) and compress
  runs of ≥3 uniform shifts into one `ShiftRule`.
- In `agent.ts`, serialize the delta (not the full snapshot) into the observation
  string. Keep a `clipsNote` truncation warning past ~30 changed clips.
- Pairs with #2 (short IDs) — the delta should already speak in short IDs.

### 2. UUID prefix-shortening for agent I/O (P0)

**What it is.** Every clip/track/asset ID is a full UUID internally, but tool
*output* rewrites each to its shortest unique prefix (floor 8 chars), and tool
*input* expands prefixes back, throwing on an ambiguous prefix.

**Why it matters.** Pure token savings in the agent transcript, which is dense
with IDs. Cheap, license-agnostic, and orthogonal to everything else.

**How to implement.**
- New module `lib/director/short-id.ts`: `buildShortIdMap(ids: string[])` →
  compute shortest unique prefix per id (sort, compare adjacent common-prefix
  lengths, floor at 8); `shorten(text, map)` regex-substitutes full UUIDs → short;
  `expand(shortId, ids)` resolves a prefix to the full id or throws
  `AmbiguousIdError`.
- Wrap the boundary in `director-api.ts` / `agent.ts`: shorten on the way out to
  the model, expand on the way in from the model. Internal executor code keeps
  using full IDs.
- Add a unit test for the ambiguous-prefix and single-id edge cases.

### 3. Strict frames-vs-seconds convention (P0)

**What it is.** Timeline positions are always *project frames*; source-media
ranges are always *seconds*; **tools do the conversion, the agent never
multiplies by fps.** Stated once, forcefully, in the system prompt.

**Why it matters.** Kills a whole class of off-by-fps agent math bugs for free.

**How to implement.**
- Audit `lib/director/agent.ts`'s system prompt and every verb schema in
  `director-api.ts`: make each numeric field's unit explicit in its name/type
  (`startFrame`, `durationFrames`, `sourceInSeconds`) and doc.
- Add one directive to the system prompt: *"Timeline positions are project
  frames; source ranges are seconds. Never convert between them yourself — pass
  the unit the tool asks for; the tool converts."*
- Provide the conversion inside the executor (`studio-executor.ts`) so the model
  never sees fps arithmetic.

### 4. Shared tool layer for agent + future MCP (P1)

**What it is.** One `ToolExecutor` is the single source of truth for "what an
agent can do to the timeline"; both the remote MCP server and the in-app
assistant are thin callers of the same implementations.

**Why it matters.** If/when we ship an MCP server (#15), we must not fork edit
logic. We already have most of this shape: `director-api.ts` (verbs) +
`studio-executor.ts` (execution). The poach is to *formalize* that boundary now
so a second caller is trivial later.

**How to implement.**
- Make `DirectorApi` the canonical tool registry: each verb = `{ name, schema,
  run }`. `agent.ts` already consumes it; keep the ReAct loop as *one* adapter.
- Keep all side-effecting logic in the executor, none in the agent loop.
- Export a framework-agnostic `toolCatalog()` (name + JSON schema + handler) that
  a future MCP transport can enumerate without importing any React/agent code.

### 7. Agent-scoped undo (P1)

**What it is.** The agent keeps its *own* undo stack and only undoes the most
recent action *if that action belongs to the agent* — if the human edited since,
it refuses.

**Why it matters.** Real safety once our agent edits a timeline a human is also
touching. Prevents the agent from clobbering manual work with a blind undo.

**How to implement.**
- Tag each mutation with an origin (`"agent" | "user"`) in whatever history/undo
  store the editor uses (find the timeline history store).
- Add an `undo` verb that inspects the top history entry and no-ops with a clear
  message if the origin isn't `"agent"`.

### 9. `apply_layout` declarative compound ops (P2)

**What it is.** Instead of exposing raw transform/crop and hoping the model
computes split-screen/PIP/grid math, expose a small enum of named layouts
(`full`, `side_by_side`, `pip_bottom_right`, `grid_2x2`, …) with named slots; the
tool computes cover-crop transforms server-side. The low-level path is *forbidden*
to the agent in the prompt.

**Why it matters.** "Give the agent correct-by-construction compound ops, forbid
the error-prone primitives" is Palmier's main defense against LLM arithmetic
mistakes. Applies to any multi-clip framing we let the agent do.

**How to implement.**
- Add a `applyLayout` verb to `director-api.ts` taking `{ layout, slots: clipId[] }`;
  compute transforms from canvas dims (reuse our transform model on clips).
- Add the negative instruction to the system prompt ("use applyLayout, never
  hand-build PIP via per-clip transform/scale").

### 10. Rendered-frame-as-tool-result for self-verify (P2)

**What it is.** `inspect_timeline` returns the actual composited frame(s) as an
image (frame number burned into the corner) so the agent can *see* whether a
layout/caption landed, closing the loop without a separate screenshot tool.

**Why it matters.** Our tool results are text-only. A rendered frame lets the
agent catch its own layout/caption mistakes. Our renderer already composites
frames off the timeline (`services/renderer/scene-exporter.ts`).

**How to implement.**
- Add an `inspectFrame(frame)` verb that renders one frame via the existing
  `CanvasRenderer` path to a data URL, burns in the frame number, and returns it.
- Our agent LLM is text-only today (local Ollama, no vision) — so gate this
  behind a vision-capable model, or ship it first for the *in-app* assistant if
  it uses a multimodal model. Document the dependency.

---

## Generation pipeline

### 5. Placeholder-clip → finalize, hardened (P1)

**What it is.** On generate, place a placeholder clip *immediately* at an
estimated duration (as one undo-grouped atomic action), then on completion patch
the real duration into **every** timeline that references the placeholder id —
including nested timelines — and only re-render if the touched timeline is
reachable from the active one.

**Why it matters.** We already do optimistic placeholders (generative-slot
timeline). The poach is the *robustness*: atomic undo grouping, patching all
references (not just the active timeline), and the reachability re-render guard.

**How to implement.**
- Audit our generative-slot placement + `Take` finalize path
  (`lib/studio/generate-take.ts`, `types/timeline.ts` `Take.jobId`).
- Ensure placeholder-place + finalize are single undo entries.
- On finalize, resolve *all* references to the placeholder across timelines
  before patching duration; guard the re-render on active-timeline reachability.
- This is the natural consumer of the newly-poached
  `use-generation-polling.ts` + `generation-status-store.ts` (see wiring TODOs
  in those files).

### 6. Server-driven model catalog + job contract (P1)

**What it is.** The model catalog is delivered from the server (live), typed by
kind (video/image/audio/upscale) with capability metadata, and a clean job
contract: `submit(model, params) → jobId`, `subscribe(jobId) → Job{status,
resultUrls, costCredits, error}`, `uploadReference(file) → url`. A dedicated
`CostEstimator` is separate from model config.

**Why it matters.** We're single-model (Seedance/BytePlus) today; the poached
`lib/studio/model-capabilities.ts` scaffolds the typed-catalog shape. As we add
models, a server-driven catalog lets us change availability/pricing without a
client deploy, and a uniform job contract makes the polling store (already
landed) provider-agnostic.

**How to implement.**
- Grow `lib/studio/model-capabilities.ts` into the typed catalog; optionally
  serve it from an API route so it's updatable server-side.
- Normalize `provider-adapter.ts` to the `submit/subscribe` shape (it already
  does submit→poll); expose `costCredits` on the job to feed `lib/studio/cost.ts`.

### 13. First/last-frame control — surface it (P2)

**What it is.** Generate video with explicit first *and* last frame constraints.

**Why it matters.** Our adapter *already supports it* — `GenerateVideoParams`
has `referenceImageUrl` (first) and `lastFrameUrl` (flf2v). It's just not fully
surfaced as a first-class UI affordance for shot-to-shot continuity.

**How to implement.**
- In `components/studio/generation-form.tsx` (and `frame-slot.tsx`), expose a
  clear "end frame" slot next to the start frame; wire to `lastFrameUrl`.
- Bonus: auto-suggest the *next* shot's first frame = this shot's last frame for
  continuity.

### 14. Film-simulation style presets (P2)

**What it is.** One-click "look" presets modeled on real film stocks (Kodak 2383,
Fuji 3513) = reference images + color palette + anti-averaging prompt rules, to
fight the flat "Nano Banana default aesthetic."

**Why it matters.** Solves a documented, real diffusion-averaging pain point, and
ties a *look* to generation (not just post color grade). We already have
`lib/studio/image-presets.ts` and `camera-presets.ts` — same pattern, new axis.

**How to implement.**
- Add `lib/studio/style-presets.ts`: each preset = `{ id, label, referenceImages?,
  palette, promptSuffix, negativeSuffix }`.
- Fold `promptSuffix`/`negativeSuffix` into the prompt builder; combine with the
  poached UGC playbooks' standing negative list.

### 12. Clip generation-provenance panel (P2)

**What it is.** Click any generated clip to see/edit the exact model, prompt,
references, seed, first/last frame that produced it — and regenerate in place.

**Why it matters.** Turns every clip into a reusable, inspectable recipe instead
of a black box; makes seed-lock and remix (poached `lib/studio/remix.ts`)
legible to the user. Also directly counters Palmier's *own* weakness (they lose
this metadata on NLE-XML export — we can keep it).

**How to implement.**
- Confirm the `Take`/generative-clip model persists full provenance (model,
  prompt, seed, refs, first/last frame) queryably.
- Extend `components/editor/panels/properties/generative-clip-properties.tsx` to
  render + edit it, with a "regenerate" that runs the existing pipeline and a
  "remix" that calls `buildRemixSpec` (already poached).
- Preserve this metadata on export (sidecar JSON) — a demonstrable edge over
  Palmier.

---

## Search

### 8. CLIP best-per-shot dedup + relative cutoff (P1)

**What it is.** Their visual search dedupes to the best-scoring frame *per shot*
(so one scene can't flood results) and applies a **relative cutoff**
(`top_score × 0.85`) *in addition to* an absolute `minScore` floor.

**Why it matters.** We already shipped CLIP visual search — this is a small,
high-value quality delta. Without best-per-shot, a single strong clip dominates;
without the relative cutoff, weak-but-above-floor junk leaks in.

**How to implement.**
- In our search ranker (`lib/search/…`), after scoring: group hits by shot/clip,
  keep the max-scoring frame per group, then filter to
  `score ≥ max(minScore, topScore × 0.85)`.
- Add these as tunable constants; unit-test the dedup + cutoff.

### 11. Search index-health object (P2)

**What it is.** Search returns an `index` health object
(`indexing | modelNotInstalled | downloadingModel | preparing | disabled |
failed`) *only when it explains missing hits*, and omits it otherwise so an empty
object isn't misread as "nothing found."

**Why it matters.** Both the UI and (if search becomes an agent tool) the agent
must not conclude "the footage doesn't exist" when the index is merely still
building. Ours is on-device CLIP — same failure mode.

**How to implement.**
- Have the search API return an optional `indexStatus` only when results are
  degraded by index state; surface it in the search UI as a distinct empty-state
  ("still indexing N clips") vs. true "no matches".
- If we expose search as a Director verb, include the same field so the agent
  reports "indexing" instead of "not found".

---

## MCP server (P3 — strategic)

### 15. Local MCP server + `.mcpb` proxy shim

**What it is.** A loopback-only (`127.0.0.1`) local HTTP MCP server over our
project/timeline model, exposing the shared tool layer (#4). Distributed as an
`.mcpb` bundle whose "server" is just an `mcp-remote` **stdio→HTTP proxy shim**,
so Claude Desktop/Cursor/Codex (stdio-only) can drive it without us writing a
stdio server. Stateful sessions keyed by `Mcp-Session-Id`, idle+LRU eviction,
loopback-origin validation, no auth (trust = loopback).

**Why it matters.** This is Palmier's headline hook and a dev-community
virality engine (10k+ stars). For us it's differentiation *and* free marketing to
exactly the Claude/Cursor audience. We're a **web app**, so our version differs:
either a desktop companion, or an authenticated remote MCP endpoint over a user's
cloud project (no loopback trust — needs real auth).

**How to implement (when prioritized).**
- Build on the shared `toolCatalog()` from #4 — MCP transport enumerates it; zero
  edit-logic duplication.
- Reuse the official MCP TypeScript SDK; add an HTTP/SSE transport.
- Web-specific: since there's no loopback trust boundary, gate with a scoped
  per-project token (OAuth or PAT), unlike Palmier's no-auth local model.
- Adopt the mutation-delta (#1) + short-id (#2) + frames/seconds (#3) tool shaping
  from day one so the MCP surface is token-efficient.

### 16. One-click MCP installers

**What it is.** Help-menu buttons that install the MCP config for each supported
client in one click, killing the setup tax that normally sinks MCP adoption.

**How to implement.** Generate the client-specific config JSON and a copy/deep-link
per client (Claude Desktop, Cursor, Codex) once #15 exists.

---

## Product / pricing (P3 — strategic, not code)

### 17. Free editor, metered generation

Palmier makes the editor + export **permanently free, no-login**, and monetizes
only generation credits — cleanly separating the always-free tool from the
metered AI COGS, which maximizes top-of-funnel adoption. **Caveat:** their credit
economics were criticized ($29–49/mo for only 3–7 min of video). Adopt the
*structure*, price the credits more generously/transparently. This is a
go-to-market decision, tracked here only so the engineering (metering, credit
accounting in `lib/studio/cost.ts`) aligns with it.

---

## Sequencing recommendation

1. **Token-efficiency batch (P0):** #2 short-id, #3 frames/seconds, #1
   mutation-delta — small, compounding wins on the agent loop; do together.
2. **Wire the landed MIT code (P1):** finish #5 using the poached polling store;
   #8 CLIP quality delta.
3. **Formalize the tool layer (#4)** so #15 (MCP) is cheap later.
4. **Product surfacing (P2):** #13 first/last-frame, #12 provenance panel, #14
   style presets — user-visible differentiators.
5. **MCP + installers (#15/#16)** as the flagship growth bet once the tool layer
   is clean.

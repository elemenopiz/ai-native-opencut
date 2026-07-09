# Similar-repos survey — idea-poach implementation guide

A broader sweep beyond Palmier: other open-source / source-available projects
building AI-native or agent-drivable video tools, evaluated for genuine
architectural overlap with our Director API + generative-clip timeline +
provider-adapter stack. Palmier itself is already extensively mined
(`palmier-idea-poaches.md`, `palmier-mcp-schema-spec.md`,
`sixsevenstudio-integration-pass.md`) and is out of scope here.

> **License boundary — read first, per source.**
> - **`calesthio/OpenMontage` is AGPL-3.0.** Stronger than Palmier's GPL-3.0:
>   AGPL's network clause means even running a modified version as a web
>   service (which is exactly what we are) triggers source-disclosure
>   obligations. **Do not copy any code, prompts, schemas, or literal strings**
>   from OpenMontage into this repo. Everything under its deep-dive below is an
>   *idea/architecture* poach — reimplemented from our own understanding, in
>   our own code, using different variable names, weights, and thresholds.
> - **`FireRedTeam/FireRed-OpenStoryline` is Apache-2.0** — permissive. Short
>   verbatim excerpts (a schema shape, a short prompt fragment) could
>   technically be reused with attribution in `THIRD_PARTY_NOTICES.md`, the
>   same way `sixsevenstudio` (MIT) and `palmier-skills` (Apache-2.0) already
>   are. Nothing here proposes verbatim reuse yet — see per-idea notes — but the
>   door is open if a later pass wants literal text.
> - Everything else in the candidate table is **survey-only**: no code was
>   read deeply enough to poach from, and most are noted `skip` on relevance or
>   license below.

---

## Candidate list

| Repo | Stars | License | Stack | Verdict |
|---|---|---|---|---|
| [`calesthio/OpenMontage`](https://github.com/calesthio/OpenMontage) | 35.9k | **AGPL-3.0** | Python | **Deep-dived.** Most architecturally complete match: manifest-driven pipelines, scored provider selection, human-approval gates, self-QA scorers. Ideas-only (network copyleft). |
| [`FireRedTeam/FireRed-OpenStoryline`](https://github.com/FireRedTeam/FireRed-OpenStoryline) | 3.1k | **Apache-2.0** | Python | **Deep-dived.** Closest conceptual match to our Director + UGC playbooks: natural-language "directing" agent with reusable "Style Skills." Permissive — code/prompt reuse is legally open. |
| [`HKUDS/ViMax`](https://github.com/HKUDS/ViMax) | 11.0k | MIT | Python | Surveyed only. "Director/Screenwriter/Producer/Video Generator" multi-agent roles, but it's **pure Idea2Video/Script2Video generation** (concept → finished video), not timeline editing — no persistent, human-editable timeline model. Character/scene consistency is its core selling point (relevant to our seed-lock) but the architecture is a generation pipeline, not an editor. Academic project (HKU lab, arXiv paper attached), MIT is permissive if we revisit for consistency techniques specifically. |
| [`KyaniteLabs/mcp-video`](https://github.com/KyaniteLabs/mcp-video) | 70 | Apache-2.0 | Python | Surveyed only. A real MCP server (119 tools) over FFmpeg-class operations — trim, subtitle, resize, transcribe — with a notable `release_checkpoint()` pre-publish quality gate (thumbnail + validation) on every tool chain. No timeline/state model beyond file-in-file-out; it's a stateless operations library, not an editor. Good reference for "guardrailed tool" naming conventions if we build the MCP server from palmier-idea-poaches.md #15. |
| [`poseljacob/agentic-video-editor`](https://github.com/poseljacob/agentic-video-editor) | 458 | MIT | Python | Surveyed only. CLI tool, four-agent pipeline (Director selects shots → Trim Refiner → Editor renders via FFmpeg → Reviewer scores output on 5 dimensions and sends feedback back to Director for another pass). The Director/Reviewer feedback loop is a smaller, single-purpose version of what OpenMontage's checkpoint gates + slideshow-risk scorer do more generally — not deep-dived separately since OpenMontage covers the same idea with more rigor. Web UI is explicitly unsupported/WIP. |
| [`mutonby/openshorts`](https://github.com/mutonby/openshorts) | 2.6k | MIT | Python (FastAPI) + React | Surveyed only. Self-hosted UGC/shorts platform with a genuinely relevant **shared avatar gallery** (reusable AI personas across projects, closer to our persona store than a one-shot reference upload) and multi-provider routing by quality tier (fal.ai, Hailuo, Kling Avatar, Flux). No agent/tool-calling layer — it's a fixed sequential pipeline (Gemini script → fal.ai visuals → ElevenLabs audio), not agent-drivable. Worth a glance for the avatar-gallery UX pattern, not deep-dived. |
| [`Anil-matcha/Open-AI-UGC`](https://github.com/Anil-matcha/Open-AI-UGC) | 171 | **None (all rights reserved)** | Next.js/Prisma | **Skip — no license, do not touch code.** Pure form-based generator (script + reference face/product in, one video out) via the Muapi.ai gateway (Veo 3.1, Seedance 2, Grok Video). No editor, no multi-clip composition, no agent. Low architectural overlap even setting the license aside. |
| [`burningion/video-editing-mcp`](https://github.com/burningion/video-editing-mcp) | 279 | **None** | Python | Skip — no license. MCP interface for a separate closed product ("Video Jungle"); the MCP server itself is a thin client, most of the interesting logic is server-side and not in this repo. |
| [`ncounterspecialist/twick`](https://github.com/ncounterspecialist/twick) | 509 | NOASSERTION (unclear) | TypeScript | **Low-value, flagged correctly by the task brief.** This is a Fabric.js-based timeline editor SDK; "AI" = Gemini-powered caption/transcription generation bolted onto an otherwise conventional editor. No generation, no agent, no provider abstraction beyond captions. Confirmed via README — not an AI-native match. License is also unclear (`NOASSERTION`), so skip even for the caption-UX pattern. |
| [`chandler767/mcp-video-editor`](https://github.com/chandler767/mcp-video-editor) | 3 | None | Go | Skip — 3 stars, no license, essentially unmaintained (last push same week as creation). Noted only because it surfaced in search. |
| [`remotion-dev/remotion`](https://github.com/remotion-dev/remotion) | — (well-known) | **Source-available, not permissive above a threshold** — free for individuals and companies ≤3 people; a paid company license (`$100/mo` minimum) is required above that, covering exactly our use case ("prompt-to-video apps," "embedding the Remotion Player," "automated video creation"). Confirmed via `remotion.dev/docs/license` and `remotion.pro/license`. | React/TS | Not a candidate to poach *from* (it's a rendering engine, not an editor architecture) but flagged because **OpenMontage itself ships a Remotion-based composer** (`remotion-composer/`) as one of two render runtimes (the other, HyperFrames, is their own HTML/CSS/GSAP engine — built in-house specifically to dodge the Remotion company-license threshold at scale). If we ever consider Remotion as a render backend, budget for the company license once we're not a ≤3-person team — OpenMontage's decision to build HyperFrames alongside it is itself a signal worth noting. |

Palmier (`palmier-io/palmier-pro`, GPL-3.0) is excluded per task scope — already
covered exhaustively in the existing poach docs.

---

## Priority summary (deep-dive ideas)

| # | Idea | Source | License boundary | Relevance | Effort | Priority |
|---|------|--------|-------------------|-----------|--------|----------|
| 1 | Weighted multi-dimension provider scoring | OpenMontage | AGPL — idea only | High | M | **P1** |
| 2 | Fail-closed human-approval gate with protocol-explaining error | OpenMontage | AGPL — idea only | High | S | **P1** |
| 3 | Delivery-promise lock (no silent quality downgrade) | OpenMontage | AGPL — idea only | High | S | **P1** |
| 4 | Auto-synthesized Style Skills from observed editing behavior | FireRed-OpenStoryline | Apache-2.0 — reuse OK | High | M | **P1** |
| 5 | Generic-output / "slideshow risk" self-QA scorer | OpenMontage | AGPL — idea only | Medium | M | P2 |
| 6 | Checkpoint history archival (copy-not-move, atomic swap) | OpenMontage | AGPL — idea only | Medium | S | P2 |
| 7 | Three-layer skill architecture (tools / conventions / external knowledge) | OpenMontage | AGPL — idea only | Medium | M | P2 |
| 8 | Richer character-design schema | OpenMontage | AGPL — idea only | Medium | S | P2 |
| 9 | Shared avatar gallery (cross-project persona reuse) | openshorts | MIT — reuse OK, not deep-dived | Medium | S | P2 |

`S`=hours, `M`=1–3 days, `L`=1–2 weeks.

---

## Deep dive: OpenMontage (`calesthio/OpenMontage`, AGPL-3.0)

Cloned shallow to
`/private/tmp/claude-501/.../scratchpad/openmontage` for this pass (not
committed anywhere). Structure: `pipeline_defs/*.yaml` (11 declarative
pipeline manifests) + `skills/` (Markdown "how to execute" instructions per
stage) + `tools/` (52 Python tool wrappers across 7 categories, 14 video-gen
providers) + `lib/` (scoring, checkpointing, QA heuristics) + `schemas/`
(JSON Schema for every artifact). The agent (Claude Code / Cursor / Codex —
there's no separate orchestration server) reads the manifest, reads the stage
skill, and calls the Python tools directly.

### 1. Weighted multi-dimension provider scoring (P1)

**What it is.** `lib/scoring.py`'s `score_provider()` replaces "first available
provider" with a 7-dimension weighted score — `task_fit (30%) + output_quality
(20%) + control (15%) + reliability (15%) + cost_efficiency (10%) + latency
(5%) + continuity (5%)`. `task_fit` uses tokenized keyword overlap *with
synonym-cluster expansion* (`"cinematic"` matches `"film"`, `"trailer"`,
`"epic"`) rather than literal string matching, plus specific bonuses/penalties:
a "motion required but tool is image-only" hard penalty (`×0.2`), a
"reference-conditioning wanted and supported" bonus, and a "continuity" score
that rewards staying on a provider already used elsewhere in the same job
(style consistency). Every score is `.explain()`-able — top-3 contributing
dimensions printed for the user/agent.

**Why it matters.** We're explicitly single-provider today
(`provider-adapter.ts`'s own comment: "one function, one backend"). Palmier's
idea-poach doc (#6) already flags growing `model-capabilities.ts` into a typed
catalog — this is the concrete *selection algorithm* that catalog needs once
there's more than one model to choose between, and it's more rigorous than
just "pick the newest model": explainable, tunable, and it explicitly protects
against a real failure mode we care about (falling back from video-motion to a
static image without telling the user — see idea #3 below, which is the
generalization of `_compute_task_fit`'s motion-required penalty).

**How to implement.**
- New module `lib/studio/provider-scoring.ts`. Port the *shape*, not the code:
  `ProviderScore` type with the 7 named dimensions + `weightedScore` getter;
  a `scoreProvider(catalogEntry, taskContext)` pure function; a
  `rankProviders()` sort.
- Reuse our own vocabulary for task-fit matching — don't copy OpenMontage's
  synonym clusters verbatim (AGPL); write a small one for our domain (UGC/ad
  terms: "authentic," "candid," "product-in-hand," etc. — pulled from our own
  `lib/studio/playbooks/ugc-photo-prompts.md`, which we already own under
  Apache-2.0 from Palmier).
- Wire into `lib/studio/model-capabilities.ts` once it's multi-entry; surface
  `explain()` output in the generation-form UI as a "why this model" tooltip.

### 2. Fail-closed human-approval gate with protocol-explaining error (P1)

**What it is.** `lib/checkpoint.py`'s `write_checkpoint()` refuses to persist a
stage as `"completed"` if the pipeline manifest says that stage requires human
approval and no `human_approved=True` was recorded — it raises
`CheckpointValidationError` with a message that doesn't just say "denied," it
tells the *agent* the exact corrective protocol: *"write status='awaiting_human',
present the artifact summary to the user, END YOUR TURN, and only after the
user approves re-write with status='completed', human_approved=True."* The
gate policy itself lives declaratively in the pipeline manifest
(`human_approval_default: true` per stage), and an unknown `pipeline_type` is a
hard error rather than silently skipping gate enforcement (fail-closed, not
fail-open).

**Why it matters.** Palmier's idea-poach #7 (agent-scoped undo) is about
*undo* safety; this is about *commit* safety — preventing an LLM agent from
talking itself into "this is done" on something that should have paused for
the human. Our Director agent (`lib/director/agent.ts`) currently has no
concept of a gated verb — every tool call just executes. As we add
higher-stakes verbs (e.g. finalizing a whole reel for export, bulk-regenerating
locked-seed shots), a gate that fails *loudly and instructively* rather than
silently is cheap insurance, and the "tell the agent the exact protocol in the
error string" trick is what actually gets ReAct-style loops (ours included) to
self-correct instead of retrying blindly.

**How to implement.**
- Add an optional `requiresApproval?: boolean` to verb definitions in
  `lib/director/director-api.ts`.
- In `agent.ts`'s tool-execution step, if a verb is gate-flagged and the agent
  hasn't already surfaced a confirmation this turn, return a structured
  "awaiting_human" `DirectorResult` (not an exception — our `{ ok, message }`
  convention, per the file's own documented design rule) whose `message` spells
  out the same kind of explicit next-step instruction OpenMontage uses.
- Keep the origin-tagging idea from palmier-idea-poaches.md #7 as the
  companion piece: `core/managers/commands.ts`'s `history: Command[]` has no
  origin field today (confirmed by reading the file) — gate-enforcement and
  agent-scoped undo should land together since both need to distinguish
  "the agent proposed this" from "the human already confirmed it."

### 3. Delivery-promise lock — no silent quality downgrade (P1)

**What it is.** `lib/delivery_promise.py` defines a small enum
(`MOTION_LED`, `SOURCE_LED`, `DATA_EXPLAINER`, …) that's chosen once at the
proposal stage and locked. Each promise type has hard rules — e.g.
`motion_led` sets `still_fallback_allowed: False` and
`min_motion_ratio: 0.7`. If the compose stage can't honor the locked promise
(e.g. the video provider is down and the only fallback is a still image), the
system is required to **stop and ask**, not silently substitute a lower-fidelity
result and ship it.

**Why it matters.** This is a real, previously-shipped failure mode for AI
video tools: "user asked for a video, got a slideshow of stills, wasn't told."
Our generation pipeline (`lib/studio/provider-adapter.ts`,
`generate-take.ts`) has retry/fallback surface area growing as we add
providers — this pattern gives us a cheap, structural guard rail: decide once
per shot/reel what's being promised (e.g. "this is a seed-locked persona
video, not a static ad image") and refuse to quietly hand back something that
doesn't meet it.

**How to implement.**
- Add a `deliveryPromise` field to `GenerationSpec` (`types/timeline.ts`) —
  values scoped to our domain, not OpenMontage's 8 (we probably only need
  `video_required` vs `image_acceptable_fallback` initially).
- In `generate-take.ts`'s completion path, before finalizing a `Take`, check
  the spec's promise against what was actually produced; if violated, surface
  an explicit failure state (reuse the existing job-failure UI) instead of
  quietly accepting a lower-tier result.
- Pairs naturally with seed-lock/personas: a persona-locked shot is *always*
  `video_required` — a still substitute silently breaking character
  consistency is exactly the failure this pattern exists to prevent.

### 5. Generic-output / "slideshow risk" self-QA scorer (P2)

**What it is.** `lib/slideshow_risk.py` and `lib/variation_checker.py` score a
shot/scene plan *before* generation spends money, across concrete, cheaply
computable dimensions: shot-size repetition ratio, `unique_desc_ratio` (are
descriptions actually different or just reworded), consecutive-same-size-shot
runs, presence of `shot_intent`/`narrative_role` per scene (decorative vs.
purposeful), and a literal `GENERIC_PHRASES` denylist (`"cutting-edge,"
"seamless," "next-generation," "a beautiful"` — the exact tells of a
lazy/generic LLM-written scene description). Output is a 0–5 score per
dimension with a human-readable reason string and an overall
`strong/acceptable/revise/fail` verdict; `fail` blocks the compose stage
outright.

**Why it matters.** We generate prompts for UGC-style shots
(`lib/studio/playbooks/ugc-photo-prompts.md` already has its own "standing
negative prompt" list for *image-model* tells). This is the same idea applied
one layer up: catching a *reel-level* planning problem (all shots the same
size, no stated intent, generic filler language) before burning generation
credits on it, not just fighting per-image AI-photo tells.

**How to implement.**
- New `lib/studio/reel-variation-check.ts`: given the array of
  `GenerationSpec`s about to be submitted for a reel, compute a small set of
  structural checks (shot-type repetition, prompt near-duplication via a
  cheap string-similarity heuristic, our own generic-phrase denylist pulled
  from what we've actually seen degrade quality).
  Surface as a non-blocking warning in the generation form initially ("3 of 5
  shots use nearly identical prompts") — don't hard-block like OpenMontage
  does, since we don't have their multi-stage human-checkpoint UX yet.

### 6. Checkpoint history archival — copy-not-move, atomic swap (P2)

**What it is.** `_archive_superseded_checkpoint()` in `lib/checkpoint.py`
copies (not moves) the current checkpoint file into a `history/` subdirectory
before overwriting it — copy rather than move specifically because a file
watcher (their "Backlot" project board) may hold the file open and deny a
rename on Windows. Writes themselves go through a temp-file + `os.replace()`
atomic swap so a mid-write crash never leaves a truncated current file. A
repeated `in_progress` heartbeat write is *not* archived (only real
stage-completions / gate transitions are), to avoid flooding history with
noise.

**Why it matters.** Directly reinforces palmier-idea-poaches.md #12 (clip
generation-provenance panel) and #5 (placeholder→finalize hardening) — we
already want per-`Take` provenance to survive; this is the concrete
file-durability pattern (why copy not move, why atomic temp-swap, why skip
heartbeat writes) for whatever storage layer ends up backing take history.

**How to implement.** If/when Take history moves to a file-backed or
IndexedDB-backed store (vs. in-memory), apply the same three rules: atomic
write-then-swap, copy-don't-move for the superseded version, and skip
archiving transient/in-progress states.

### 7. Three-layer skill architecture (P2)

**What it is.** OpenMontage's docs are explicit about a 3-layer separation:
**Layer 1** `tools/` + `pipeline_defs/` = "what exists" (executable
capabilities); **Layer 2** `skills/` = "how to use it" (their own conventions,
quality bars — e.g. `skills/core/`, `skills/creative/prompting/`); **Layer 3**
`.agents/skills/` = "how it works" (external technology knowledge packs, one
per dependency). Each tool declares which Layer-3 skills it depends on,
decoupling executable code from the human-readable production knowledge that
justifies *how* to call it well.

**Why it matters.** Our `lib/studio/playbooks/` is currently Layer 2 only
(prompt-craft conventions, Apache-2.0 from Palmier). As we accumulate more
playbooks (camera presets, style presets per palmier-idea-poaches.md #14,
persona conventions), an explicit Layer 1/2/3 split keeps "what tool exists"
separate from "our house style for using it" separate from "external model
quirks" (e.g. a Seedance-2.0-specific prompting quirk sheet) — currently
these would all just pile into `lib/studio/`.

**How to implement.** Lightweight: no code change required, just a directory
convention — `lib/studio/tools/` (capability wrappers, already mostly exists
as `provider-adapter.ts` etc.), `lib/studio/playbooks/` (already Layer 2),
new `lib/studio/model-notes/` (Layer 3, e.g. "Seedance 2.0 omni-reference
quirks") if/when that knowledge grows past a code comment.

### 8. Richer character-design schema (P2)

**What it is.** `schemas/artifacts/character_design.schema.json` models a
character with `required_emotions`, `required_actions`, `required_views`
(front/profile/three-quarter), `silhouette_notes`, `props`, and `constraints`
— a structured brief for what a character-consistency system needs to
*guarantee* coverage of, not just a single reference image + text descriptor.

**Why it matters.** Our persona model (`lib/studio/personas.ts`,
`persona-still.ts`) currently anchors identity via one descriptor string +
reference image(s) (`composePersonaScenePrompt`). This schema is a checklist
for what's *missing* when a persona needs to appear across many
emotions/actions/angles in a multi-shot reel — exactly our seed-lock use case.

**How to implement.** Extend the `Persona` type (wherever it's defined,
adjacent to `usePersonaStore`) with optional `requiredViews`/
`requiredEmotions` arrays; use them to pre-flight-check a reel's shot list
("this persona has no `three_quarter` reference and shot 4 asks for one") the
way `lib/director/consistency-prompt.ts`'s `buildConsistencyContext` already
assembles context — this is additional structure feeding that same context
builder, not a new subsystem.

---

## Deep dive: FireRed-OpenStoryline (`FireRedTeam/FireRed-OpenStoryline`, Apache-2.0)

Cloned shallow to `/private/tmp/claude-501/.../scratchpad/fireredopenstoryline`
(2 MB — much smaller project). Structure: `src/open_storyline/nodes/` (discrete
processing nodes: `asr_node`, `filter_clips`, `generate_ai_transition`,
`generate_script`, `generate_voiceover`, `group_clips`, `load_media`,
`plan_timeline`), `src/open_storyline/mcp/` (MCP server + a
`node_interceptors.py`/`chat_middleware.py` guardrail layer), and
`.storyline/skills/` — a *user-facing, growable* skill library (not baked into
the repo like OpenMontage's `skills/`, but written to at runtime).

### 4. Auto-synthesized Style Skills from observed editing behavior (P1)

**What it is.** `.storyline/skills/create_profile_style_skill/SKILL.md` is a
meta-skill: the agent's job, when invoked, is to **observe or ask about the
user's editing preferences** (cut pacing — jump-cut vs. long-take; narrative
structure; SFX density; caption style; color grade), summarize 3–5 concrete
style points back to the user for confirmation, propose a machine-readable
filename, then **write a brand-new Skill file** (with the same YAML
frontmatter + Markdown-instruction shape as every other skill) into
`.storyline/skills/{name}/SKILL.md` — versioned, re-editable, and immediately
loadable by the agent for future videos. In other words: playbooks aren't just
hand-authored upstream content (like our current Palmier-sourced UGC
playbooks) — the *agent itself* can mine a user's demonstrated preferences
into a new reusable playbook, on request.

**Why it matters.** This is the single most novel idea in either deep-dive —
nothing in the Palmier docs or OpenMontage covers it. Our
`lib/studio/playbooks/` today is static and upstream-sourced (Apache-2.0 from
`palmier-skills`); there's no path for a *user's own* recurring style (e.g. "I
always want fast jump-cuts synced to the beat, no dialogue, heavy zoom-punch-ins")
to become a first-class, reusable, named playbook without us hand-writing it.
Given Apache-2.0, we can even structurally mirror their SKILL.md template
(frontmatter shape: `name`/`description`/`version`/`author`/`tags`) with
attribution, not just the idea.

**How to implement.**
- Add a `lib/studio/playbooks/user-playbooks.ts` runtime store (distinct from
  the static `index.ts` mirror of upstream playbooks) — persisted the same way
  personas are (`persona-store.ts` pattern), keyed by name, editable, with a
  `sourceReelId` provenance pointer back to whatever reel it was distilled
  from.
- Add a Director verb `synthesizePlaybook({ reelId })`: walk the reel's
  generated `Take`s + their prompts/specs, ask the LLM to summarize into the
  same slot structure our upstream UGC playbooks use (format declaration,
  framing, lighting, negative-space rules — see
  `lib/studio/playbooks/ugc-photo-prompts.md`'s 9-slot formula), present for
  user confirmation (same "show a preview, get explicit approval" pattern as
  idea #2 above), then persist.
- Surface saved user playbooks in `generation-form.tsx` alongside the static
  upstream ones, with a visibly different badge ("your style" vs. "Palmier
  UGC") so provenance stays legible — a small instance of the same
  transparency principle behind palmier-idea-poaches.md #12 (provenance
  panel).

---

## Sequencing recommendation

1. **Safety/quality rails first (P1, small-to-medium):** #2 fail-closed
   approval gate + #3 delivery-promise lock — both are structural guards that
   get cheaper to add the earlier they land, before more generation surface
   area (multi-provider, bulk regen) exists to need guarding.
2. **Provider scoring (#1)** once `model-capabilities.ts` actually grows past
   one entry — no point scoring a field of one.
3. **User-synthesized playbooks (#4)** as the standout differentiator — pairs
   naturally with the provenance panel (palmier #12) and the existing static
   playbook system; highest novelty-to-effort ratio of everything surveyed.
4. **P2 batch** (slideshow-risk scorer #5, checkpoint durability #6, skill
   layering #7, character schema #8) as incremental hardening once the P1s are
   in — none are blocking, all are cheap wins picked up opportunistically.

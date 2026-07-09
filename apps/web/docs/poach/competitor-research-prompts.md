# Competitor deep-research prompts (2026-07-09)

Six copy-paste prompts, one per competitor. Each is written to be handed to a **lead
research agent** that immediately fans out into **many parallel Sonnet sub-agents**, then
synthesizes one poach doc in our house format.

## How to use
1. Paste **§0 SHARED CONTEXT** at the top of the agent's prompt.
2. Paste the competitor-specific prompt (§1–§6) after it.
3. The agent writes its output to `apps/web/docs/poach/<competitor>-poaches.md`.

The competitors are ordered by threat, per the brief:
Runway (existential) → Palmier (structural twin) → CapCut (volume) → Adobe (pincer) →
Descript (agentic) → Higgsfield (character-consistency benchmark).

---

## §0 SHARED CONTEXT — prepend to every prompt

> **Who we are.** We are **Byorn**, a cross-platform **web** AI-native video editor (an MIT
> OpenCut fork). Our one-line pitch: *a real multi-track NLE + a generation-first
> "slots/takes" timeline + wired personas/seed-lock + an in-app "Director" agent + local
> CLIP visual search + local Whisper captions + WebGL transitions/effects.* Stack: Next.js /
> React / TypeScript / Zustand / Drizzle+Postgres front; a Python backend (`localhost:8420`)
> for Whisper, diarization, and gen orchestration. We are **MIT-licensed** — license of any
> source you cite matters (permissive = copyable code; copyleft/closed = idea poach only).
>
> **Our current position & bets** (do not re-derive — build on these):
> - Spine = a **generative-clip timeline**: placeholder-slot → generate → finalize, with
>   "takes" as clip versions. One unified generator, seed-lock for consistency.
> - Build #1 priority = **character/identity consistency** ("personas"). This is where we
>   most need to catch the field.
> - Known wedges we already hold: cross-platform web (no install/login), 22 hand-authored
>   WebGL transitions, generation-provenance that survives export, local-first search/caption.
> - Known soft spots: agent brain sometimes defaults to a weak local model; color grading is
>   a flat shader; MCP surface not yet shipped; identity-consistency not yet best-in-class.
>
> **What "poach" means here.** Not "list their features." For each finding produce a concrete
> *transfer*: what they do, the mechanism (be specific — endpoints, params, model names,
> UX flow, data contract), whether we take it **as CODE** (only if the source is permissively
> licensed and we can point to the repo/file) or **as IDEA** (reimplement in our own code),
> and how it maps onto *our* stack and timeline primitives above.

### Shared research method (the lead agent MUST follow)
- **Fan out into many parallel Sonnet sub-agents** — do not research serially. Assign each
  sub-agent one dimension (see the per-competitor "research axes"), run them concurrently,
  then synthesize. Aim for 5–9 sub-agents per competitor.
- Use **live web research** (WebSearch/WebFetch): official product pages, pricing, changelogs,
  docs/API refs, model cards, launch blog posts, YouTube demos/reviews (read transcripts),
  Reddit/HN/X threads for real user complaints, and — critically — **any public code repos,
  SDKs, or API schemas**. Prefer primary sources; date every claim; flag anything unverified.
- Distinguish **shipped vs. announced vs. vaporware.** Competitors ship weekly; note version
  and date on every capability. Treat feature checklists as perishable.
- Actively hunt their **weaknesses and structural constraints** (platform lock, pricing/credit
  economics, latency, quality ceilings, no-collaboration, metadata loss on export). Their
  constraint is our wedge — name it explicitly.

### Shared output contract (write to `apps/web/docs/poach/<competitor>-poaches.md`)
1. **Header** — competitor, one-line product, license/stack/platform, pricing, last-verified date.
2. **Threat read** — restate why this competitor matters to *us* specifically (from the brief),
   confirmed/revised against evidence.
3. **Priority table** — columns: `# | Poach | code|idea | Relevance | Effort (S/M/L) | Tier/Prio`.
   `S`=hours, `M`=1–3 days, `L`=1–2 weeks. Tiers: T1 = close or we can't win; T2 = credibility
   gap; T3 = nice-to-have.
4. **Per-poach detail** — for each row: what it is, exact mechanism, code-vs-idea + license/source,
   and **how to implement on our stack** (name our files/primitives where known).
5. **Their weakness = our wedge** — the counter-positioning, as headline claims we could make.
6. **What we already beat them on / deliberately ignore** — so we don't waste cycles.
7. **Freshness note** — sources + dates; what to re-check and when.

---

## §1 Runway (Aleph 2.0) — EXISTENTIAL

**Threat read to validate:** Runway now explicitly pitches "a professional NLE combining
timeline / cuts / transitions / color with native AI generation" — *our exact wedge*, from the
incumbent with arguably the best in-house model (Gen-4 / Aleph). Web-based, $12–76/mo. The one
competitor who could take our position outright. The strategic question isn't "are they good at
gen" (they are) — it's **how mature is their timeline/NLE, and can we out-edit them before it
hardens?**

**Prime directive:** find the seams between their world-class *generation* and their *editor*.
Every place their NLE is thin, templated, or cloud-latency-bound is a place we win on editing
depth. Every generation capability we lack is an existential gap.

**Research axes (one sub-agent each):**
1. **Aleph 2.0 / Gen-4 model** — capabilities: video-to-video, in-context editing, camera/motion
   control, character & style reference, resolution/length limits, latency, generation cost per
   second. Model cards + demos.
2. **The NLE itself** — do they actually have a multi-track timeline? Cuts/trim/ripple,
   transitions, keyframes, color, audio tracks? How deep vs. a marketing screenshot? Hunt demos
   and hands-on reviews. This axis decides the whole threat.
3. **Native-gen-on-timeline UX** — how generation is invoked from the timeline; is it slot-based
   like ours, or a separate gen tab bolted on? First/last-frame control, extend, inpaint-on-clip.
4. **Character / style consistency** — references, "Act-One"/performance capture, any identity
   system. Compare directly to our persona/seed-lock bet (build #1).
5. **API / developer surface** — Runway API: endpoints, params, pricing, what's programmable.
   Is there anything an agent could drive? (Feeds our Director/MCP story.)
6. **Pricing & credit economics** — plan tiers, credit burn per minute of video, what $12 vs
   $76 actually buys. Where users complain about cost/latency.
7. **Weaknesses** — cloud-only latency, cost, editing shallowness, no local/offline, closed
   ecosystem, collaboration limits. These are our counter-positioning.

**Extra deliverable:** a blunt verdict — *if Runway's timeline is 6 months from maturity, what
must we ship in that window to be undislodgeable?* Rank the 3 highest-leverage moves.

---

## §2 Palmier — STRUCTURAL TWIN

**Threat read to validate:** the closest structural analog to us — "the video editor built for
AI," open-core, MCP-driven, agent chat. Beatable primarily because it is **macOS/Apple-Silicon
desktop-locked** while we are cross-platform web. We already have deep poach docs on Palmier;
**this pass is a delta-and-refresh, not a cold start.**

**Prime directive:** we already mined `palmier-pro` (GPL, idea-only), `sixsevenstudio` (MIT,
code), and `palmier-skills` (Apache). Find **what changed since our last pass** and **what we
still haven't landed.** Do not re-report known poaches as new.

**Read our existing docs first** (they are in this same folder — the agent should read them):
`competitive-landscape-2026.md`, `palmier-idea-poaches.md`, `palmier-generation-pipeline-poaches.md`,
`palmier-timeline-project-poaches.md`, `palmier-search-compositing-poaches.md`,
`palmier-audio-transcription-poaches.md`, `palmier-mcp-schema-spec.md`, `sixsevenstudio-integration-pass.md`.

**Research axes (one sub-agent each):**
1. **Release delta** — every `palmier-io/palmier-pro` release since our last-recorded version
   (~v0.6.3). New tools, timeline ops, model catalog changes. Changelogs + commits.
2. **New/updated repos** — any new repo in the `palmier-io` org; license of each (permissive =
   code-copyable). Re-check `sixsevenstudio` and `palmier-skills` for new copyable material.
3. **MCP schema drift** — diff their current MCP tool schema vs. our `palmier-mcp-schema-spec.md`.
   New tools = new capabilities to match.
4. **Color/compositing** — verify current state of their Metal/Core-Image colorist (wheels, LUTs,
   scopes) vs. our flat shader; note anything new. (Prior pass corrected an earlier wrong claim —
   stay honest.)
5. **Identity/consistency** — any character-consistency system they've added; compare to ours.
6. **Traction & positioning** — stars, pricing changes, user complaints (credit economics,
   macOS-only, XML export losing gen metadata).

**Extra deliverable:** an explicit "already-poached / newly-available / still-a-gap" three-column
ledger so we never re-mine the same vein.

---

## §3 CapCut — VOLUME THREAT

**Threat read to validate:** the "CapCut half" of our positioning fighting back. Real **free**
timeline at massive scale, now bolting on text-to-video / AI avatars / voice-clone — but gen is
**weak/templated**, ByteDance-locked, and metered (~200 credits/mo). The threat is distribution
and a good-enough free editor, not gen quality.

**Prime directive:** two questions. (1) Where is their **free editor** genuinely good — the table
stakes we must match to be credible to their users? (2) How **weak/templated** is their AI, and
exactly where does our generation-first depth beat it? We win on gen depth; we must not lose on
editing fundamentals or onboarding.

**Research axes (one sub-agent each):**
1. **Free editor baseline** — the editing features CapCut gives free (multi-track, keyframes,
   transitions, auto-captions, templates, stock). This is our "don't-be-worse" checklist.
2. **AI feature audit** — text-to-video, AI avatars, voice-clone, AI B-roll: which models,
   quality ceiling, how templated vs. truly generative, output limits.
3. **Credit economics** — the 200-credits/mo model; what each AI action costs; where free users
   hit the wall. Compare to our metered-generation pricing plan.
4. **Templates & virality loop** — how their template/effect marketplace drives volume; the
   social-export UX. What's poachable as an onboarding/virality idea.
5. **Web vs. app** — is CapCut Web a real editor? Feature gaps vs. desktop/mobile. (We're web —
   know the web battlefront specifically.)
6. **Weaknesses** — ByteDance/geopolitical lock, privacy concerns, templated sameness, gen
   weakness, watermark/export limits. Our counter-positioning for creators fleeing CapCut.

**Extra deliverable:** a "credible-free-tier" spec — the minimum editing feature set we must match
so a CapCut user doesn't feel downgraded switching to us.

---

## §4 Adobe Firefly + Premiere — INCUMBENT PINCER

**Threat read to validate:** Firefly generates B-roll *on the Premiere timeline* and aggregates
~12 third-party models; unmatched distribution. But slow, ~$55/mo, and enterprise-heavy. The
pincer is distribution + model-aggregation, not agility.

**Prime directive:** two poachable ideas dominate here. (1) **Model aggregation** — Firefly as a
router over many models (Runway, Pika, Luma, Google, etc.); should *we* be a multi-model router
too, and how do they do model selection/fallback/credit-normalization? (2) **Gen-on-pro-timeline
UX** — how B-roll generation is invoked inside Premiere. Everything else about Adobe is a moat we
can't take; extract the two mechanics and their weaknesses.

**Research axes (one sub-agent each):**
1. **Firefly model aggregation** — which external models, how they're surfaced/selected, credit
   normalization across models, commercial-safety framing. This is the top idea-poach.
2. **Premiere generative workflow** — Generative Extend, text-to-video B-roll, object add/remove;
   the exact timeline UX and where it's clumsy. Compare to our slot/take mechanic.
3. **Firefly Boards / ideation** — moodboard-to-video ideation flow; compare to our visionboard.
4. **Pricing & credits** — Firefly plans, generative-credit costs, the ~$55/mo pro reality, where
   users complain about speed and credit exhaustion.
5. **Weaknesses** — latency, price, bloat, subscription lock, enterprise focus, no web-native
   agility, slow model updates. Our wedge as the fast, cheap, web-native alternative.

**Extra deliverable:** a build-vs-skip call on becoming a **multi-model router** ourselves —
pros/cons given our single-generator architecture and seed-lock bet.

---

## §5 Descript (Underlord) — AGENTIC-EDITOR THREAT

**Threat read to validate:** the closest thing in-market to our **Director** — a mature NL
co-editor ("Underlord") with 20+ agentic tasks, now with Veo/Sora generation inside a real
editor. But it's **text/podcast-first** (edit-by-transcript), which is both its strength and its
box.

**Prime directive:** Underlord is our Director's benchmark. Enumerate its **agentic task
taxonomy** in detail — every NL command it exposes — because that's the capability bar our
Director is measured against. Then find where "edit-the-transcript" as the core metaphor *limits*
them vs. our timeline-native agent.

**Research axes (one sub-agent each):**
1. **Underlord task taxonomy** — the full list of 20+ agentic actions, what each does, how invoked
   (chat? command palette?), how results are surfaced/undone. This is the core deliverable.
2. **Agent architecture (inferable)** — how it maps NL → edit ops; any tool/function-calling
   surface; multi-step planning; self-correction. Compare to our Director tool layer.
3. **Generation-in-editor** — Veo/Sora integration: how gen is invoked, placed on timeline,
   quality/limits. Compare to our generative-clip slot mechanic.
4. **Transcript-first metaphor** — the edit-by-text UX; where it's magic (dialogue/podcast) and
   where it breaks (visual-first, motion, non-verbal reels). Our timeline-native wedge lives here.
5. **Voice/audio AI** — overdub/voice-clone, filler-word/silence removal, studio-sound. What maps
   onto our orphaned Whisper/diarization/XTTS pipeline.
6. **Pricing & limits** — plans, Underlord/gen limits, user complaints.

**Extra deliverable:** a prioritized **Director capability backlog** — the Underlord tasks we lack,
ranked by user value × effort on our tool layer.

---

## §6 Higgsfield — CHARACTER-CONSISTENCY BENCHMARK

**Threat read to validate:** the gold standard for the exact thing that is our **build #1**.
**Soul ID** — train on 20+ photos → a portable identity that stays consistent across every model.
Their gap: **no timeline / no editor.** So they are less "competitor," more "the bar our personas
must clear," and a possible integration/positioning target.

**Prime directive:** reverse-engineer, as concretely as possible, **how Soul ID achieves portable
identity consistency** — training data, method (LoRA/embedding/ID-adapter?), how identity is
injected across different base models, quality, failure modes. This directly informs our persona
architecture. Secondarily: because they have no editor, frame the "identity engine + our timeline"
counter-positioning.

**Research axes (one sub-agent each):**
1. **Soul ID mechanism** — training flow (photo count/quality/pose requirements), what it produces
   (LoRA? ID embedding? adapter?), how it's applied at generation across models, consistency
   quality, failure modes. Model cards, docs, demos, teardown threads.
2. **Cross-model portability** — which base models Soul ID rides on; how identity survives model
   switches. This is the hard part our seed-lock/persona bet must match.
3. **Motion/camera control & presets** — their signature camera-move and VFX presets; what's
   poachable as prompt-library/idea for our generator.
4. **Product surface & API** — is any of this programmable? Pricing/credit model, generation limits.
5. **The editor gap** — confirm they have no timeline/NLE. Size the "identity engine but nowhere to
   assemble a reel" gap = our integration/counter-positioning wedge.
6. **Comparable identity systems** — quick scan of adjacent approaches (Runway character ref,
   InstantID/PuLID-class, Ideogram/consistent-character) to triangulate the state of the art our
   personas should target.

**Extra deliverable:** a concrete **persona-architecture recommendation** — given Soul ID as the
bar, the method (training vs. reference-adapter), data requirements, and cross-model injection
strategy we should adopt for build #1. Cite whichever open techniques (permissive) we could
actually implement.

---

### Meta-note for whoever runs these
- Run competitors **in parallel** (one lead agent each), and inside each lead, **fan out sub-agents
  per research axis**. That is the "many Sonnet agents" the brief asks for.
- After all six land, do a **cross-competitor synthesis pass**: dedupe poaches that recur (e.g.
  multi-model routing appears in Adobe *and* Runway; identity consistency in Higgsfield, Runway,
  Palmier), and produce one ranked master backlog. Fold the result into
  `competitive-landscape-2026.md`.

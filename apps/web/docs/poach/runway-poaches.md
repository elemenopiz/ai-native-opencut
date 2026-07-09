# Runway — Poach Doc (2026-07-09)

**Question this answers:** *Runway now pitches "a professional NLE combining timeline / cuts /
transitions / color with native AI generation" — our exact wedge, from the incumbent with the
best in-house model. Is that threat real? Where is their editor thin enough that we out-edit them
before it hardens, and what generation capability do we lack that is existential?*

**Method:** 7 parallel sub-agents, tiered by model — Opus on the two hardest axes (model
reverse-engineering; this synthesis), Sonnet on the five analytical axes (NLE audit, gen-on-timeline
UX, character consistency, API/dev surface, weakness hunt), Haiku on the mechanical pricing scrape.
Live web research against Runway primary docs (help.runwayml.com, docs.dev.runwayml.com, runwayml.com
news/changelog), model cards, and third-party reviews/complaints. Every claim dated; low-confidence
items flagged inline with their sourcing tier.

**Our product, one line:** a cross-platform **web** AI-native video editor (OpenCut/MIT fork) — real
multi-track NLE + generation-first "slots/takes" timeline + wired personas/seed-lock + in-app
"Director" agent + local CLIP search + local Whisper captions + WebGL transitions/effects. Python
backend at `localhost:8420` for Whisper/diarization/gen orchestration.

**License posture:** Runway is **closed/proprietary — hosted API + web app, closed weights.** Almost
everything below is **IDEA-only**; nothing is code-poachable. The two exceptions are permissive and
integration-shaped, not lifts: their **official SDKs are Apache-2.0** (`runwayml/sdk-python`,
`runwayml/sdk-node`) and their **OpenAPI spec repo is public** (`runwayml/openapi`, license unconfirmed) —
useful if we ever build a Runway *provider adapter*, which is paid API consumption, not poaching.

---

## 0. Headline: their timeline isn't 6 months from maturity — it's officially abandoned

The threat read assumed the strategic question was *"how mature is Runway's NLE, and can we out-edit
them before it hardens?"* The evidence flips the premise. **Runway's own help documentation states the
video editor "is no longer being actively maintained as our development team is focused on advancing our
generative workflows and core product features,"** and tells users to **"use a local video editor for
larger projects."** (help.runwayml.com/Timeline, verified via two independent fetches, 2026-07-09.)

That single fact reframes everything:

- The timeline **will not harden**. It is not a maturing competitor to out-run; it is a deprecated
  surface the company has publicly deprioritized in favor of models. The "professional NLE + native
  generation" marketing line is **aspirational positioning, not shipped depth.**
- Generation and editing are **four disconnected apps** — *Generative Session* (generate), the
  unmaintained *Timeline* (assemble), *Edit Studio* / Aleph 2.0 (single-clip AI transform), and
  *Workflows* (node canvas) — **bridged by manual drag-and-drop through an Assets bin.** There is no
  slot, no in-place regenerate, no clip-bound take history. (gen-on-timeline UX audit, 2026-07-09.)
- Runway has effectively **ceded the "timeline-native AI editing" category.** That is the exact
  category our slot→generate→finalize-with-takes spine occupies by construction. This is a *vacancy*,
  not just a UX gap.

**So the real threat is not their editor. It is their models.** Aleph 2.0 (in-context video-to-video
editing) and their shipped **MCP server** are the two places Runway is genuinely ahead of us. Everything
else on the editing side, we already win — *if* we close the generation-fidelity and MCP gaps before
their per-clip "Edit Studio" flow accretes enough polish that users forgive the disconnected surfaces.

---

## 1. Threat read — revised against evidence

| Assumption in the brief | Verdict | Evidence |
|---|---|---|
| Runway = "professional NLE + native AI gen," our exact wedge | **Overstated** | Editor officially unmaintained; users told to finish in Premiere/Resolve. It's a gen tool with assembly bolted on. |
| "The one competitor who could take our position outright" | **Half-true** | They can't take the *editing* position — they've abandoned it. They can out-gen us and have already out-shipped us on **MCP** (the agent surface). |
| Best in-house model (Gen-4 / Aleph) | **Confirmed on Aleph, softer on Gen-4** | Aleph 2.0 in-context editing is genuinely class-leading. Base Gen-4 T2V fidelity has the same hands/faces/complex-motion ceiling we face. |
| Web-based, $12–76/mo, cloud | **Confirmed** | And the cloud/credit/latency economics are a real, citable friction surface (§5). |

Net: **Runway is an existential threat on generation and agent-surface, not on editing depth.** Our
counter is to make editing depth + local-first + durable persona/provenance so good that being
best-at-gen isn't enough to dislodge us, while we ride their own API as a provider so we're never more
than one adapter behind on raw model quality.

---

## 2. Priority table

S = hours · M = 1–3 days · L = 1–2 weeks.
Tiers: **T1** = close or we can't win · **T2** = credibility gap · **T3** = nice-to-have.

| # | Poach | code\|idea | Relevance | Effort | Tier |
|---|---|---|---|---|---|
| 1 | **Ship an MCP server** (agent-callable generation surface; OAuth-not-API-key, curated workflow-shaped tools) | idea | Runway shipped theirs; ours is unbuilt. This is the agent-editor story. | M–L | **T1** |
| 2 | **"Edit one keyframe → propagate across the clip"** (Aleph 2.0 / Edit Studio core UX) as a timeline-native slot action | idea | Their crown jewel; lands *better* in a real timeline than in their standalone app | L | **T1** |
| 3 | **Labeled multi-reference conditioning** (`referenceImages:[{uri,tag}]` + `@tag` prompt binding, up to 3 refs: subject/scene/style) | idea | Direct upgrade to our persona/seed-lock; closes an obvious consistency gap | S–M | **T1** |
| 4 | **Provider adapter that consumes Runway's API** (Aleph v2v, Gen-4.5, Act-Two) via Apache-2.0 SDK | integration | Never more than one adapter behind on raw model quality | M | **T2** |
| 5 | **Act-Two-style performance capture** → drive a seed-locked persona from a webcam take (head/face/body/hand + audio sync) | idea (needs OSS model: LivePortrait / MuseTalk) | Genuine capability hole; complements persona = build #1 | L | **T2** |
| 6 | **First/middle/last-frame + "use this clip's frame as seed"** as a clip context-menu action (no separate node canvas) | idea | We have real timeline clips to attach it to; they force a Workflows detour | S–M | **T2** |
| 7 | **"Recipes" — bundled priced multi-step workflows** (e.g. product-ad = image→video→upscale→music) as Director macro-tools | idea | Shape for our Director/MCP tool list; better than exposing every primitive | M | **T2** |
| 8 | **`THROTTLED` task state** (queue-not-reject over concurrency cap) + deterministic pre-gen cost estimate (`rate×fps×duration`) | idea | Backend robustness + let Director reason about cost before firing | S | **T3** |
| 9 | **Text-to-LUT generator** (prompt → `.cube`, applied through our color pipeline) | idea | Cheap, visible; also chips at our flat-shader color soft spot | S–M | **T3** |
| 10 | **AI point-click mask + propagate-through-frames** (segmentation, not manual bezier) as an "auto-track mask" mode | idea | Adjacent editing depth; maps onto our mask/effects layer | M | **T3** |

---

## 3. Per-poach detail

### #1 — Ship an MCP server (T1, idea, M–L) — *the most important finding in this doc*

**What they do.** Runway shipped an **official remote MCP server** at `https://mcp.runwayml.com/mcp`
(announced runwayml.com/news/mcp). It lets Claude (Desktop + claude.ai), ChatGPT, Cursor, Replit, and
"any MCP-compatible agent" generate media against the user's Runway account conversationally.

**Exact mechanism (this is the design to mirror):**
- **Transport: Streamable HTTP only** — explicitly no SSE, no stdio.
- **Auth: OAuth against the user's existing Runway account, *no API key required.*** This is the key
  friction-reducer vs. the developer-portal API-key flow. Agent onboarding = "log in," not "paste a key."
- **Billing: consumes the user's normal *app* credits**, not the separate developer-portal API wallet.
  They deliberately routed the agent surface through the consumer billing pool.
- **Tool surface is curated/workflow-shaped, not a 1:1 mirror of REST:** text→image, text/product-URL→video,
  image→video, "multi-shot dialogue-driven video creation," product-marketing generation. Higher-level
  than the raw endpoint list.

**Code vs idea.** IDEA (hosted, closed server — no repo found). Poach the *shape*: Streamable-HTTP
transport, OAuth-over-API-key for agent contexts, curated workflow-tools rather than raw-route dump.

**How to build on our stack.** We already have the Director tool layer (`lib/director/director-api.ts`
per our own competitive-landscape doc). We are "one transport away." Stand up a Streamable-HTTP MCP
endpoint in front of the Director tools; expose a *curated* set (generate-slot, regenerate-take,
apply-persona, assemble-reel) not the whole internal API. **Differentiator vs. Runway:** ours drives a
*real timeline* (slots, takes, tracks, transitions), not just "make me a clip." Runway's MCP can generate
media; ours can *edit a project*. That is the story: **"the MCP that edits your timeline, not just your
render queue."** This also closes the same gap Palmier opened on us — one MCP build answers both
competitors. See [[opencut-ecosystem-poaches]] / competitive-landscape doc.

### #2 — "Edit one keyframe → propagate" as a timeline-native slot action (T1, idea, L)

**What they do.** Aleph 2.0 (May 21 2026) + "Edit Studio": you edit **one still frame** (mask/inpaint/
restyle/swap product/remove object), preview it as an image, then the model **propagates that change
across the clip** while preserving everything you didn't touch. Handles ≤30s @ 1080p and propagates
across multiple shots (~up to 10 cuts, one secondary source; official page says "relevant shots").
Accepts up to 5 keyframe/anchor images.

**Exact mechanism.** In-context video-to-video conditioned on an edited anchor frame; API-exposed as
`POST /v1/video_to_video` with model `aleph_2` (`referenceImages` for anchors). Cost ~28 cr/s ($0.28/s
output, 56-credit minimum) — roughly 2× the cost of plain generation.

**Code vs idea.** IDEA. Runway is closed; we reimplement, or (near-term) we call their v2v endpoint via
our provider adapter (#4) as the propagation engine while owning the UX.

**How to build on our stack.** This slots *natively* into our spine and lands **strictly better than
Runway's** because we have a real timeline and they don't:
- Add an **"AI Edit"** action to a generative-slot clip's context menu → opens the clip's representative
  frame → user masks/prompts the change → preview-as-image → "propagate" writes a **new take** on the
  same clip (versioned, swappable), not a new asset in a bin.
- **Multi-shot propagation via our persona/scene tags:** we already know shot boundaries (they're our
  slots); apply one edit across all slots on a track sharing a persona/scene tag. Aleph has to *detect*
  shot boundaries; we *have* them. That's a structural advantage.
- Reuse existing seed-lock/persona machinery so an edit respects the locked identity.

### #3 — Labeled multi-reference conditioning (`@tag`) (T1, idea, S–M)

**What they do.** Gen-4 References accepts up to **3 reference images**, each with a **tag**; the prompt
binds them by name, e.g. `"@EiffelTower painted in the style of @StarryNight"`. Data contract:
`referenceImages: [{ uri, tag }]`. No fine-tuning — inference-time conditioning. Ref resolution capped
low (≤720×720 / 1280×720). Their own ecosystem admits references are **"soft suggestions"** that drift on
camera-angle change and prompt tweaks — no persisted identity object, seed exposed only on image-to-video.

**Code vs idea.** IDEA (the *contract shape* is the poach — cleaner than a flat reference list).

**How to build on our stack.** Extend the **persona** object to hold up to 3 *labeled* references
(character / scene / style) that our unified generator passes as distinct tagged conditioning inputs.
This is where **our design is already ahead**: Runway re-conditions from scratch every generation; our
persona = a durable, named, reusable **seed + tagged-refs bundle** locked across the whole timeline.
Adopt their `@tag` binding *inside* our persistent persona, and we get their compositionality *plus* our
durability. Low effort, high consistency payoff. Ties directly to build #1.

### #4 — Runway provider adapter (T2, integration, M)

**What they do.** Full production REST API (base `api.dev.runwayml.com` / `api.runway.team` — mid-migration,
verify canonical): `/v1/text_to_image`, `/image_to_video`, `/text_to_video`, `/video_to_video` (Aleph 2.0),
`/character_performance` (Act-Two), `/image_upscale`, `/video_upscale`, audio suite (TTS via ElevenLabs,
SFX via Seed Audio, dubbing, voice isolation). Async task model: POST → task id → poll `/v1/tasks/{id}`;
`waitForTaskOutput()` helper (10-min default timeout). **Official SDKs are Apache-2.0.** Credits $0.01
each; **API wallet is entirely separate from app/MCP credits.**

**Code vs idea.** INTEGRATION (paid API consumption). Apache-2.0 SDK is safe to depend on; public
OpenAPI spec lets us codegen a typed client (confirm spec-repo license first).

**How to build on our stack.** Add Runway as one adapter behind our unified generator in the Python
backend, alongside our existing providers. This is the pragmatic hedge on the existential gap: we don't
have to *match* Aleph/Gen-4.5 fidelity in-house if we can *call* it for the slots that need it, while our
local-first stack does the free surrounding work (search, captions, transitions, cuts). Never more than
one adapter behind on raw quality.

### #5 — Act-Two performance capture → drive a locked persona (T2, idea, L)

**What they do.** Act-Two (Jul 16 2025, initially Enterprise-gated, later broadened): inputs =
`promptImage` (character ref, still or video) + `promptPerformance` (driving video); tracks **head, face,
body, and hand** motion + audio, with automatic lip/gesture sync. Params: `bodyControl` (bool),
`expressionIntensity` (1–5), `seed`. API-exposed (`/v1/character_performance`, model `act_two`), 5 cr/s.
Not studio-mocap accurate; degrades on complex multi-actor scenes / highly stylized refs.

**Code vs idea.** IDEA / capability hole — we have **nothing in this class**. No code to lift; needs its
own model. OSS routes flagged in prior research: **LivePortrait**, **MuseTalk** (see [[opencut-ecosystem-poaches]]).

**How to build on our stack.** If persona/identity is build #1, "drive this persona with a reference
performance" is the natural build #2 — and it's *differentiated* if wired to our **durable** personas
rather than one-off refs like Runway. A webcam take drives a seed-locked persona → lands as a take on the
clip. Longer horizon; needs an OSS driving-video model in the Python backend.

### #6 — First/last-frame + "use this clip's frame as seed" (T2, idea, S–M)

**What they do.** First/middle/last-frame image conditioning exists on the generation form (Gen-3
keyframes; Gen-4.5 first-frame I2V, Jan 2026). But to pull a frame off an *existing* clip and feed it back,
Runway forces you into the separate **Workflows** node canvas (frame-extractor node → chain into next
video node). Another context switch, not a clip action.

**How to build on our stack.** Make it a one-click **clip context-menu action**: "use this frame as
seed / first frame / last frame" directly on a timeline clip, feeding our generator. We have the clips on
the track; we don't need their node-canvas detour. Strictly better ergonomics.

### #7 — "Recipes" as Director macro-tools (T2, idea, M)

**What they do.** Runway productizes common multi-step chains as single priced/callable units — e.g. a
"Product Ad" recipe (image→video→upscale→music) = 200–228 credits for a 4s base, scaling with duration.
Their MCP tool surface is recipe-shaped, not primitive-shaped.

**How to build on our stack.** Expose Director/MCP **macro-tools** ("make a product ad," "make a talking-head
reel") that internally chain our slot primitives, rather than forcing the agent to orchestrate every
primitive. Cleaner agent surface, fewer round-trips, better token economy (ties to our agent-token-efficiency P0).

### #8 — `THROTTLED` task state + pre-gen cost estimate (T3, idea, S)

Runway's async API has no RPM limit; it gates by concurrency and, on overflow, marks a task `THROTTLED`
(persisted server-side, run when capacity frees) instead of hard-rejecting. And credit cost is a
deterministic function `credits = ceil(rate × fps × duration / $0.01)`. Poach both: a queue-not-reject
state in our gen backend, and a **pre-generation cost estimate surfaced to the Director** so the agent can
reason about budget before firing.

### #9 — Text-to-LUT generator (T3, idea, S–M)

Runway generates a `.cube` LUT from a text prompt, then makes you export it to another editor. Poach the
generator, but apply the LUT **in-app** through our color pipeline — which also chips at our known flat-shader
color soft spot. We keep the user in the editor; they push the user out.

### #10 — AI point-click mask + propagate (T3, idea, M)

Runway's masking is point-based AI segmentation with mask propagation across frames (not manual bezier).
Add an "auto-track mask" mode on our mask/effects layer. Note: shape/bezier masks were already flagged as
a gap in [[opencut-ecosystem-poaches]]; an AI-segmentation mode is complementary.

---

## 4. Their weakness = our wedge (counter-positioning headlines)

1. **"Byorn is a real multi-track NLE with generation built in. Runway abandoned its timeline and tells you to finish in Premiere."**
   Their own docs: editor "no longer actively maintained," "use a local editor for larger projects."
   Editing-depth changelog has been **flat since 2024** — no transitions library, no color wheels/curves/scopes,
   no property keyframes, no audio waveform/ducking, official **10-layer** browser perf cap, and **black gaps
   break export.** Their "keyframes" are a *generation* prompt, not timeline animation. We have real keyframes,
   22 WebGL transitions, and a color pipeline they simply don't have in-app.

2. **"Generation is the clip, in place, versioned — not a separate app you drag out of."**
   Runway = four disconnected surfaces (Session / Timeline / Edit Studio / Workflows) bridged by manual
   drag-through-Assets. No slot, no in-place regenerate, no clip-bound takes. Our slot→generate→finalize-with-takes
   collapses their multi-step round-trip into one gesture.

3. **"No credits, no expiring balance, no paying for failed generations."**
   Standard ($12–15/mo, 625 credits) buys only **~25s of finished Gen-4.5**; a realistic **3–8× iteration
   multiplier** means one polished scene can eat a month's budget. Failed generations still burn credits
   ("expected behavior" per their help center), credits **don't roll over** below Max, and there's a
   **12–6pm UTC latency tax**. Our local-first stack does search/captions/transitions/cuts for free and offline;
   we only meter the actual generation slot.
   *(Pricing note: web-app Gen-4.5 was scraped at ~25 cr/s by the Haiku pass; the API meters Gen-4.5 at 12 cr/s.
   Treat the exact web rate as re-verify-pending; the iteration-multiplier economics hold either way.)*

4. **"MIT-licensed, self-hostable, auditable — not one company's closed weights, GPUs, and no-refund suspensions."**
   Closed weights, cloud-only, no offline path, ~13 status-page incidents / trailing 90 days. Official policy:
   moderation **cannot be disabled even with artist permission**; denied suspension appeal = **canceled plan, no refund.**
   And Runway is a defendant in **80+ active training-data suits** (Gardner v. Runway, Feb 24 2026, C.D. Cal.
   2:26-cv-01941 — the 4th DMCA-circumvention case; plus the N.D. Cal. artist class action).

5. **"Provenance that's accurate and survives your edit."**
   Runway gets the C2PA paradox *both* ways: source credentials **vanish** once footage is edited/graded/exported
   through a real NLE, yet their background-removal C2PA signature has been reported to **wrongly persist**, making
   authentic footage get flagged as AI. Our generation-provenance sidecar (seed/prompt/model) is designed to
   survive export deliberately and only tag what's actually generated.

6. **"Durable personas, not soft references that drift."**
   Runway's consistency is ephemeral: ≤3 prompt-time refs, "soft suggestions" that drift on angle/prompt change,
   seed exposed only on I2V, no reusable identity object. Our persona = seed + tagged-refs locked across the whole
   project. The gap to close is **raw fidelity**, not design — their design is *behind* ours here.

---

## 5. What we already beat them on / deliberately ignore

**Already beat (defensible, structural — they can't copy without abandoning their model):**
- Real multi-track NLE depth: property keyframes + easing, 22 WebGL transitions, in-app color pipeline,
  audio track model. Runway has none of these in-app and has stopped building them.
- Timeline-native generation (slot → generate → finalize, clip-bound takes) — a category they *ceded*.
- Cross-platform web, no install; local-first CLIP search + local Whisper captions (free, offline, private).
- Durable persona/seed-lock design; provenance-that-survives-export.
- MIT / self-hostable / auditable.

**Deliberately ignore:**
- **Racing their base-model fidelity in-house.** Their Gen-4 T2V has the same hands/faces/complex-motion
  ceiling we'd hit. Don't burn runway (pun noted) training a competitor to Aleph — *call it via the adapter* (#4).
- **Reselling third-party models** (Veo 3, Seedance) — Runway is becoming an aggregator; that's a distribution
  game we don't need to play now.
- **Collaboration parity** — the weakness hunt found this axis too thin on both sides to be a wedge; don't message on it.
- **Their standalone Edit Studio as a separate app** — we take the *interaction* (edit-frame→propagate), not the
  separate-surface architecture, which is exactly the seam we exploit.

---

## 6. Extra deliverable — blunt verdict: what must ship in the window

**The premise correction:** Runway's timeline is **not** 6 months from maturity — it's abandoned. So the
window isn't "before their NLE hardens." The real clock is: **before their per-clip "Edit Studio" flow gets
polished enough, and their MCP ubiquitous enough, that users forgive the four-app disconnect and never try a
real timeline-native tool.** The threat is *category capture by convenience*, not editing depth. To be
undislodgeable in that window, three moves, ranked by leverage:

1. **Ship the MCP server — now (T1, #1).** This is the single highest-leverage move and it's double-duty:
   it closes the gap to *both* Runway and Palmier, and it's the whole "editor built for AI agents" story. We're
   reportedly one transport away from exposing the existing Director tools. Copy Runway's proven decisions
   (Streamable-HTTP, OAuth-over-API-key, curated workflow-tools) but point them at a **real timeline** — "the MCP
   that edits your project, not just your render queue." If we ship nothing else, ship this.

2. **Make timeline-native AI editing undeniably better than their four-app shuffle (T1, #2 + #3).** Land
   "edit-one-frame→propagate-as-a-take" and labeled multi-reference personas *inside the timeline*, powered
   near-term by the Runway/other adapter so we don't wait on in-house fidelity. The pitch writes itself: their
   generation is a destination you navigate to; ours is an operation on the clip. Prove that in a 30-second demo.

3. **Ride their models via the adapter while hardening our durable-persona + provenance moat (T2, #4 + #5).**
   Neutralize the existential gap by *calling* Aleph/Gen-4.5/Act-Two instead of racing them, and spend the
   in-house effort on the things they structurally can't ship: personas that don't drift, provenance that
   survives export, and (build #2) performance-capture wired to durable identities. Their model lead stops
   being a wedge the moment we can invoke it; our identity/provenance lead compounds.

**One-line verdict:** *Runway will out-generate us and has already out-MCP'd us — but it has publicly quit the
editor. Ship the MCP surface and timeline-native AI edits on top of a provider adapter, and their model lead
becomes our feature while our editing depth becomes the thing they can't buy back.*

---

## 7. Freshness note — sources, tiers, and what to re-check

**Access date: all claims 2026-07-09.** Runway ships models weekly and rebrands surfaces (runwayml.com →
runway.team mid-migration); treat capability dates as a snapshot.

**By producing tier (re-verify lowest-confidence first):**
- **Haiku (pricing, §5 / #8):** re-verify next by **Q4 2026**. Specific flag: **web-app Gen-4.5 rate (~25 cr/s)
  conflicts with the API rate (12 cr/s)** — reconcile against the live pricing page before quoting a number
  externally. Failed-gen credit-drain and no-rollover: confirmed via help center + review aggregation.
- **Sonnet (NLE, gen-UX, character, API, weaknesses):** the load-bearing quote — editor "no longer actively
  maintained" — is **primary-source, double-verified.** Transition *count* in Runway's editor is unverified
  (docs enumerate none; treat "thin" as inference). Act-Two current access tier and Aleph "10-cut" propagation
  are secondary-sourced. Reddit/Trustpilot specifics were 403-blocked — directionally true, don't quote verbatim
  without a Playwright/archive pass. Runway MCP launch date not captured — get it if timeline dating matters.
- **Opus (model recon + this synthesis):** Gen-4 Turbo latency ("10s in ~30s") and fps are community-sourced,
  not official benchmarks. "Aleph API deprecating / sunset July 30 2026" from the pricing doc — confirm scope.

**Re-check triggers:** (a) any Runway changelog entry touching "Studio"/timeline — if they *resume* editor
investment, revisit §0; (b) canonical API domain once the runway.team migration settles; (c) whether Act-Two
and Aleph v2v remain API-exposed if they consolidate models.

**Related internal docs:** competitive-landscape-2026.md (the MCP + agent-brain gaps this doc reinforces),
[[opencut-ecosystem-poaches]] (LivePortrait/MuseTalk for #5, shape masks for #10), [[palmier_competitive_analysis]]
(the *other* MCP threat — one build answers both).

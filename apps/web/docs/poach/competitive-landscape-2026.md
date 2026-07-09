# Competitive Landscape & Gap Analysis — 2026-07-09

**Question this answers:** *What is our product missing that competitors (chiefly Palmier)
ship, what do we already beat them on, and how do we win?*

**Method:** three parallel research passes on (1) Palmier's current public repos + product,
(2) the wider AI-video and prosumer-editor field, (3) a truthful audit of our own
shipped-vs-stubbed features. This doc supersedes the competitive claims in the older poach
docs where they conflict — see the freshness note at the bottom.

**Our product, one line:** a cross-platform **web** AI-native video editor (OpenCut fork) —
real multi-track NLE + generation-first "slots/takes" timeline + wired personas/seed-lock +
in-app "Director" agent + local CLIP search + local Whisper captions + WebGL
transitions/effects.

---

## 0. Headline: Palmier out-shipped our own 12-day-old docs

Palmier is now **v0.6.3** (~15 releases in 3 weeks, shipping every 1–3 days). Four things our
existing poach docs listed as *gaps* or *unbuilt* are now **live in their product**:

- `apply_layout` predefined multi-clip layouts (split-screen / PIP / grid)
- Beat/downbeat detection with snap-to-beat grid + waveform ticks
- Silence / dead-air removal
- Denoise / audio-enhancer, plus multicam clip-sync (timecode/audio/auto)

**Implication:** the gap moved against us while we documented it. Assume Palmier closes its own
feature gaps weekly; do not plan around a static target. Our defensible advantages are the ones
they *structurally cannot* copy (platform, cloud, web), not feature checklists.

Stars: **~10,170** (roughly flat). Still v0.6, "bare-bones" per reviews. Two-person YC S24 team.

---

## 1. What we're MISSING that Palmier ships

Split into what decides the fight vs. what to deliberately ignore.

### Tier 1 — close these or we can't win (their real moat)

| Gap | Palmier | Us today | Why Tier 1 |
|---|---|---|---|
| **MCP server** — external agents drive the timeline | Local MCP at `127.0.0.1:19789`; Claude Code / Desktop / Cursor / Codex issue edits | In-app Director only; **no MCP surface** | This *is* their ~10k stars — the growth engine and the whole "editor built for AI" story. We already have the Director tool layer (`lib/director/director-api.ts`); we're one transport away but haven't shipped it. |
| **Agent brain** | Runs **Claude Sonnet 5** (adaptive thinking) | Runs **local Ollama** via Python backend (`localhost:8420`) | Our Director is structurally dumber regardless of tool quality. If the agent is the soul of the product it cannot default to a weak local model. Single biggest perceived-quality lever. |
| **Audio intelligence as timeline ops** | Silence/dead-air removal, speaker detect, beat-snap grid, denoise, multicam sync — on-device | We **own the compute** (Whisper, pyannote diarization, XTTS backends) but it's **half-orphaned** — `speaker-captions.tsx` imported nowhere; beat/silence/sync not wired as edit ops | "We have the parts, they aren't assembled." Cheapest high-value catch-up; Palmier just made all of it table stakes. |

### Tier 2 — credibility gaps, close soon

- **`apply_layout` / multi-clip layouts** (split / PIP / grid) — user- and agent-facing. Cheap,
  high-visibility, already in our idea-poach list, unbuilt.
- **Color grading** — *contested but real gap*. Our source-read of their `Compositing/` found a
  Metal/Core-Image colorist (wheels, LUTs, scopes); the review-based pass says "no color."
  Either way **we lose** — we ship only a flat 5-uniform shader + `auto-color-profiles.ts`, no
  curves/LUT/wheels panel.
- **NLE XML export** (Premiere / DaVinci / FCPXML) — they let pros finish elsewhere; we export
  only mp4/webm. **We can beat them here:** their XML loses all generation provenance; ours can
  carry a sidecar (seed/prompt/model survives export).
- **Agent token efficiency** — mutation-delta responses, short-IDs, strict frames-vs-seconds.
  Our P0 poach, unbuilt; without it our agent chokes on big reels while theirs doesn't.
- **Text animation presets** — they shipped; we have transitions/effects but not animated text.

### Tier 3 — their rabbit holes: do NOT chase feature-for-feature

- **Native on-device DSP performance** — Apple-Silicon Metal vs. our browser WASM. We lose the
  raw-perf race permanently. Ship "good enough," win on reach.
- **Model breadth** — they now aggregate Kling V3, Veo 3.1, Grok Imagine, Nano Banana Pro +
  Seedance. Keep our deliberate single-provider cost bet, but keep **one escape hatch**: add a
  frontier model behind the adapter only if hero-shot fidelity visibly lags.

---

## 2. What we already BEAT Palmier on (the wedges to press)

- **Cross-platform web** — Palmier is **macOS 26 Tahoe + Apple Silicon ONLY**. No Windows,
  Linux, Intel Mac, web, or mobile. Reviewers flag this as disqualifying for most users. **Our
  entire reason to exist.**
- **Transitions** (12+ WebGL shaders, `lib/transitions/`) and **effects** (13 shaders,
  `lib/effects/`) — they have *none*.
- **Cloud + auth + persistence** (better-auth/Postgres) — they're local, single-user.
  Collaboration, link-sharing, mobile capture are structurally hard for them, native for us.
- **Git-style version control** (`app/api/version-control/`) — better than their duplicate /
  multiple-timeline branching.
- **Generation-first spine** — generative slots/takes, seed-lock, promote-to-1080p, personas
  wired end-to-end (`lib/studio/`). Their editor is footage-first; the regenerate-in-place
  round-trip is ours.

---

## 3. The wider competitive map (ranked by threat to us)

| # | Competitor | Category | Threat | Why | Pricing |
|---|---|---|---|---|---|
| 1 | **Runway (Aleph 2.0)** | AI-native editor | **Existential** | Now pitches a pro NLE (timeline/cuts/transitions/color) **with native AI generation** — our exact wedge, from the incumbent with the best in-house model. Web-based. Move before their timeline matures. | $12 / $28 / $76 mo |
| 2 | **Palmier Pro** | AI-native editor | **Structural twin** | Everything in §1. Beatable only because it's Mac-desktop-locked. | Free / $29 / $69 mo |
| 3 | **CapCut** | Prosumer + AI | Volume | Real free timeline + adding text-to-video/avatars/voice-clone, but gen is weak/templated, ByteDance-locked, 200 cr/mo. The "CapCut half" of our positioning fighting back. | $10 / $20 mo |
| 4 | **Adobe Firefly + Premiere** | Incumbent + AI | Distribution pincer | Firefly generates B-roll on the Premiere timeline, aggregates 12 models (incl. Kling 3.0). Slow, ~$55/mo, 5-sec clips — but unmatched distribution. | Firefly $9.99; CC ~$55–60 mo |
| 5 | **Descript (Underlord)** | Editor + agent | Agentic-editor | Mature NL co-editor (20+ tasks) with Veo 3.1/Sora 2 inside a real editor. Closest in-market analog to our Director. Text/podcast-first, not shot-based. | Creator $24 mo |
| 6 | **Higgsfield** | AI generator | Benchmark | **Soul ID** (train on 20+ photos → identity portable across every model) is the character-consistency gold standard our personas chase. **No timeline** — still their gap. | $15 / $39 / $99 mo |

**Pure generators with no timeline** — dangerous only if one bolts on a real editor: Pika, Luma
Dream Machine, Kling, Google Veo 3 / Flow, OpenAI Sora 2, Krea, Captions.ai, HeyGen, Argil,
Invideo AI.

### The one capability each category beats us on
- **AI generators:** trained, portable identity (Higgsfield Soul ID, Sora 2 cameos). Ours are
  reference-conditioned, no training, single-provider — good, weaker guarantee. **Our build #1.**
- **Prosumer editors:** finishing-craft depth — DaVinci Resolve 21 (IntelliTrack, HDR grade;
  free / Studio $295) and Premiere Color Mode outclass any web editor on color/tracking/pro
  audio. Don't try to match; win on the gen loop.
- **Structural competitors:** frontier model quality + breadth (Runway's own model; Krea/
  Higgsfield aggregation). Our counter is curation, not breadth — but a visible fidelity gap on
  hero shots is the risk of BytePlus-only.

---

## 4. White space — what nobody owns (take it)

1. **Cross-platform browser + real timeline + on-timeline generation + a timeline-editing
   agent.** Runway is web but its timeline is nascent; Palmier is the only true match and is
   **Mac-desktop-only**. This position is currently unoccupied.
2. **The regenerate-in-place round-trip.** Every generator ships you a clip to reassemble
   elsewhere; every editor makes you leave to generate. Seed-lock + promote-to-1080p +
   "regenerate this shot in place, never re-import" closes a loop none of them do.
3. **Local, $0, private AI** — in-browser CLIP search + Whisper captions. Everyone else meters
   these as cloud credits. Privacy + zero-marginal-cost is a real, uncopied differentiator.
4. **Honest pricing + no silent downgrade.** The field runs opaque, expiring credit traps
   (Higgsfield 90-day expiry; Palmier "shifts with every model update"; CapCut/InVideo
   complaints). Transparent price-per-reel + a delivery-promise lock (no silent video→slideshow
   substitution) is trust *and* on-brand for "cheaper and better."

---

## 5. How to win — press what they can't follow

Matching Palmier feature-for-feature is a losing game (they ship daily, natively). Win by
weaponizing what a Mac-only desktop app **structurally cannot do**:

1. **Ship the MCP server + upgrade the Director to a frontier model.** Neutralize their moat and
   growth loop on *your* cross-platform surface. Highest-leverage pair of moves on the board.
2. **Wire the audio pipeline you already own.** Fastest route to NLE parity — the compute
   exists, it just isn't connected.
3. **Own the unoccupied position** (§4.1): cross-platform browser + real timeline + on-timeline
   gen + editing agent.
4. **Lean on the round-trip + provenance** (§4.2): regenerate-in-place, export that survives
   with seed/prompt intact (their XML doesn't).
5. **Beat Higgsfield on Soul-ID-grade personas** (trained, portable identity) — the one gap that
   compounds across every other feature.
6. **Weaponize honest pricing** (§4.4) against a field of unstable, expiring credit traps.

**Sequencing:** Tier 1 (MCP + agent brain + audio wiring) → white-space marketing → personas
upgrade → Tier 2 credibility gaps. Move before Runway's timeline matures and before Palmier
ships web/Windows.

---

## 6. Next actions (sequenced)

Ordered by leverage, not by size. The principle: **make the agent credible first (cheap), then
ship the two Tier-1 moves that Palmier can't follow on our platform, then close credibility
gaps.** Effort key: `S`=hours, `M`=1–3 days, `L`=1–2 weeks.

### Sprint 0 — unblock & de-embarrass the agent (this week, all cheap)
*Goal: the Director stops making token/latency/bug mistakes before we put a better brain and an
MCP surface on top of it.*

1. **Token-efficiency batch** `[M]` — short-IDs (`lib/director/short-id.ts`), mutation-delta
   returns on every mutating verb, strict frames-vs-seconds in the system prompt + verb schemas.
   Palmier already refined this; without it our agent chokes on big reels.
2. **Expose shipped capabilities to the agent** `[S each]` — add `searchMedia` (wrap our CLIP
   search), `addText`/`updateText` (`TextElement` already exists), and register the existing
   `trim`/`move`/`split` API verbs into `agent.ts` TOOLS.
3. **Fix the 4 known incidental bugs** `[S]` — sequential `await` in `use-slot-generation.ts`
   (:98/:138 → `Promise.all`), no-op drag in `use-element-interaction.ts:463`, unwired
   `use-generation-polling.ts` (takes stuck "generating" never recover on reload), dead
   `CompoundClip` type. Cheap correctness wins that show up immediately in demos.

**Win condition:** agent can find footage, add titles, trim/move, and survive a big reel without
blowing the step budget.

### Sprint 1 — the two Tier-1 moves that actually move the needle (weeks 1–2)

4. **Upgrade the Director's brain** `[M]` — route `/api/llm/chat` to a frontier model (Claude
   Sonnet 5 / Opus) as the default; keep local Ollama as an optional privacy mode. Single
   biggest perceived-quality lever. Do this *after* Sprint 0 so a smart model gets clean tools.
5. **Wire the audio pipeline we already own** `[M–L]` — connect the orphaned/backed compute into
   timeline edit ops: silence/dead-air removal, beat-snap grid, denoise, diarization-driven
   captions (`speaker-captions.tsx` is imported nowhere — wire it into `viewMap`), and make TTS
   output a first-class `Take` with provenance (fixes the "voice-lock un-wireable" TODO). This is
   assembly, not new R&D — Whisper/pyannote/XTTS backends already run.

**Win condition:** we reach Palmier's just-shipped audio parity using parts we already have, on a
platform they can't reach.

### Sprint 2 — the growth moat (weeks 2–4)

6. **Ship the MCP server** `[L]` — build on the now-clean shared tool layer (`director-api.ts`
   `toolCatalog()`), HTTP/SSE transport. **Web-specific difference:** no loopback trust — gate
   with a scoped per-project token (OAuth/PAT), unlike Palmier's no-auth local model. Adopt the
   Sprint-0 short-id + mutation-delta shaping from day one.
7. **One-click MCP installers** `[S]` — config deep-links for Claude Desktop / Cursor / Codex to
   kill the setup tax. This is the free-marketing / star-driving loop.

**Win condition:** "drive your timeline from Claude Code / Cursor" — but cross-platform, on the
web, for everyone Palmier's Mac lock-in excludes.

### Sprint 3 — Tier-2 credibility gaps (weeks 4–6)

8. **`apply_layout` verb + UI** `[M]` — named split/PIP/grid layouts, transforms computed
   server-side; forbid the low-level per-clip path to the agent.
9. **Color grading panel** `[L]` — curves/LUT/wheels over our WebGL pipeline; retire the flat
   5-uniform shader. Needed for "real editor" credibility vs. their `Compositing/` colorist.
10. **NLE XML export + provenance sidecar** `[M]` — Premiere/DaVinci/FCPXML export, and ship a
    seed/prompt/model sidecar JSON that survives export. Directly turns *their* weakness (XML
    loses provenance) into *our* headline.

### Sprint 4 — the compounding bet (weeks 6–8)

11. **Personas → Soul-ID-grade** `[L]` — move from reference-conditioned (no training) toward
    trained, portable identity; enable the currently-disabled photo-upload anchor
    (`persona-manager.tsx:229`). This is the one gap that compounds across every other feature and
    is our answer to Higgsfield.

### Parallel / ongoing (not code)

12. **Pricing & positioning** — publish transparent price-per-reel; market "regenerate in place,
    never re-import," cross-platform-web, and local-free captions/search against a field of
    expiring credit traps. Align credit metering in `lib/studio/cost.ts` with it.

### The critical-path summary
> **Sprint 0 (agent hygiene) → Sprint 1 (frontier brain + audio wiring) → Sprint 2 (MCP + installers).**
> These three are the "destroy them" core: they neutralize Palmier's moat *and* growth loop on a
> surface Palmier can't reach, mostly by assembling things we already have. Everything after is
> credibility and compounding. Move before Runway's timeline matures and before Palmier ships
> web/Windows.

---

## Sources & freshness

- Palmier: github.com/palmier-io/palmier-pro (releases v0.4.5–v0.6.3), palmier.io + /pricing,
  README; CrePal, AIToolly, explainX reviews (2026).
- Field: Runway (runwayml.com/research/introducing-runway-aleph), Adobe (blog.adobe.com, Apr
  2026), Higgsfield (higgsfield.ai/pricing, Soul ID), CapCut, Descript, DaVinci Resolve 21.
- Our baseline: repo audit of `apps/web/src/lib/studio/`, `lib/director/`, `lib/transitions/`,
  `lib/effects/`, `app/api/version-control/`, assets-panel views, `services/ai-backend`.

**Supersedes:** where the older `palmier_competitive_analysis` memory and the poach docs list
`apply_layout`, beat detection, or silence removal as *our* wedges, they are now **stale** —
Palmier shipped all three. Transitions/effects remain genuine wedges; color grading is a gap for
us (their `Compositing/` colorist verified by source-read, ahead of our flat shader).

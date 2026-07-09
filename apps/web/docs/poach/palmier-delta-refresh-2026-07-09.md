# Palmier delta-refresh — 2026-07-09

**A delta-and-refresh pass, not a cold start.** Our prior Palmier corpus
(`palmier-mcp-schema-spec.md`, `palmier-idea-poaches.md`,
`palmier-generation-pipeline-poaches.md`, `palmier-timeline-project-poaches.md`,
`palmier-search-compositing-poaches.md`, `palmier-audio-transcription-poaches.md`,
`sixsevenstudio-integration-pass.md`, `competitive-landscape-2026.md`) was
written earlier the same day. This pass asks only two questions: **what changed
since, and what have we still not landed?** Method: six parallel sub-agents,
model-tiered by task difficulty (Haiku for lookup, Sonnet for audit, Opus for
the precision schema-diff and this synthesis), each handed the relevant baseline
doc so it reports *delta*, not known state.

---

## 1. Header

- **Competitor:** Palmier Pro (`palmier-io/palmier-pro`), Palmier Inc. (YC S24).
- **One line:** "The video editor built for AI" — a macOS-native NLE with an
  in-app Claude agent and a local MCP server.
- **License / stack / platform:** GPL-3.0, Swift + Metal/Core Image,
  **macOS 26 Tahoe + Apple Silicon only** (no Windows/Linux/Intel/web/mobile).
  → their code is **IDEA-ONLY** for us (copyleft; we are MIT).
- **Pricing:** Free (editor + MCP + local transcription) / Pro $29 (launch, reg.
  $49; 5,000 credits ≈ 3–7 min video) / Max $69 (reg. $99; 12,000 credits) /
  Custom. **No BYO-API-key** — credits bought from Palmier, full lock-in.
- **Traction:** ~10.2k★ (flat), 761 forks, 2-person team, $500K seed, no
  Series A. Latest release **v0.6.3 (2026-07-08)**; HEAD `cd74ce3` (2026-07-09).
- **Last verified:** 2026-07-09 (all six axes, primary sources).

---

## 2. Threat read — confirmed, unchanged

The threat read holds exactly as stated: Palmier is our **closest structural
analog** — open-core, MCP-driven, agent-chat, "editor built for AI" — and is
**beatable primarily because it is macOS/Apple-Silicon desktop-locked while we
are cross-platform web.** This refresh *strengthens* that read rather than
revising it: their platform lock is hard and unmoving (open issues #195/#262 for
Windows, #222 Intel-Mac crash; only an unofficial fan fork
`Voidsprog/palmier-pro-windows` exists), no cross-platform expansion is
signaled, and two capability gaps we suspected are now **confirmed absent** (see
§5). The one thing that genuinely moved *against* us since the corpus was
written is nothing on the tool surface — it is that they now run **Claude
Sonnet 5 with adaptive-thinking low-cost mode** (v0.6.3) while our Director still
defaults to local Ollama.

**Net delta verdict: quiet.** The tool surface is frozen, the permissive-code
vein is exhausted, no new repos exist, and our baseline docs are current. The
poach backlog did **not** grow. What this pass yields is: two factual
corrections (already applied), a handful of mechanism refinements to
already-ranked items, one newly-available **CODE** path (permissive WebGL LUTs),
and hardened confidence on two wedges.

---

## 3. Priority table (only what is NEW or refined this pass)

Nothing here is a brand-new capability of theirs we must chase — the prior
roadmap (token-efficiency P0s, MCP server, frontier brain, audio wiring) stands
untouched. These are the *deltas*: refinements with newly-specific mechanisms,
plus one new copyable resource.

| # | Poach / action | code\|idea | Relevance | Effort | Tier/Prio |
|---|---|---|---|---|---|
| 1 | **Route persona refs through Seedance omni-reference** (not only the gpt-image pre-render) | idea (our plumbing exists) | Build #1 — identity | M | **T1** |
| 2 | **Lift the single-`personaId` ceiling** → per-character reference images, multi-subject scenes | idea | Build #1 — identity | M | **T1** |
| 3 | **Reference-sheet mode** in `renderPersonaStill` (front/side/profile in one gpt-image call) | code (ours) | Persona-creation UX | S | T2 |
| 4 | **Color scopes / measurement engine** (Canvas2D) — turns our *fake* auto-correct real; prerequisite for any agent color verb | idea | Real-footage credibility | M | T2 |
| 5 | **`.cube` LUT ingestion via permissive libs** (three.js `LUTPass` MIT / pmndrs `LUT3DEffect` + OpenColorIO BSD) | **CODE** | Color gap, no GPL touch | M | T2 |
| 6 | **Vectorscope / waveform UI panel** — *they don't have one*; a differentiator, not parity | idea | Pro-editor credibility | M–L | T3 |
| 7 | **Adaptive-thinking low-cost mode** pattern for Director latency (mirror their v0.6.3 tuning) | idea | Agent latency/cost | S | T3 (post-brain-upgrade) |
| 8 | **Track model-version bumps** (Seedance 2.0/2.5, Kling V3, Veo 3.1) + omni-reference caps in our catalog | reference | Catalog freshness | S | T3 |

`S`=hours, `M`=1–3 days, `L`=1–2 weeks. Tiers: T1 = close or we can't win;
T2 = credibility gap; T3 = nice-to-have.

---

## 4. Per-poach detail

### 1. Route persona references natively through Seedance omni-reference (T1, idea)

**What it is / the delta.** Palmier has **no persistent identity system at all**
(§5) — but the *field* moved: **Seedance 2.0/2.5 — our own provider** — natively
locks face/clothing/logo across shots when handed multiple reference images (2.0:
9 img + 3 video + 3 audio; 2.5 claims up to 50 references; vendor-claimed, not
lab-verified). The field snapshot ranks native multi-reference omni-conditioning
as the **strongest low-friction shot-to-shot consistency mechanism available**,
and it is on the exact model we already pay for.

**Mechanism / our gap.** We already wire `referenceImages`/`referenceVideos`
into the adapter (`apps/web/src/lib/studio/provider-adapter.ts`), and a `Persona`
already carries `refImageUrls`/`anchorImageUrl`/`seed`
(`apps/web/src/stores/persona-store.ts`). The gap is purely routing: the persona
flow today goes through `renderPersonaStill()`
(`apps/web/src/lib/studio/persona-still.ts`) — a gpt-image-2 `/images/edits`
pre-render that composites the persona into the scene, which then becomes the
i2v first-frame — but it does **not** also feed `Persona.refImageUrls` straight
into Seedance's `referenceImages` param. Cheapest high-leverage identity move:
mostly wiring, no new capability.

**Code vs idea / license.** Idea only — the Palmier side has nothing here; the
capability is our provider's. All in our own MIT code.

### 2. Lift the single-`personaId` ceiling (T1, idea)

**What it is.** `GenerationSpec` (`apps/web/src/types/timeline.ts:161-167`)
carries at most **one** `personaId`; `extraCharacters` exist only as text-only
descriptors (the type's own comment flags this as unimplemented beyond the active
persona). Two-character dialogue/interaction shots are a common ask we currently
cannot image-anchor. The field is heading the other way — Kling 3.0 does
multi-character coreference; Seedance omni-reference does multi-subject.

**Mechanism / implementation.** Extend `ConsistencyContext.characters[]`
(`apps/web/src/lib/director/consistency-prompt.ts`) and `GenerationSpec` so each
named character carries an **optional reference image**, not just a descriptor
string; pass all of them into the omni-reference array from #1. This is the most
visible *structural* identity gap on our side.

**Code vs idea.** Idea — implement in our own types/store.

### 3. Reference-sheet generation mode (T2, code — ours)

Add a "reference sheet" mode to `renderPersonaStill` that asks gpt-image-2 for
front/side/profile in one pass, auto-populating `Persona.refImageUrls` instead of
making the user manually source 2–3 matched-angle photos. Small addition to code
we already own; fixes the weakest part of persona-creation UX. (This is the
concrete cheap slice of the Sprint-4 "personas → Soul-ID-grade" item, and it
enables the currently-disabled photo-upload anchor at
`persona-manager.tsx:229`.)

### 4. Color scopes / measurement engine (T2, idea)

**What it is / why now.** Our `useAutoColorCorrection`
(`apps/web/src/hooks/use-auto-color-correction.ts`) is a **fake feature** —
re-confirmed by source-read this pass: it never samples a pixel, it slaps a
static profile bundle onto every clip. Their `inspect_color` runs a real
measurement engine (`ColorScopes.measure()`: percentile black/white points,
clip %, luma + hue histograms, per-zone RGB, warm/cool + green/magenta bias).

**Mechanism.** A pure Canvas2D/JS port (no WebGL needed): downsample to a small
canvas, `getImageData`, compute percentile black/white, per-zone RGB, hue
histogram. This is the **single highest-leverage color item** because it (a)
makes our fake auto-correct real and (b) is the prerequisite for ever giving the
agent a color verb. Their `ColorScopes.swift` is GPL + Apple-specific → we read
it to understand, port nothing.

### 5. `.cube` LUT ingestion via permissive libraries (T2, **CODE**)

**The one genuinely-new copyable resource this pass.** Palmier's LUT pipeline
(`LUTLoader.swift` + `LUTTetraKernel.swift`, tetrahedral interpolation) is GPL +
Metal — untouchable. But we don't need it: clean permissive prior art exists and
is maintained —

- **three.js addons** `LUTPass` / `LUTCubeLoader` (**MIT**) — `.cube` parse + LUT
  apply pass.
- **pmndrs/postprocessing** `LUT3DEffect` / `LUTCubeLoader` (MIT-family) — its
  tetrahedral interpolation is explicitly attributed to **OpenColorIO
  (BSD-3-Clause)**, with a trilinear fallback from a separate MIT implementation.

Either gives `.cube` ingestion + GPU interpolation on our WebGL pipeline with a
fully clean license chain, no Palmier GPL contact. This upgrades the Sprint-3
"color grading panel" item from "build from scratch" to "adapt permissive code."

### 6. Vectorscope / waveform UI panel (T3, differentiator)

Repo-wide search of Palmier confirms they have **no dedicated vectorscope /
waveform monitor** — only a curves-tab RGB parade + luma histogram. So building a
real scopes panel over the engine from #4 would be a **differentiator, not
parity**. Lower priority than the agent-facing measurement engine, but note it as
a place we can *lead* rather than catch up.

### 7. Adaptive-thinking low-cost mode (T3, idea)

v0.6.3 tuned Sonnet 5 to "low" adaptive-thinking to cut agent latency/cost. Once
our Director brain upgrade lands (existing Sprint-1 item), mirror the pattern:
default to a low-reasoning/low-latency config for routine timeline edits, escalate
only for planning-heavy asks. Cheap once the frontier brain is wired.

### 8. Model-version tracking (T3, reference)

Their **website** advertises Seedance 2.0, Kling V3, Veo 3.1, Grok Imaginex,
Nano Banana Pro (the README still lists older labels). For us this is a
catalog-freshness note: capture the current Seedance version + its omni-reference
caps in `lib/studio/model-capabilities.ts` so #1/#2 use accurate reference limits.

---

## 5. Their weakness = our wedge (hardened this pass)

Two wedges moved from "suspected" to **confirmed**, and the platform/pricing
wedges are re-verified sharper:

1. **No character identity system — at all.** Confirmed at the docs/README/FAQ
   level (zero hits for character/persona/cast/identity): every Palmier
   "consistency" claim resolves to *pass a reference image as a token into one
   generate call*. There is no persistent character entity, no seed-lock exposed
   to users, no reuse across generations. **We have all of that** (persona store,
   seed-lock, descriptor anchoring, reel-wide consistency context as an agent
   verb). Headline: *"Byorn has reusable, seed-locked characters that persist
   across every shot. Palmier makes you re-upload a reference image every single
   generation."*

2. **No vectorscope/waveform scopes UI.** They shipped a full colorist engine but
   only a curves-tab histogram for humans. Our color story can *lead* here, not
   merely catch up.

3. **macOS/Apple-Silicon lock is permanent and unmoving.** Re-verified: hard
   requirement, no expansion signaled, real user pain (Windows/Intel issues open,
   only a fan fork exists). *"We run in the browser on every OS; Palmier excludes
   Windows, Linux, Intel Macs, and mobile on day one."*

4. **Opaque credit economics + full vendor lock-in.** No BYO-API-key; 5k credits
   = a vague "3–7 min"; launch pricing is a time-limited 40% discount off $49/$99;
   HN complaint of "~6 sec/day for $30–50/mo." *"Transparent per-reel pricing,
   local-free captions/search, no silent model-driven credit devaluation."*

5. **Metadata amnesia on export.** Their NLE-XML export drops generation
   provenance (CrePal review). Our provenance-sidecar survives export — the
   regenerate-in-place loop only works if provenance is retained, and only we
   retain it.

---

## 6. What we already beat them on / deliberately ignore

**Already beat (unchanged, re-confirmed):** cross-platform web; 22 hand-authored
WebGL transitions (they have none — generic `CIDissolveTransition` only);
generation-first slot/take spine with regenerate-in-place; cloud + auth +
persistence + git-style version control; persistent seed-locked personas;
local-first free CLIP search + Whisper captions.

**Deliberately ignore (their rabbit holes):** native Metal DSP raw-perf race
(permanent loss, ship good-enough); model breadth (keep our curated single-
provider cost bet, one frontier escape-hatch); their audio DSP internals
(`denoise_audio` is an Apple-specific model — a server-side job for us if ever,
not a Director design problem); NLE interchange fidelity beyond a basic
provenance-carrying export; masking/power-windows (roughly even — neither side
has shape masks).

---

## 7. Extra deliverable — the already/newly/still ledger

So we never re-mine the same vein. Three columns: **already-poached** (documented,
do not re-report), **newly-available** (surfaced or changed this pass),
**still-a-gap** (known, unbuilt — the standing backlog).

| # | Already-poached (don't re-mine) | Newly-available (this pass) | Still-a-gap (unbuilt backlog) |
|---|---|---|---|
| 1 | Full 45-tool MCP surface catalog (`palmier-mcp-schema-spec.md`) | **44→45 tool-count correction** (applied to spec) | Ship our own MCP server + one-click installers |
| 2 | Mutation-delta algorithm (spec §Cross-cutting) | — (mechanism unchanged since baseline) | Build mutation-delta returns on mutating verbs (P0) |
| 3 | Short-id prefix-shortening algorithm | — | Build `lib/director/short-id.ts` (P0) |
| 4 | Agent-scoped undo mechanism | — | Build origin-tagged agent undo (P1) |
| 5 | sixsevenstudio MIT code (fully mined; one port done) | **Confirmed exhausted** (8-mo stale, no new commits) | — |
| 6 | palmier-skills Apache prompts (4 skills ported) | **Confirmed exhausted** (single merge, all captured) | — |
| 7 | Colorist engine exists (wheels/curves/LUT/hue-curve/scopes) | **They lack a vectorscope/waveform UI** (differentiator); permissive WebGL LUT libs identified (three.js/pmndrs, CODE) | Color scopes engine (fixes fake auto-correct); LUT/wheels/curves panel |
| 8 | Reference-image conditioning for consistency | **They have NO persistent persona/identity entity** (confirmed wedge); Seedance omni-reference (9/3/3, 50 on 2.5) is our provider | Route persona→omni-reference; multi-character ceiling; reference-sheet mode |
| 9 | Model catalog shape (`model-capabilities.ts`) | Website model bumps: Seedance 2.0/2.5, Kling V3, Veo 3.1, Grok Imaginex | Server-driven live catalog + omni-reference caps |
| 10 | Agent brain = Claude Sonnet 5 (theirs) | **Sonnet 5 adaptive-thinking low-cost mode** (v0.6.3) | Upgrade our Director off local Ollama to a frontier brain |
| 11 | Beat/silence/sync/multi-timeline all shipped (landscape doc) | — (all pre-baseline; MCP-drift confirms no post-baseline tool change) | Wire our own audio pipeline (Whisper/pyannote/XTTS) into edit ops |
| 12 | `palmy` repo (Slack→Claude runner) | **License correction: NO license, not MIT** — code not copyable (applied to memory) | — |

**Reading the ledger:** column 2 is short and mostly *corrections + confirmations*
— which is the honest headline of this refresh. The action that matters most sits
in row 8 (identity, our build #1) and rows 7/8's newly-available specifics; the
rest of the "still-a-gap" column is the pre-existing roadmap, unchanged.

---

## 8. Freshness note — sources, dates, model tier per section

All axes verified **2026-07-09** against primary sources. Model tier noted so
low-confidence (Haiku-sourced) claims are flagged for re-verification.

- **§Release delta [Haiku, ~90% conf]:** GitHub releases/tags API; latest v0.6.3
  (2026-07-08), no releases since. *Re-check:* website model-version labels
  (Seedance 2.0 / Kling V3) vs. repo catalog — website may be ahead of README.
- **§Repos + license [Sonnet, high conf]:** `gh api orgs/palmier-io/repos` (7
  repos, no new), fresh shallow clones of sixseven/skills (both stale/exhausted),
  npm registry checked (no `@palmier` scope). `palmy` = no license (verified).
- **§MCP schema drift [Opus, high conf]:** direct read of `ToolDefinitions.swift`
  HEAD `cd74ce3` (45 tools) + full commit history for `Tools/`. Zero tool-surface
  drift; #263 rework (07-06) and beats/speech/sync/multi-timeline all pre-baseline.
  *Re-check:* after their next `feat(...)` / `[agent]` commit, not before.
- **§Color/compositing [Sonnet, high conf, primary-source]:** fetched actual
  `Compositing/` files (PR #8 merged 2026-06-23, shipped through v0.6.3). Confirmed
  no vectorscope/waveform UI (repo-wide grep). Permissive LUT libs: three.js
  `LUTPass` (MIT), pmndrs `LUT3DEffect` (OpenColorIO BSD). *Re-check:* whether the
  in-app Adjust UI is free-tier or paid-gated.
- **§Identity/consistency [Sonnet, high conf on Palmier + our code; vendor-claimed
  field numbers]:** Palmier docs/README/FAQ (no persona entity). Field snapshot
  (Higgsfield Soul ID, Runway Gen-4.5, Kling 3.0, Seedance 2.0/2.5 ref counts) =
  vendor marketing, not benchmarked — treat "20+ photos / 9-3-3 / 50 refs" as
  claimed. Our system grounded in source, not runtime-verified.
- **§Traction [Haiku, high conf on numbers, medium on sentiment]:** GitHub API
  (10.2k★, 761 forks), palmier.io/pricing (live), YC/Crunchbase ($500K, 2 people),
  CrePal/OutlierKit/HN for complaints (small sample; no Reddit megathread — too
  new). *Re-check:* any Series A; any Windows/web announcement.

**Corrections applied this session:** (1) `palmier-mcp-schema-spec.md` tool count
44→45; (2) memory `palmier_competitive_analysis.md` — `palmy` license MIT→none.

**Bottom line:** re-run this delta pass only after Palmier's next `feat`/`[agent]`
commit or a pricing/platform announcement — the tool surface has been stable ~3
days and the permissive-code vein is dry. The live work is on our side of the
ledger, not theirs: build #1 (identity → omni-reference routing) is the one item
here that both matters and is newly-specified.

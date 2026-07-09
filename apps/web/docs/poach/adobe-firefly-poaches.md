# Adobe Firefly + Premiere Pro — Poach Doc

_Multi-agent competitive sweep. Last verified: 2026-07-09. Model tiers noted per section so Haiku-sourced claims can be re-verified._

---

## 1. Header

- **Competitor:** Adobe — Firefly (web gen platform) + Premiere Pro (desktop NLE), tightly coupled via Firefly generative credits and a new Boards→Premiere bridge.
- **One-line product:** The industry-standard pro NLE with an AI generation layer that has pivoted into a **curated marketplace of 30+ third-party gen models** plus Adobe's own "commercially safe" Firefly models.
- **License / stack / platform:** Closed-source, proprietary. Premiere = heavy desktop install, **Win/Mac only** (no Linux, no Chromebook, no web-native editing). Firefly = browser + mobile. → **Everything here is IDEA-poach only. Zero copyable code.**
- **Pricing (verified 2026):** Firefly Standard $9.99/mo (2,000 credits), Pro $19.99 (4,000), Premium $199.99 (50,000); Premiere Pro single-app $22.99 (25–250 credits); Creative Cloud Pro (ex-"All Apps") ~$69.99 after the Aug 2025 hike (1,000–4,000 credits). Credits **do not roll over**.
- **Last-verified:** 2026-07-09.

---

## 2. Threat read (validated against evidence)

**Original read:** _"Firefly generates B-roll on the Premiere timeline and aggregates ~12 third-party models; unmatched distribution. But slow, ~$55/mo, enterprise-heavy. The pincer is distribution + model-aggregation, not agility."_

**Revised after evidence — three corrections:**

1. **B-roll is NOT generated on the Premiere timeline.** Adobe's own blog (2026-04-15) states plainly: _"Premiere itself doesn't include the generative capabilities"_ — text-to-video happens in the **Firefly web app / Boards**, then a **two-click "send to Premiere desktop"** drops a flat rendered asset into a "Firefly Downloads" bin, which the editor manually drags to the timeline. The only genuinely timeline-native gen feature is **Generative Extend** (drag a clip edge, capped at **+2s** video). So the "gen-on-pro-timeline" threat is weaker and clumsier than assumed — this is a wedge, not a moat.

2. **The count is now 30+ models, not ~12** — and critically, **Firefly is a catalog, not a router.** Models sit behind a **manual dropdown** with **no auto-selection, no smart routing, no fallback logic.** Adobe curates the list; the user is the router. "Aggregation" oversells it.

3. **"~$55/mo" has no clean SKU.** Real usable video pipeline is either a **shortfall (~$43/mo:** Premiere + Firefly Pro) or **over-bundled (~$75/mo:** CC Pro + Firefly Pro). The credit economics bite harder than the headline price: a 5-sec 1080p clip = **~500 credits = >25% of the entire Standard monthly pool**, and depletion is now a **hard block** (June 2025 change, replaced the old graceful throttle).

**Net:** The pincer is real on **distribution** (Adobe owns the pro install base) but **soft on both mechanics the prime directive flagged.** Model aggregation has no routing and a legal **indemnity cliff**; gen-on-timeline is a two-app context switch that loses take history at import. Both are extractable ideas whose *weaknesses* are our positioning.

---

## 3. Priority table

| # | Poach | code\|idea | Relevance | Effort | Tier/Prio |
|---|-------|-----------|-----------|--------|-----------|
| 1 | **Pluggable model backends under the unified generator — but add the router Adobe lacks** (auto-route by slot intent, seed-lock-aware) | idea | Very high — the prime-directive call | L | **T1** |
| 2 | **Per-take cost preview on the slot** (show est. credits per model before generating; normalize internally, expose multiplier honestly) | idea | High — inverts Adobe's #1 credit complaint | S–M | **T2** |
| 3 | **Commercial-safety tier badge + provenance stamp per take** (indemnified / partner / experimental; filter a slot's takes by tier) | idea | Medium — credibility for pro/brand users | M | **T2** |
| 4 | **Visionboard "Remix"** — multi-select tiles → auto-composed combined prompt → variation grid dropped back on board | idea | High — direct visionboard upgrade | M | **T2** |
| 5 | **Order-preserving board→timeline auto-sequence** — select a run of board assets, auto-build slots in that exact order | idea | Medium — small, well-liked UX win | S | **T2** |
| 6 | **Generative-Extend-as-a-slot** — drag a clip edge to spawn an "extend" slot; beat their +2s cap | idea | Medium | M | **T3** |
| 7 | **Background / non-blocking generation** — keep editing while a take renders (match their one genuine strength) | idea | High — table stakes we must match | M | **T2** |
| 8 | **Side-by-side multi-model take comparison** — one prompt, N models, compare in the take stack (their real advantage) | idea | High — pairs with #1 | M | **T2** |
| 9 | **First/last-frame anchors for video takes** (Firefly Video lets you pin start+end frames) | idea | Medium | S | **T3** |
| 10 | **Real-time multiplayer + comments on visionboard** (Boards shipped this Sept 2025; we likely lack it) | idea | Medium — roadmap gap, not a wedge | L | **T3** |

---

## 4. Per-poach detail

### #1 — Pluggable model backends + a real router (the prime-directive poach)
- **What Adobe does:** 30+ partner models (see model list in §7) behind a **manual Model dropdown** across Text-to-Image, Text-to-Video, Boards, Photoshop. Curated for "quality, control, reliability" but **no runtime routing, no fallback, no auto-select** — the user picks per generation. Integration is **hosted API partnerships** (Firefly calls each vendor's live API; new versions appear within days), governed by a **contractual no-train clause** (partners agree not to train on creator data) + one subscription + Content-Credential signing per output.
- **Mechanism to copy:** the *pluggable-backend* pattern (single front door, many interchangeable model APIs, provenance-signed outputs, contractual no-train). **The upgrade Adobe hasn't built:** route by **slot intent** — a character-shot slot → a seed-lock-capable backend; text-in-image → FLUX.2-class; physics-heavy video → Gen-4.5-class — with quality/latency fallback.
- **code vs idea:** **IDEA.** Adobe closed. Our own backend-adapter layer already fits this (the unified generator is the front door; make models adapters behind it).
- **On our stack:** extend the single generator into a `GenerationBackend` interface; a `routeSlot(slotIntent, personaLock) → backend` selector; keep seed-lock as a cross-backend normalizer so switching models doesn't break identity (the thing Adobe structurally cannot do). See the **build-vs-skip call in §8**.

### #2 — Per-take cost preview on the slot
- **What Adobe does (badly):** one opaque credit pool; **no published per-model credit table**; true cost shown only in the in-app dialog at request time; cost asymmetry between cheap/expensive models papered over with **time-boxed "unlimited" promos** (Nano Banana Pro launch promo to Dec 15 2025; a broader "Generate without limits" to Mar 16 2026). Users **cannot budget**, and credits burn **even on discarded results**.
- **Mechanism to copy — inverted:** show an **estimated credit/$ cost per model on the slot before you hit generate**, and per take after. Normalize everything to one Byorn credit internally; expose the per-model multiplier honestly.
- **code vs idea:** IDEA (it's a UX/product decision, our own code).
- **On our stack:** a small cost-estimate badge on the slot's model picker + a running "spend on this slot" tally in the take stack.

### #3 — Commercial-safety tier badge + per-take provenance
- **What Adobe does:** **Tier 1** Firefly-native models = full IP indemnity (trained on Adobe Stock/licensed/public-domain). **Tier 2** partner models = **excluded from Firefly indemnity**, shunted to a separate, weaker, **enterprise-gated** "Creative Partner Model Supplemental Coverage." **Outside the list** = partner's own terms, no Adobe coverage. Content Credentials sign each asset with the model used, making the tier auditable — **but the indemnity itself is unavailable to solo/individual plans.**
- **Mechanism to copy:** attach a **safety tier to the take primitive** (indemnified-equivalent / partner / experimental), render it as a **badge on each take**, and let users **filter a slot's takes by tier** — surfacing in the UI what Adobe buries in legal PDFs. Stamp provenance (model, prompt, seed, references) per take and carry it through export (this is already one of our wedges — generation-provenance that survives export).
- **code vs idea:** IDEA.

### #4 — Visionboard "Remix"
- **What Adobe does:** on Firefly Boards (shipped 2025-09-24), select multiple canvas images → **Remix** → the system **auto-composes a combined prompt from the selection** and generates a fresh variation grid back onto the canvas, each tagged with the model used. It's "generate more takes" but on arbitrary board selections instead of a fixed slot.
- **Mechanism to copy:** let users multi-select visionboard tiles/references and hit one **Remix** action that auto-builds a merged prompt and drops a variation grid back on the board — no per-tile generation panel.
- **code vs idea:** IDEA.
- **On our stack:** visionboard multi-select → prompt-merge → batch generate → grid insert. Feeds naturally into slot/take.

### #5 — Order-preserving board→timeline auto-sequence
- **What Adobe does:** the 2026-04-15 Boards→Premiere bridge sends selected assets with **two clicks**, and **Premiere auto-builds a sequence preserving the exact clip order you selected on the board** (CineD NAB 2026). Small, but users like it.
- **Mechanism to copy verbatim:** when a user selects/drags a run of visionboard assets into the timeline, **auto-create placeholder slots in the exact selection order.**
- **code vs idea:** IDEA. Low effort, high polish-per-hour.

### #6 — Generative-Extend-as-a-slot
- **What Adobe does:** the **only** timeline-native gen feature — a toolbar tool, **drag a clip's edge past its boundary** to synthesize up to **+2s video / +10s audio** (GA in Premiere 25.2, Apr 2025; up to 4K). Right-click → Regenerate/Good-Bad/Revert. Non-blocking. Quality breaks down on fast motion ("vehicles get jumbled"); no dialogue/music extension.
- **Why copy:** the **drag-the-edge gesture** is genuinely elegant and more discoverable than an abstract slot for the "shot is a beat too short" case. And their **+2s cap is a soft target** — any longer one-shot extension is a quantitative claim.
- **Mechanism:** treat an edge-drag on a finalized clip as spawning an **"extend" slot** that generates into the gap and keeps takes. Unifies their two disjoint mental models (extend vs generate) into our one.
- **code vs idea:** IDEA.

### #7 — Background / non-blocking generation
- **What Adobe does:** Generative Extend renders in the background; the editor keeps cutting. This is Adobe's one genuinely good gen-UX property and **we must match it** — generation should never freeze the timeline.
- **code vs idea:** IDEA (engineering pattern). Async take generation with the slot showing a live progress state.

### #8 — Side-by-side multi-model take comparison
- **What Adobe does:** in Firefly, you generate one prompt across Veo 3.1 / Kling 3.0 / Runway Gen-4.5 / Luma Ray3 and **compare results side-by-side before importing.** This is a **real advantage** our "one unified generator" doesn't currently offer.
- **Mechanism to copy:** let one slot fan a single prompt across N backends and land the results as **parallel takes** in the stack, compared in place. Pairs directly with #1 (once backends are pluggable, N-way compare is nearly free) and is strictly better than Adobe's because our takes **stay versioned on the timeline** instead of collapsing to one flat clip at import.
- **code vs idea:** IDEA.

### #9 — First/last-frame anchors for video takes
- **What Adobe does:** Firefly Video lets you pin a **First frame** and **Last frame** image the generated clip must hit.
- **Mechanism to copy:** expose start/end-frame anchors on a video slot; combine with seed-lock persona as the identity anchor. Cheap, high-control.
- **code vs idea:** IDEA.

### #10 — Real-time multiplayer visionboard
- **What Adobe does:** Boards has shipped **real-time multiplayer + comments + permissions** since Sept 2025 (design-sprint / client-review positioning). We likely lack this.
- **Read:** a **roadmap gap, not a wedge** — Adobe has battle-tested it. Note it; don't lead with it.
- **code vs idea:** IDEA (large — CRDT/presence layer).

---

## 5. Their weakness = our wedge (headline claims we could make)

1. **"Character consistency Firefly still can't do."** Adobe's **single loudest unmet user request** — a multi-page community thread begging for a "Style Freeze"; same prompt + same reference still yields a different face every render. Never shipped. **Our seed-lock persona is the direct answer.** This is the #1 wedge and it aligns exactly with our Build #1 priority.
2. **"No queue, no spinner — it runs on your machine."** Firefly is cloud-round-trip by design; 2026 users report generation "stuck at loading screen" 20+ min. Our local CLIP search + local Whisper captions are instant.
3. **"Cancel by closing the tab."** Adobe paid a **$150M DOJ/FTC settlement (March 2026)** for dark-pattern cancellation + hid early-termination fees; then hiked CC to ~$69.99 (Aug 2025). We're web-native, no subscription lock, no ETF.
4. **"Runs in any browser tab — Chromebook, Linux, whatever."** Premiere literally can't run on ChromeOS/Linux and its RAM/GPU floor is *rising* release over release. Web-native is a moat Adobe can't neutralize overnight.
5. **"AI-native, not AI bolted onto a 20-year NLE."** Adobe's own forum, May 2025–Feb 2026: _"bloated with half-baked AI features nobody asked for," "broken AI garbage that slows down the whole system."_
6. **"Pick a partner model in Firefly and you lose Adobe's indemnity."** The indemnity cliff undercuts the whole "commercially safe" brand the moment a user picks Runway/Veo/OpenAI — and it's enterprise-gated anyway. Our per-take safety badge makes the tradeoff visible instead of hidden.
7. **"Costs you can actually see."** No per-model credit table, promo-masked pricing, credits that burn on discarded results and don't roll over, hard-block on depletion. Our per-take cost preview inverts all of it.
8. **"Provenance that survives export."** Adobe's forced Content Credentials (mandatory early 2026, can't disable — users call it a watermark) **break on the first re-encode / YouTube upload.** Ours is designed to survive export.

---

## 6. What we already beat them on / deliberately ignore

- **Already beat / structurally ahead:** cross-platform web (no install/login), seed-lock character consistency (their biggest hole), local-first search + captions, generation-provenance that survives export, a **true unified generative-slot + versioned-takes timeline** — Premiere has **no slot concept at all** and loses take history at import.
- **Deliberately ignore (Adobe moats we can't and shouldn't chase):** the Creative Cloud install-base distribution, enterprise indemnification apparatus, Adobe Stock training corpus, the C2PA/Content-Authenticity industry consortium. Extract the two mechanics (routed backends, gen-in-timeline UX) and their weaknesses; leave the moat.

---

## 7. Freshness note (sources + dates, by model tier)

- **Model aggregation [Opus]:** model list dated from Adobe MAX news (2025-10-28), Nano Banana Pro blog (2025-11-20), Firefly mobile launch (2025-06-17). Manual-dropdown UI + indemnity exclusion ("Creative Partner Model Supplemental Coverage") from Adobe Enterprise Legal FAQs + helpx legal product-description. **Per-model credit multipliers are deliberately unpublished by Adobe — unverified.** Integration-as-hosted-API is *inferred* from day-of version parity + no-train clause. Re-check: partner list churns monthly.
- **Premiere workflow [Sonnet]:** Generative Extend beta (Adobe blog 2024-10-14), GA 25.2 (DPReview, Apr 2025); "text-to-video not in Premiere" (Adobe blog 2026-04-15); v25.6 notes (2026-01-16); CineD NAB 2026. **Flagged unverified:** SEO-site claims of a native "Window > Generative AI" panel — contradicted by Adobe's own blog; do not treat as real. Exact current Generative-Extend credit rate not pulled (helpx timeouts).
- **Boards [Sonnet]:** global launch (Adobe blog 2025-09-24); Remix + reference mechanics (Adobe help); board→Premiere bridge (Adobe blog 2026-04-15 + CineD). "Style Freeze"/character-lock gap from a live multi-page Adobe community thread (not independently date-capped). No hands-on walkthrough performed — verify before external-facing claims.
- **Pricing [Haiku — re-verify]:** **Adobe's official pricing pages timed out; all numbers are from secondary aggregators (SudoMock, ToolColumn, SaaSCRM, DigitaLicence) dated 2025-06+, cross-checked.** Standalone Firefly plan prices are high-consistency across 6+ sources; **enterprise minimums (~$1,000/mo) and per-image API rates ($0.02–0.10) are unverified estimates.** Hard-block-on-depletion + credit tracking confirmed via PetaPixel (2025-06-24).
- **Weaknesses [Sonnet]:** $150M DOJ settlement (CineD + Yahoo Finance, March 2026); CC price hike/rebrand (AppleInsider 2025-05-20); forced Content Credentials (aimetadatacleaner 2026 + Adobe Community) — provenance-breaks-on-reencode cites RAND June 2025 (recommend a direct RAND pull if used prominently). Bloat quotes are first-party dated Adobe Community (2025-05 → 2026-02). **Weakest-sourced:** "enterprise focus neglects solo creators" — inferred from strategy docs, no first-person solo quote found.

**Re-check cadence:** partner-model list + pricing every ~30 days (both churn fast); the Premiere "no in-timeline gen" claim at each major Premiere point release (they may close this gap).

---

## 8. Extra deliverable — Build-vs-skip: should Byorn become a multi-model router?

**Recommendation: BUILD, but as a routed backend layer *behind* the unified generator — not as a Firefly-style exposed model marketplace. Ship it in two phases, and treat seed-lock as the thing that makes our router categorically better than Adobe's.**

**Why build:**
- The market has spoken — Adobe (and everyone) converged on many-models. No single model wins across character shots, text-in-image, physics video, upscale, audio. A single hardwired generator caps our quality ceiling at whatever one model can do.
- **We can build the thing Adobe conspicuously didn't:** an actual *router* (auto-select + fallback by slot intent), not a manual dropdown. Their weakness (user-as-router, decision fatigue across Gemini 2.5/3/3.1, FLUX 1.1/2, Gen-4/4.5) is directly ours to take.
- Pairs for near-free with poach #8 (N-way take comparison) once backends are pluggable.

**Why the single-generator + seed-lock bet is not threatened — it's the moat:**
- Adobe's fatal aggregation flaw is **zero cross-model consistency**: switch models and your character changes. If we make **seed-lock a cross-backend normalizer** — persona identity preserved *regardless of which backend renders the take* — we get the breadth of aggregation **without** the consistency tax that makes Adobe's version a downgrade for any character-driven work. The "one unified generator" stays as the **front door**; models become interchangeable adapters behind it. Users never see a marketplace; they see one generator that always keeps their character.

**Costs / risks to weigh:**
- Credit-normalization + per-model cost accounting is real work (poach #2) — but it's also a differentiating UX, not just overhead.
- Provider sprawl = maintenance tax (APIs churn weekly; Adobe absorbs this with a team). Mitigate with a thin adapter interface and a small curated set (2–4 backends) at launch, not 30.
- Legal/safety tiering (poach #3) has to be honest per-take, or we inherit Adobe's indemnity-cliff confusion.

**Phasing:**
- **Phase 1 (M):** `GenerationBackend` adapter interface; 2–3 curated backends behind the existing generator; seed-lock normalization across them; per-take provenance + cost badge. No user-facing model picker yet — auto-route only.
- **Phase 2 (L):** optional manual override + N-way side-by-side takes (#8); safety-tier filter (#3); intent-based routing rules tuned by slot type.

**Skip:** a Firefly-style front-and-center "pick your model" marketplace. It offloads the routing burden onto the user — the exact weakness we're counter-positioning against. Our pitch is _"one generator that always keeps your character,"_ not _"30 models, you figure it out."_

# Higgsfield "Soul ID" — poach doc (identity consistency, Byorn build #1)

> Research fan-out: 6 parallel sub-agents (2× Opus mechanism/portability, 2× Haiku
> presets/pricing, 2× Sonnet editor-gap/landscape) + Opus synthesis, **2026-07-09**.
> Model tier is noted per section so low-confidence (Haiku/marketing-sourced) claims
> can be re-verified. Supersedes the Soul-ID portions of the older
> `higgsfield-gap-analysis` memory (which assumed 3–5-photo reference-conditioning;
> that is **wrong** — see §4.1).

---

## 1. Header

- **Competitor:** Higgsfield AI (higgsfield.ai). Founded by Alex Mashrabov (ex-Snap AI).
- **One-line:** A generation-first AI "film studio" — text/image→video across 30+ aggregated models, with **Soul ID** (per-user trained character identity) as the moat.
- **License / stack / platform:** Closed SaaS. Web + iOS + Android (no desktop). Account required. Soul artifacts are **not exportable** — locked to the Higgsfield ecosystem.
- **Pricing (Haiku-tier, verify):** Free (50 cr, 720p, watermark) → Basic $15–29 → Plus/Creator $39–49 (1,000 cr, 1080p, commercial) → Ultra/Studio $99–129 (3,000 cr) → Team ~$62–85/seat. Credits **expire after 90 days**. Soul train ≈ **25–40 credits** (~$1.25–2), one-time.
- **Last verified:** 2026-07-09.

## 2. Threat read (validated)

Restated bet going in: *Soul ID is the gold standard for our exact build #1 — train on 20+ photos → a portable identity consistent across every model — and their gap is "no timeline/editor," making them the bar our personas must clear and a possible integration/positioning target.*

**Confirmed, with one important correction and one narrowing:**

- **Correction (raises the bar):** Soul ID is **not** the 3–5-photo reference-conditioning we assumed in the prior gap doc. It is a **per-user *trained* identity artifact** — **20+ photos (20–80 accepted, ≥960px), ~3–5 min cloud train, ~25–40 credits**, "train once, generate unlimited." Their own copy: *"more control than a prompt, less overhead than a LoRA"* and *"an internalized model of the face itself, not a lookup reference to a single image."* Best mechanism inference: a **per-subject LoRA/DreamBooth-class low-rank fine-tune** of their native Soul 2.0 image model. Confidence it's *trained* (not a zero-shot adapter): **High**. Confidence it's specifically *LoRA*: **Medium** (economics — minutes/~$1/"unlimited stored identities" — fit lightweight adapters, not full fine-tunes).

- **Narrowing (shrinks the gap — this is the key finding):** Their "one identity across **every model**" story is **orchestration, not per-model identity weights** (confidence **High**; stated in their own docs: *"push any generated frame into a video model such as Kling 3.0, Seedance 2.0 or WAN"*). The trained weight exists **only** inside the native Soul 2.0 **image** model. For video, they generate a canonical Soul still, then feed it as an **image-reference / start-frame** into each video model's *own* i2v feature. **That is architecturally identical to our seed-lock bet** (gpt-image-2 canonical still → Seedance image-to-video). So we **already match their cross-model story**; the only place we're behind is the **fidelity of the native still generator** — trained (them) vs reference-conditioned (us).

- **Editor gap: confirmed, by their own words.** Their "AI Video Editor" page literally says *"Type to edit, **no timeline**."* No multi-track NLE, no cross-clip audio sync (lip-sync tops out at 5–10s **per clip**). Their answer to assembly is **plugins into DaVinci/Premiere/After Effects** — i.e. they concede the timeline to incumbents rather than build one. This is exactly our structural wedge.

Net: Higgsfield is **less a feature-competitor and more the fidelity bar for one component** (the native identity still), sitting on a generation stack with **no editor** and **no programmatic Soul training**. Our counter-position (identity engine + real timeline, with an *exportable* persona and a *trainable* API) is intact and sharper than before.

## 3. Priority table

| # | Poach | code\|idea | Relevance | Effort | Tier/Prio |
|---|-------|-----------|-----------|--------|-----------|
| 1 | **Two-tier persona: keep zero-train ref-conditioning, add a *trained-look* durable tier** (the Soul ID bar) | idea | Highest — build #1 | L | **T1** |
| 2 | **PhotoMaker v1 as the clean, MIT-shippable durable tier** (Apache-2.0, CLIP-only, no InsightFace/FLUX encumbrance) | **code** | Highest | M–L | **T1** |
| 3 | **Multi-photo anchor intake** (accept 20–80 photos like Soul ID, quality/recency gating) — unblocks #1/#2 | idea | High | M | **T1** |
| 4 | **"Consistency fork" UX** — expose Fast (ref) vs Durable (trained-look) like their "more than a prompt, less than a LoRA" | idea | High | S | **T1** |
| 5 | **Camera-move preset library** (~65 named moves) as prompt fragments woven into the generator | idea | High | S–M | **T2** |
| 6 | **VFX / one-click effect presets** (~48 named) as stackable prompt/effect presets | idea | Med | M | **T2** |
| 7 | **Soul Cast — build-a-synthetic-actor from parameters** (genre/era/archetype/physique/outfit) → a persona with no photos | idea | High | M | **T2** |
| 8 | **Persona *export*** (download the artifact) — counter their locked ecosystem | idea | Med (positioning) | S–M | **T2** |
| 9 | **Persona-training *API*** (they have none) — dev-experience wedge, feeds our MCP surface | idea | Med | M | T3 |
| 10 | **Style/film-look presets** (~77 named looks/genres) as grade+prompt presets | idea | Med | M | T3 |

`S`=hours · `M`=1–3 days · `L`=1–2 weeks. `T1`=close/can't-win · `T2`=credibility gap · `T3`=nice-to-have.

## 4. Per-poach detail

### 4.1 Two-tier persona — keep ref-conditioning, add a trained-look durable tier (idea, T1)

**What it is.** Soul ID leans *trained*: a per-user artifact that locks likeness durably across pose/style/lighting because identity lives in weights, not in a per-gen reference. Reference-conditioned methods (our current gpt-image-2 path, plus Runway Gen-4 refs, Veo Ingredients, Ideogram Character) cost nothing per identity and generalize instantly, but likeness is **looser and drifts under heavy stylization/extreme pose**. Soul ID's fidelity edge is the training step.

**Exact mechanism (their side).** 20–80 photos ≥960px, recent ("past 4–5 months," stale photos "pull toward the old you"), avoid sunglasses/masks/extreme expressions → ~3–5 min cloud train → stored server-side adapter auto-loaded at gen time on Soul 2.0. Never passed a reference image per generation. Self-assessed quality: *"clearly the same person," not "pixel-identical"*; admitted drift on unusual angles / extreme style transfer / stale inputs. Independent failure-mode testing (profiles, hands, multi-person, ethnicity bias) is **UNVERIFIED** — a gap worth our own bench.

**Code vs idea / license.** **Idea.** Higgsfield is closed; Soul weights are non-exportable. Reimplement in our own stack.

**How to implement on Byorn.**
- **Keep** the current reference-conditioned tier (`lib/studio/persona-still.ts`, gpt-image-2 `/images/edits`, seed-lock) as the **Fast / zero-train** default — it already matches the Runway/Veo/Ideogram tier *and* the video-orchestration story (§4 note below).
- **Add** a **Durable** tier that clears the Soul ID bar. Two candidate engines: (a) a cloud **per-persona LoRA fine-tune** (mirrors Soul ID exactly, but adds GPU/vendor infra + per-identity cost + the "LoRA breaks on next base model" fragility); (b) **PhotoMaker v1** self-hosted (see 4.2) — a multi-photo "stacked ID embedding" that is *trained-ish* (much tighter than single-ref) **without** per-identity training. Recommend **(b) first** — cheaper, license-clean, runs on our existing Python backend — with (a) as a later power-user option.
- **Cross-model injection stays as-is.** Both tiers produce a canonical still that seeds Seedance image-to-video. This *is* Higgsfield's cross-model mechanism; no per-video-model identity weight is needed to match them.

### 4.2 PhotoMaker v1 as the clean durable tier (CODE, T1)

**What it is.** [TencentARC/PhotoMaker](https://github.com/TencentARC/PhotoMaker) — stacks multiple ID reference photos into a single "stacked ID embedding" for SDXL, giving durable multi-photo likeness in one forward pass (no per-identity training).

**Why this one specifically (license).** The whole open identity field is double-gated: most high-fidelity methods (**InstantID, PuLID/PuLID-FLUX, PhotoMaker v2, UNO/USO**) get their fidelity from **InsightFace** face-embeddings (weights *non-commercial-research-only*) and/or ride **FLUX.1-dev** (*non-commercial*). **PhotoMaker v1 is the one mainstream technique that sidesteps both** — its ID encoder is pure **OpenCLIP-ViT-H-14**, code is **Apache-2.0**, base is SDXL. That makes it **cleanly bundleable/resellable under our MIT distribution**. Pair with **plain IP-Adapter** (non-FaceID, Apache-2.0) for style/composition transfer where full face-lock isn't needed.

**How to implement.** Runs on our Python backend (localhost:8420, already hosts Whisper/diarization/gen orchestration). Add a `photomaker` service: intake N anchor photos → stacked embedding → SDXL gen of the canonical persona still → rehost to R2 → same seed-lock + Seedance i2v path as today. Expose as the **Durable** engine behind the consistency fork (4.4). Keep InstantID/PuLID/PhotoMaker-v2 strictly as **bring-your-own-license** power-user options, never defaults.

### 4.3 Multi-photo anchor intake (idea, T1)

**What it is.** Soul ID's fidelity comes largely from **volume + quality of anchors** (20–80 recent, ≥960px, varied angle/expression). Our current persona anchors are generated/single. To reach their bar, accept many real photos.

**How to implement.** Finish the scaffolded-but-disabled photo-upload anchor path (`persona-manager.tsx`); add client-side quality/recency gating mirroring their rules (min count, min resolution, reject sunglasses/masks via a cheap face-quality check). Store as `personas.refImageUrls[]` (already in schema). This is the direct feeder for both 4.1 tiers.

### 4.4 Consistency fork UX (idea, T1)

**What it is.** Higgsfield frames Soul ID as *"more control than a prompt, less overhead than a LoRA."* That's a **quality/latency fork** we should expose explicitly.

**How to implement.** We already have `consistencyMode` in `studio-settings-store` (High=per-shot edit / Fast=anchor-direct). Extend to three: **Fast** (anchor-direct ref), **Balanced** (per-shot gpt-image-2 edit — today's "High"), **Durable** (PhotoMaker trained-look). Surface latency/likeness tradeoff in the persona banner. Effort S.

### 4.5 Camera-move preset library (idea, T2)

**What it is.** ~65 named camera moves in a "DoP" model — Dolly Zoom/Vertigo, Crash Zoom, Bullet Time, FPV Drone, 360 Orbit, Snorricam, Robo Arm, Whip Pan, Crane-Over-Head, Car Grip, Through-Object, Buckle Up, etc. (full catalog: `scratchpad/higgsfield_preset_research.md`).

**Code vs idea.** **Idea** — reimplement as prompt fragments. We already have 28 presets in `lib/studio/camera-presets.ts`; this roughly triples the library.

**How to implement.** Add the named moves as prompt-woven fragments. Highest-ROI first (single-sentence, model-legible): **Crash Zoom, Bullet Time, FPV Drone, Dolly Zoom, 360 Orbit, Whip Pan**. Note their *real* edge is Seedance per-shot camera **params** (not fragments) — that's the deeper Phase-D parity item, separate from this cheap win.

### 4.6 VFX / one-click effect presets (idea, T2)

**What it is.** ~48 named stackable effects — Set On Fire, Disintegration, Explosion, Melt, Wireframe, Glitch, Levitation, elemental "bending" set, plus scene presets (Kung Fu Hit, Zombie Dance, CCTV). Users stack 2–4 per shot.

**How to implement.** Idea-poach as a stackable effect-preset layer on the generator (prompt fragments + optional post overlay). Cheapest yield: **Disintegration, Set On Fire, Glitch/Wireframe, CCTV, Neon Cyberpunk**. Fits our generative-slot timeline as per-clip effect metadata.

### 4.7 Soul Cast — synthetic actor builder (idea, T2)

**What it is.** "Cast" builds an AI actor **from parameters** (genre, era, archetype, physique, outfit) — a persona with **zero input photos**, complementary to photo-trained Soul ID. Integrated into their Cinema Studio.

**How to implement.** A "Generate persona from description" path: parameter form → gpt-image-2 canonical portrait → same persona pipeline. Trivial reuse of existing plumbing; big UX win for users with no photos (and dodges the likeness-of-real-people consent surface).

### 4.8 Persona export (idea, T2 — positioning)

**What it is.** Soul is **locked** — no weight download, no external use. That's a user-lock-in they impose.

**How to implement.** Let users export the persona artifact (anchor set + descriptor + seed + any PhotoMaker embedding) as a portable bundle. Directly beats their locked-ecosystem stance; reinforces our "generation-provenance survives export" wedge.

### 4.9 Persona-training API (idea, T3)

**What it is.** Soul **training is web-UI-only — no API**. Only *image gen* with Soul is programmable, and only via third-party **Segmind** ($0.12–0.23/img), not Replicate/fal, not an official training endpoint.

**How to implement.** Expose persona create/train/generate as API + our planned **MCP surface** (a known Byorn soft spot to ship). Developer-experience wedge they structurally lack.

### 4.10 Style/film-look presets (idea, T3)

~77 named looks (20 SOUL environment presets + 7 Cinema genres + ~50 aesthetic filters). Idea-poach the *named* ones as grade+prompt presets. Note: their grade is richer than our "flat shader" color path — a known soft spot; this is a cheap partial catch-up.

## 5. Their weakness = our wedge (headline claims we can truthfully make)

1. **"The identity engine with nowhere to cut."** Higgsfield perfects the character, then routes you to DaVinci/Premiere to make the video — *by their own admission* ("no timeline"). Byorn does both in one tab.
2. **"Your identity, portable."** Soul is locked inside their ecosystem — no export. Byorn personas export.
3. **"Trainable by API."** Their Soul training is click-only; there's no endpoint. Byorn exposes persona train+generate programmatically (+ MCP).
4. **"No credit clock."** Their credits **expire in 90 days** and burn per generation across a 30-model buffet. Byorn's curated one-best-model-per-task + free editor means no inventory-decay trap.
5. **"Consistency across your *whole* reel, not one 5-second clip."** Their lip-sync/audio is per-clip (5–10s); Byorn syncs voice+music across a real multi-track sequence.

**Honest caveats to hold internally:** (a) their DaVinci/Premiere/AE plugins are a *deep* integration (auto-populated media pool, no manual round-trip) — for pros already living in those NLEs, "no friction" is credible even without owning a timeline; our wedge is strongest with casual/prosumer users who don't own a Resolve/Premiere seat. (b) On the **native still fidelity** dimension, a trained Soul likely still beats zero-shot reference-conditioning under extreme stylization — which is exactly why poaches #1–#3 (the durable tier) matter.

## 6. What we already beat them on / deliberately ignore

- **Real multi-track NLE + generative-slot timeline + takes** — they have none.
- **Cross-model identity via orchestration** — we already do the same canonical-still→i2v pattern; no catch-up needed there.
- **Local-first, $0 captions** (in-browser Whisper) + **local CLIP visual search** — they have neither.
- **22 hand-authored WebGL transitions**, generation-provenance that survives export, cross-platform web (no install/login).
- **Deliberately ignore:** their 30+-model buffet and credit-optionality — our "one best model per task" is the intentional anti-Higgsfield stance; don't re-add model breadth unless a real capability gap (e.g. Sora-class realism / lip-sync) justifies it.

## 7. Freshness note

- **Sources:** higgsfield.ai (soul-intro, soul-cinema, soul-cast-intro, ai-video-editor, cinematic-video-generator, ai-long-video-generator, lipsync-studio, camera-controls, viral-presets, mixed-media, plugins/{davinci,premiere-pro,after-effects}, team-plan, pricing, cli); Soul-ID blog posts (sould-id-best-character-consistency, Soul-ID-AI-Character-Consistency, Why-Does-Your-AI-Characters-Face-Keep-Changing); 302.AI hands-on (Medium); Segmind/WaveSpeed/imagine.art/flowith pricing write-ups; OSS repos (PhotoMaker, IP-Adapter, InstantID, PuLID, ConsisID, UNO). All accessed **2026-07-09**.
- **Model-tier provenance:** §2/§4.1–4.2 mechanism & landscape = **Opus/Sonnet** (higher confidence). §1 pricing + §4.5–4.6/4.10 preset counts = **Haiku/marketing-sourced — re-verify before quoting externally.**
- **Discrepancies to resolve (both Haiku/marketing-sourced, low confidence):** Soul-train cost cited as **25 cr** (mechanism agent) vs **40 cr** (pricing agent); **"no 4K on any tier"** (pricing agent) vs **"upscale to 4K"** (editor-gap/long-video pages). Treat both as unsettled.
- **Still UNVERIFIED:** rigorous Soul ID failure-mode bench (profiles/hands/multi-person/ethnicity bias); exact Soul output resolution cap; whether two Souls can occupy one frame natively; any founder (Mashrabov) technical statement on the architecture.
- **Re-check cadence:** presets/pricing quarterly (fast-moving); watch specifically for Higgsfield shipping a **built-in cutter** for Popcorn/Long-Video output or a **Soul-training API** — either would erode a named wedge above.

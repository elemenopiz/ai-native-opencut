# CapCut — Poach Doc (2026-07-09)

**Method:** 6 parallel research sub-agents (tiered: Haiku for lookup axes, Sonnet for
analytical axes), synthesized on Opus. Axes: free-editor baseline, AI-feature audit, credit
economics, templates/virality, web-vs-app, weakness hunt. Live web research; every claim dated
below. Where a claim traces only to CapCut's own marketing or SEO/affiliate blogs, it is flagged.

---

## 1. Header

- **Competitor:** CapCut (ByteDance)
- **One line:** the world's dominant free/freemium short-form video editor — mobile-first, now
  bolting generation (Seedance/Seedream + licensed Sora 2 / Veo 3.1 / Kling 3.0) onto a huge free NLE.
- **License/stack:** closed-source, proprietary ByteDance cloud stack. No self-host, no open core.
- **Platforms:** Mobile (iOS/Android, the origin & center of gravity), Desktop (Win/Mac, fullest
  editing feature set), Web (browser, the "lite" surface — our direct battlefront).
- **Pricing (USD, verified Jun–Jul 2026):** Free $0 · Standard $9.99/mo · **Pro $19.99/mo or
  $179.99/yr** · Team ~$9.99–12.99/user/mo. A **Mar 25 2026 restructure** roughly doubled Pro's
  price (renewals jumped ~$77→$179.99 starting Feb 20 2026), bumped Pro credits 550→**1,200/mo**,
  and cloud 100GB→1TB. **Our prior "~200 credits/mo" assumption is stale** — that was pre-March.
- **Last verified:** 2026-07-09.

---

## 2. Threat read (validated)

The brief's thesis holds, with one sharpening. CapCut is **the "CapCut half" of our positioning
fighting back**: a genuinely good, genuinely free timeline at massive scale (~300M+ MAU, ~$815M
2025 rev, ~42% of editing-app revenue by Oct 2024 — third-party estimates), now stapling gen onto
it. The threat is **distribution + a good-enough free editor**, not gen quality. Confirmed:

- **Their free editor is real and not artificially crippled.** No feature-gate wall — instead
  they cap *resolution* (1080p) and *AI quotas*. Multi-track, keyframes, chroma key, color curves,
  auto-captions, 1080p no-watermark export are all **free**. This is the part we must not lose to.
- **Their gen is weak/templated and — critically — increasingly a UI wrapper over others' models.**
  Their text-to-video menu literally lets you pick Sora 2 / Veo 3.1 / Kling 3.0. In-house Seedance
  caps at 15s/clip. Independent reviews call script-to-video output "a rough draft," "generic,"
  fit only for "B-roll... rather than the main subject."
- **Revised/added threat vectors the brief didn't fully price in:**
  1. **Director Mode (announced Jun 28–29 2026)** is their answer to our #1 build (personas/identity
     consistency). But it is **100% press-release** — zero independent hands-on, zero disclosed
     mechanism (no seed/embedding/LoRA), and CapCut's own copy *admits continuity is unsolved*.
     Their PR clock is ticking against our real shipped feature. **Re-check in 4–6 weeks.**
  2. **The templates/TikTok flywheel** is the real distribution moat, not gen — a UGC-supply +
     owned-distribution loop we can partly poach as a shareable-link mechanic.
  3. **They just handed us counter-positioning gifts:** a Jun 2025 perpetual-license ToS grab, a
     ~180% Pro price hike with 1.2–1.3★ Trustpilot billing rage, and the ByteDance ban overhang.

Bottom line unchanged: **we win on gen depth; we must not lose on editing fundamentals or onboarding.**

---

## 3. Priority table

Tiers: T1 = close or we can't win (table stakes / distribution) · T2 = credibility gap · T3 = nice-to-have.
Effort: S = hours · M = 1–3 days · L = 1–2 weeks.

| # | Poach | code\|idea | Relevance | Effort | Tier/Prio |
|---|-------|-----------|-----------|--------|-----------|
| 1 | **Template = generative-slot arrangement** (save/load/share a slot layout; template-first onboarding) | idea | Their #1 distribution mechanic, maps 1:1 onto our timeline | M | **T1** |
| 2 | **Shareable "Remix this" web URL** (`byorn.app/t/{id}` opens arrangement pre-loaded, no login) | idea | Beats CapCut's mobile-only TikTok deep-link; pure-web virality | S | **T1** |
| 3 | **Credible-free-tier parity** (the 15-item table-stakes checklist, §6-spec below) | idea | Don't-be-worse; the switch-cost floor | L (aggregate) | **T1** |
| 4 | **Social export presets** (9:16/1:1/16:9 + platform safe-zones) | idea | Table stakes for a short-form editor; cheap | S | **T1** |
| 5 | **Template/constrained-edit mode** (per-slot swap only, structure locked; = takes-as-versions) | idea | Keeps template output consistent; reuses our model | S–M | **T2** |
| 6 | **Trending-styles rail** (curated one-click LUT/motion/caption presets, "trending" tag) | idea | Low-commitment acquisition surface | S | **T2** |
| 7 | **Beat-sync / duration-locked arrangement metadata** (snap slot cuts to detected beats) | idea | Polish once arrangement format exists | M | **T2** |
| 8 | **"Used/remixed N times" badge + trending home rail** (retention loop) | idea | Pull lapsed users back; counter + sort query | S | **T3** |
| 9 | **Auto-highlight / long-video-to-shorts** (detect highlights, auto-reframe 16:9→9:16) | idea | Their strongest *analytical* AI; genuinely useful | L | **T3** |

Note: everything is **idea**, not code — CapCut is closed-source ByteDance. Nothing here is
copyable; all of it is reimplement-on-our-stack. The value is the *mechanism*, detailed below.

---

## 4. Per-poach detail

### #1 — Template = generative-slot arrangement (T1, idea, M)
**What it is.** A CapCut template is a locked timeline: N clip/photo slots, each with a target
duration, plus baked-in transitions/pacing/text/music. The user drops their own media into slots
*in order* — they can swap media/text/music but **cannot** touch transition timing, speed curves,
or layer structure. That constraint is deliberate: it caps editing complexity → low time-to-export,
and protects the creator's craft so one template survives thousands of remixes.

**Mechanism → our stack.** This is structurally identical to what our timeline already models. A
generative slot today = a Video/Image element + attached `generation` recipe + a `Take[]` list
(active take mirrored to `mediaId`), per `apps/web/src/types/timeline.ts`. So:
- **CapCut slot** (position + duration + "drop clip here") → **our generative slot** with
  `generation` set but no take resolved (an empty slot awaiting media or a prompt).
- **CapCut's locked transitions/pacing** → arrangement-level slot metadata (position, duration,
  adjacent-transition config), stored above the recipe and read-only in template mode.
- **CapCut's "swap the clip"** → assign a new source clip *or* fire a generation → new `Take`. This
  is exactly our takes-as-versions mechanic. "Using a template" = load a saved arrangement, resolve
  each empty slot via upload or `use-slot-generation.ts`, in order.
- **A "template" object** = a serializable array of slot defs (recipe stub, duration, position,
  transition config) with all media stripped — publishable, shareable, re-hydratable.

**No new timeline primitives needed** — it's a serialization + gallery + UI layer on top of
`timeline-manager.ts`, `generative-slot-content.tsx`, `use-slot-generation.ts`. Pair with
**template-first onboarding**: on new project, default to a "Start from an arrangement" picker
(blank timeline one click away). Time-to-first-export is the single biggest lever CapCut pulls.

### #2 — Shareable "Remix this" web URL (T1, idea, S)
**What it is.** CapCut's virality hinges on a TikTok→CapCut deep-link ("Use template in CapCut"),
which is **mobile-only** and requires the app. **We can beat the mechanic outright**: exporting a
Byorn project mints a public `byorn.app/t/{id}` link that opens the arrangement pre-loaded **in the
browser, no app-store gate, no login to view/try**. A URL spreads more easily than CapCut's
app-gated flow. This is the poachable *loop* without ByteDance's owned distribution — and our
web-native + no-login posture makes it strictly lower-friction than theirs.

### #3 — Credible-free-tier parity (T1, idea, L aggregate)
The switch-cost floor. Full spec in **§6-A (the extra deliverable)** below. In short: match the 15
free table-stakes features so a CapCut user never feels downgraded. Audit our current shipped state
against that list and close whatever's missing.

### #4 — Social export presets (T1, idea, S)
Add aspect presets (9:16 / 1:1 / 16:9) + platform safe-zone overlays + platform labels to the export
flow. Direct-publish via OAuth/share-sheet is a stretch (L); the presets + safe-zone overlay capture
most of the value cheaply. Memory note: safe-zones may already be partially ours — verify before building.

### #5 — Template/constrained-edit mode (T2, idea, S–M)
A "Template mode" view of the timeline: same Zustand store, but the panel only exposes per-slot
media/prompt swap + caption edit; transition/duration/style fields are read-only until "unlock to
full editor." Mirrors CapCut's constrained edit screen and our takes model (swapping a slot's take
never touches structure).

### #6 — Trending-styles rail (T2, idea, S)
A "Trending styles" rail on the asset/generate panel: curated LUT/motion/caption-style presets tagged
"trending," one-click apply to a slot's generation recipe. Cheap acquisition surface reusing existing
style/preset plumbing (`remix.ts`, `director/types.ts`).

### #7 — Beat-sync / duration-locked arrangement metadata (T2, idea, M)
Bake target-total-length + per-slot durations that snap to detected beat markers into the arrangement
format. Requires audio beat-detection (we may adopt from prior poach passes). Nice-to-have polish once
the base arrangement format (#1) exists.

### #8 — Usage-count badge + trending home rail (T3, idea, S)
"Used/remixed N times" badge on shared templates + a "Trending arrangements" section on the
home/dashboard. Retention hook; just a counter + sort-by-recency-and-usage query.

### #9 — Auto-highlight / long-video-to-shorts (T3, idea, L)
Their *analytical* AI is genuinely good (unlike their generative AI): detect highlights in long
footage, auto-reframe 16:9→9:16 with subject tracking. Detection/tracking, not generation — a real
utility feature worth having, but lower priority than the distribution loop.

---

## 5. Their weakness = our wedge

Headline claims we could credibly make, each backed by dated evidence:

1. **"Your footage stays yours."** CapCut's **Jun 12/18 2025 ToS** grants ByteDance an
   *"unconditional, irrevocable, non-exclusive, royalty-free, fully transferable, perpetual,
   worldwide"* license over uploaded video/photo/audio/voice/likeness — survives account deletion
   (TechRadar 2025; Larry Jordan, Jul 26 2025). We claim no such license. This is our sharpest,
   best-sourced wedge.
2. **"No geopolitical asterisk."** CapCut was pulled from US app stores Jan 19 2025 (PAFACA),
   restored only by non-enforcement order, and folded into the TikTok divestiture (deal reportedly
   closed Jan 22 2026). No brand should build a content pipeline on an app that can vanish. *(Fast-
   moving — re-verify status before any external use.)*
3. **"Real collaboration, not turn-taking."** CapCut's "real-time collaboration" is a single-editor
   lock-and-key model (one editor, everyone else view-only until permission transfers), on every
   surface. True concurrent editing is a clean, structural differentiator.
4. **"The web version IS the product."** CapCut Web forces **mandatory login** (no guest path), is
   **fully cloud-dependent** (no offline — lose connection, lose editing), throttles free-tier render
   compute, caps ~8 tracks in practice, and is missing Auto Cut. We're web-native, no-install,
   no-login-to-start, local-first-capable.
5. **"Generation depth, not template sameness."** Their gen is a *draft* you must manually fix, an
   avatar *catalog* you reskin, and a *multi-vendor model menu* with no cross-model identity
   guarantee. Personas + seed-lock + takes are load-bearing primitives for us; for them,
   consistency is a 10-day-old press release admitting the problem is unsolved.
6. **"No watermark roulette / no bait-and-switch."** 4K is Pro-only; Pro-templated content stamps a
   watermark even on "free" exports; the Aug 2024 removal of free cloud + the Mar 2026 ~180% Pro hike
   drove 1.2–1.3★ Trustpilot (~86% one-star, billing-dominated: charged-in-trial, can't-cancel,
   bot-only support).
7. **"Provenance that survives export."** CapCut *can* emit C2PA manifests but they're trivially
   stripped by a single ffmpeg remux. Our generation provenance is designed to survive export.

---

## 6. What we already beat them on / deliberately ignore

**Already beat (structural, they can't copy):**
- Web-native, no-install, **no-login-to-start** (CapCut Web forces an account).
- Open/MIT-derived core → self-host & data-residency story CapCut structurally lacks.
- Generation-first timeline (slot→generate→finalize) + takes-as-versions + explicit **seed-lock**
  vs. their draft-then-manually-fix + ephemeral regenerate loop.
- Local-first CLIP search + local Whisper captions (privacy, no ByteDance cloud).
- Provenance that survives export.
- (Contingent) true concurrent collaboration — a wedge *if we ship it*; they can't without rebuilding.

**Deliberately ignore:**
- Chasing their stock-avatar catalog ("1000+ digital humans" reskin) — that's the *opposite* of our
  generate-a-novel-identity bet. Don't build a costume catalog.
- Matching their owned TikTok distribution — impossible; poach the *link mechanic* (#2) instead.
- Their multi-vendor model menu (Sora/Veo/Kling picker) — a menu with no cross-model consistency is a
  liability we counter with one unified generator, not a feature to copy.
- Feature-checklist racing on commodity AI effects (relight/retouch/outpaint) — table stakes at most,
  no moat, low priority.

---

## 6-A. Extra deliverable — the "credible-free-tier" spec

**The minimum editing feature set we must match so a CapCut user doesn't feel downgraded switching to
us.** (All items are *free* in CapCut as of Jun–Jul 2026. Audit our shipped state against each.)

| # | Feature | CapCut free baseline | Why it's table stakes |
|---|---------|----------------------|-----------------------|
| 1 | **Multi-track timeline** | Effectively unlimited video/audio/overlay tracks (desktop) | The floor of any NLE |
| 2 | **Keyframe animation** | Position, scale, opacity, rotation, volume on all layers | Expected "make it move" control |
| 3 | **Speed ramping** | Speed *curves*, not just uniform speed; freeze frame; reverse | Signature short-form move |
| 4 | **Transitions** | 100+ free, 12+ categories | Users expect a real library |
| 5 | **Chroma key (green screen)** | Free, adjustable strength/shadow | Common creator workflow |
| 6 | **Auto-captions** | AI, 16+ languages, basic styling, free ≤10min/video | The #1 reason people open CapCut |
| 7 | **Text + animations** | Curved text, custom fonts, animation presets | Baseline titling |
| 8 | **Color grading** | HSL, curves, color wheel (not just filters) | We ship a flat shader today — **known gap** |
| 9 | **Video effects & filters** | 1000+, regularly updated | Volume matters to switchers |
| 10 | **Stock media** | Integrated free footage / music / SFX | No plugin, in-app |
| 11 | **Audio ducking + noise reduction** | Automatic, speech-aware | We own the compute; wire it |
| 12 | **Voice changer** | 100+ presets, pitch/speed/tone | Cheap crowd-pleaser |
| 13 | **1080p export, no watermark** | On original footage, unlimited exports | The non-negotiable |
| 14 | **Aspect-ratio presets** | 16:9 / 9:16 / 1:1 minimum | Short-form default |
| 15 | **Snapping / magnetic timeline** | Snap, ripple, magnetic behavior | Editing feels broken without it |

**Priority within the spec** (where we're most likely behind): **#8 color grading** (we ship a flat
5-uniform shader — this is a named gap from the Palmier pass too), **#11 audio ducking/noise**
(compute exists in our Python backend but is half-orphaned — wire it), **#3 speed curves**, and
**#6 auto-captions polish** (we have local Whisper; make styling competitive). Match these four and the
switch stops feeling like a downgrade.

---

## 7. Freshness note

Research 2026-07-09 via live web search/fetch, 6 sub-agents. Model tier per section:

- **Free-editor baseline (§6-A) — Haiku.** Feature-checklist lookup; figures directionally solid but
  verify exact counts against CapCut's live docs before external use.
- **AI-feature audit (§2, §5.5) — Sonnet.** Strong on model names/limits (Seedance 15s cap,
  Sora/Veo/Kling menu). **Director Mode is the key watch item**: announced Jun 28–29 2026, press-
  release-only, mechanism undisclosed — **re-check in 4–6 weeks** once independent reviews land.
- **Credit economics (§1) — Haiku.** Mar 25 2026 restructure well-corroborated (Pro $19.99,
  1,200 credits, ~180% renewal hike). Per-action credit costs (5–15/video clip, 20–40/avatar) are
  medium-confidence secondary sources — treat as directional.
- **Templates/virality (§4 #1–2, §3) — Sonnet.** UX flow solid from official help docs; growth
  stats ($815M rev, 300M MAU, 48h viral velocity) are third-party estimates, not ByteDance-disclosed.
- **Web-vs-app (§5.4) — Sonnet.** High-confidence on official-doc items (mandatory login, no offline,
  Auto Cut missing on web); ~8-track ceiling and thinner web keyframing/color are user-reported, not
  official. One conflict resolved: official docs say web *can* do conditional 4K (needs HW encode +
  4K source), overriding a third-party "1080p cap" claim.
- **Weakness hunt (§5) — Sonnet.** Jun 2025 ToS grab and Trustpilot rating well-sourced. **Two items
  to soften externally:** (a) US ban status is fast-moving — re-verify near any publish date; (b) the
  "2023 ICSA report" on China data-transmission was found only via secondary aggregators — phrase as
  "reported concerns," not fact.

**Re-check cadence:** Director Mode hands-on (~4–6 wks) · CapCut US legal status (before any external
claim) · live pricing page (before quoting numbers). Assume CapCut ships weekly on AI; this is a
snapshot, not a static target.

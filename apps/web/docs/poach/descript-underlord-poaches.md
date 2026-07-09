# Descript / Underlord — Poach Doc

> Synthesis of a 6-axis parallel research sweep (tiered Haiku/Sonnet/Opus sub-agents), merged on Opus.
> Underlord is the explicit benchmark for **Byorn's Director** agent. This doc enumerates its full agentic
> task taxonomy, infers its architecture, and maps every transferable capability onto Byorn's stack + timeline
> primitives (generative slots, takes, seed-lock personas, Director tool layer, Whisper/diarization/XTTS backend).

---

## 1. Header

- **Competitor:** Descript (company), **Underlord** (its in-app AI co-editor, still labeled *beta* even in "v2").
- **One-line product:** A transcript-first ("edit like a doc") video/podcast editor with an agentic NL co-editor layered on ~38 one-click AI Actions.
- **License / stack / platform:** Closed-source, proprietary. Desktop (macOS/Windows) + web; hybrid render (AWS GPU cloud + local WebGPU). **Idea-poach only** — no copyable source. Their transcription is Whisper-derived (parity point: Byorn already runs the same base model family).
- **Pricing (verified 2026-07-09):** Free $0 · Hobbyist ~$16–24/mo · Creator ~$24–35/mo · Business ~$50–65/mo · Enterprise custom. Metered by **media-minutes + shared "AI credits"** pool since the **Sept 23 2025** pricing overhaul.
- **Last-verified:** 2026-07-09. Several Canny changelog dates could not be pinned (JS-rendered); flagged in §7.

---

## 2. Threat read (validated against evidence)

**The hypothesis held and sharpened.** Underlord is the closest thing in-market to Byorn's Director: a mature NL co-editor with 30+ agentic actions, multi-step planning, a shown plan, per-turn checkpoint/revert, a v2 self-review loop, a **model-swappable orchestrator** (Opus 4.5 / Sonnet 4.6 / Gemini 3.x / GPT-5.2 picker), and — the single most strategically important finding — a **shipped public MCP server + single-agent NL API endpoint**. Descript's stated philosophy ("Don't ship your API as an MCP") is to expose *one* agentic endpoint: "if you can prompt it with Underlord, you can automate it through the API."

**But the box is real and structural.** Everything reduces to Descript's data model: **Project → Composition → Scene → Layer**, spine = **transcript-as-document**, with a forced-alignment engine binding every word to a timecode. The timeline is a *derived projection* (even after the May 2025 timeline redesign, scenes are still transcript-anchored spans). Consequence, confirmed by their own users and reviewers: ~2/3 of Underlord's tasks are transcript-native, and it is **structurally blind to non-verbal, multi-track, and generative-iteration editing** — "the AI only extracts exact, contiguous blocks of text from the transcript" (user, Descript Canny, 2025-06-13). That blind spot *is* Byorn's spine.

**Net threat level:** HIGH on agent maturity + API/MCP surface + audio cleanup; LOW on exactly the territory Byorn is built for (visual-first, generative slots, seed-lock personas, multi-track). We are behind on agent polish and shipped surface area; we are architecturally ahead on the thing that's hardest to retrofit into a transcript-document model.

---

## 3. Priority table

| # | Poach | code\|idea | Relevance | Effort | Tier/Prio |
|---|-------|-----------|-----------|--------|-----------|
| 1 | **Agent-as-MCP / single NL endpoint** — Director callable by other agents | idea | Closes our unshipped-MCP soft spot; sets the real bar | L | **T1** |
| 2 | **Model-swappable orchestrator** — route planning→strong model, actions→cheap | idea | Fixes "agent defaults to weak local model" soft spot | M | **T1** |
| 3 | **Agent UX: shown plan + per-turn checkpoint/revert + self-review diff** | idea | Credibility gap vs. Underlord v2; trust/undo | M | **T1** |
| 4 | **Consent-gated voice cloning** — fingerprint + consent before `/clone-voice` | idea | Safety/liability gap we currently have *open* | S–M | **T1** |
| 5 | **Studio-Sound equivalent** — DeepFilterNet denoise/de-reverb microservice | **code** | Genuine capability gap; Apache-2.0/MIT drop-in | M | **T2** |
| 6 | **Filler-word removal** — Whisper word-timestamps + dict + "avoid harsh cuts" | idea | Table-stakes audio cleanup; data already produced | S | **T2** |
| 7 | **Regenerate/Overdub** — XTTS + word-timestamp splice to fix a spoken word | idea | Flagship "magic" moment; XTTS already wired | M | **T2** |
| 8 | **Multi-model generation routing** — Veo/Sora/Kling/PixVerse per shot | idea | "Best model for the shot"; we forgo this today | M | **T2** |
| 9 | **Wire up existing diarization + stock TTS voices** to editor UI | idea (wire-up) | We already exceed Descript at model layer, unshipped | S | **T2** |
| 10 | **Repurpose suite** — Create Clips / Highlights / Trailer / titles / show notes / blog | idea | Director NL commands users expect; reuses Whisper | M | **T2** |
| 11 | **Translate captions + AI dub** — 20–30 languages | idea | Reach/parity; XTTS multilingual already present | M | **T2** |
| 12 | **Generative style library + start/end-frame morph + "extend video"** | idea | Deepens our slot mechanic with proven controls | M | **T2** |
| 13 | **Remove Retakes** — dup-line detection via segment similarity + best-take heuristic | idea | Nice cleanup; uses confidence fields we already compute | M | **T3** |
| 14 | **Silence/gap trimming** — timeline action over existing VAD gaps | idea | Table-stakes; data already exists | S | **T3** |
| 15 | **Optional transcript-edit surface** — edit-by-text overlay *on* the timeline | idea | Matches the (T) column without abandoning our spine | L | **T3** |
| 16 | **Eye Contact / Auto-reframe / Auto-multicam** visual AI actions | idea | Parity items; separate models, lower leverage | L | **T3** |

---

## 4. Per-poach detail

### T1 — close-the-gap / can't-lose

**#1 · Agent-as-MCP / single NL endpoint.**
*What it is:* Descript ships a public HTTP API **and** an MCP server, both consolidated onto **one agentic endpoint (Underlord itself)** — no granular `removeFillerWords()` methods. MCP connects via Descript login (no API token). Rationale (Helen Zeng, "Don't ship your API as an MCP"): a fixed parameter set "locks you to today's capabilities," so the same agent runs across app/API/MCP, differing only by adjustable defaults.
*Mechanism → Byorn:* Expose the Director over MCP. **But invert their design choice as our wedge:** Descript deliberately ships *one opaque NL box*; Byorn should expose **typed timeline operations** (createSlot, generateIntoSlot, addTake, selectTake, setSeedLock, moveClip(track,time), addTransition, keyframe) *plus* an NL entrypoint. External agents can then compose Byorn ops *deterministically* — something Descript's single-endpoint philosophy forbids. See `palmier-mcp-schema-spec.md` for our existing MCP schema draft; this is the anchor customer for it.
*Idea-poach.* Effort **L** (schema + auth + hosting).

**#2 · Model-swappable orchestrator (two-tier agent).**
*What it is:* Underlord = a **planner/orchestrator LLM** (user-picked: Haiku 4.5 cheap/fast, Opus 4.5 "advanced planning + nuanced edits," Sonnet 4.6 "most precise instruction-follower," Gemini 3.x, GPT-5.2) on top of **fine-tuned/specialized action models** ("largely fine-tuned models for most of our actions" — Mason). Credits bill the "agent brain" and the tool/effect *separately* → two architectural layers confirmed by the billing model.
*Mechanism → Byorn:* Directly fixes our known soft spot ("agent brain sometimes defaults to a weak local model"). Route **planning/decomposition** to a strong hosted model (Opus for multi-step; Sonnet for standard), and cheap/deterministic **actions** to cheap models or pure code. Add a user-facing model picker at the bottom of the Director panel. Keep local model only as an offline fallback, clearly labeled.
*Idea-poach.* Effort **M**.

**#3 · Agent UX: plan + checkpoint/revert + self-review.**
*What it is:* Underlord v2 "presents its initial plan, updates you as it's thinking, and occasionally pauses to check if it's on the right track." Each chat turn creates a **checkpoint**; a **Revert** button under each response rolls back just that turn's diff; a **Version History** panel does coarse restore. v2 added an automatic **post-edit self-review** that diffs the result against the request and re-invokes itself to fix over-deletions/scope creep (~20% fewer credits from better planning).
*Mechanism → Byorn:* Byorn can do this *better* because slots/takes are versioned objects → offer **op-level non-destructive rollback** ("revert just the caption pass, keep the recut") instead of a single linear undo stack. Implement: (a) Director emits a plan the user sees before execution; (b) each turn = a transaction over timeline ops with a per-turn revert; (c) a verify pass that re-reads the resulting timeline against the request.
*Idea-poach.* Effort **M**.

**#4 · Consent-gated voice cloning (safety).**
*What it is:* Before Overdub can use a clone, Descript requires the user to read a live **consent statement**, verified both algorithmically (voice-fingerprint match vs. training audio) **and by human review**. Only the user's own voice may be cloned.
*Mechanism → Byorn:* Our `services/tts-service` `/clone-voice` currently just uploads a reference WAV and saves it — **no consent, no fingerprint, no gating**. This is a liability gap, not just a feature gap. Add: a consent-phrase recording step + a speaker-embedding similarity check (pyannote embedding is already vendored via `speaker-service`) before a clone is accepted.
*Idea-poach.* Effort **S–M**. **Prioritize** given voice-cloning liability exposure.

### T2 — credibility gap

**#5 · Studio-Sound equivalent (denoise/de-reverb/enhance). CODE POACH.**
*What it is:* One-click generative speech enhancement — Descript decomposes audio into "what's said / who's saying it," discards the rest, and **re-synthesizes** clean speech (not subtractive gating); adjustable intensity.
*Mechanism → Byorn:* **No equivalent exists in Byorn today.** Clean fit: **DeepFilterNet** (`github.com/Rikorose/DeepFilterNet`, **dual Apache-2.0/MIT**, real-time 48 kHz full-band speech enhancement, pretrained weights included). Stand up a new `services/audio-enhance-service` following the existing `whisper-service`/`speaker-service` FastAPI template (health/models/load/unload endpoints already patterned in-repo). Expose an intensity control.
*Code-poach — permissive.* Effort **M**.

**#6 · Filler-word removal.**
*What it is:* Filler tokens underlined in transcript; per-item ignore/delete/replace or bulk one-click; an **"Avoid harsh cuts"** option skips a removal if it would clip an adjacent word / leave an audible seam. English/DE/FR/PT/IT only.
*Mechanism → Byorn:* Pure rule layer over data `whisper_service.transcribe()` already returns — word-level timestamps + `probability`. Match `TranscriptionWord.word` against a filler dictionary; before cutting, check the adjacent-word gap to replicate "avoid harsh cuts." No new model.
*Idea-poach.* Effort **S**.

**#7 · Regenerate / Overdub (fix a spoken word by typing).**
*What it is:* Select transcript text → type replacement → Descript resynthesizes only that span in the cloned voice and re-splices in sync. Beta video-regenerate also re-renders mouth movement.
*Mechanism → Byorn:* XTTS v2 is already wired (`tts-service`, `/clone-voice` reference-WAV path). Use Whisper word timestamps to locate the span, synthesize the replacement via XTTS with the project's seed-locked voice, splice at word boundaries with a short crossfade. Ties into persona/seed-lock for voice consistency across a project.
*Idea-poach.* Effort **M**. (Video mouth-sync is a separate, larger lip-sync effort — see `opencut_ecosystem_poaches` MuseTalk note.)

**#8 · Multi-model generation routing.**
*What it is:* Descript is a multi-vendor **model marketplace** inside the editor — video via **Veo 3.1 / Sora 2 / Kling / PixVerse**, image via **GPT Image 2** ("notable for character consistency"), selectable per media type in App Settings ("switching only affects future generations"); "premium models use more credits."
*Mechanism → Byorn:* Our "one unified generator" is simpler UX but forgoes best-tool-per-shot. Add a **backend-model toggle** (settings-level default + optional per-slot override) behind the *same* generation UX — keep one flow, route to different providers. Note: GPT Image 2 is already our image path per `project_prd.md`.
*Idea-poach.* Effort **M**.

**#9 · Wire up existing diarization + stock TTS voices.**
*What it is:* Descript gates speaker labels behind running Studio Sound first; stock AI voices (21) provide narration without a personal clone.
*Mechanism → Byorn:* We're *ahead at the model layer, behind at the UI*. `speaker-service` (pyannote-3.1 + silence fallback + bonus emotion endpoint) and `tts-service` non-cloning models (VITS/Tacotron2) are **built but unwired**. Surface `/diarize` output in the editor transcript UI; add a stock-voice picker to the narration path. No new model work.
*Idea-poach (wire-up).* Effort **S** each.

**#10 · Repurpose suite (Director NL commands).**
*What it is:* Create Clips (N social clips w/ captions), Create Highlight Reel, Find Highlights (informational), Create Trailer, Generate Titles/Social Posts/Show Notes/Blog Post/YouTube description. All LLM-over-transcript.
*Mechanism → Byorn:* Each is a Director tool = (Whisper transcript + LLM prompt) → timeline op or text artifact. Highest-value first: **Create Clips** (transcript span → new composition on our timeline) and **Generate Titles/Show Notes** (pure text, trivial). Reuses the Director's orchestrator (#2).
*Idea-poach.* Effort **M** for the set; **S** each for the text-only ones.

**#11 · Translate captions + AI dub.**
*What it is:* Translate captions into 20–30+ languages; toggle an AI-voiced dub in the target language (Dubbing ~15 credits/min).
*Mechanism → Byorn:* Whisper transcript → MT → re-time captions; dub via XTTS v2 (already multilingual) using the project voice. Word-timestamp re-alignment is the hard part.
*Idea-poach.* Effort **M**.

**#12 · Generative style library + start/end-frame morph + "extend video".**
*What it is:* Placeholder → Generate exposes a **generative media style library**, an image→image **start/end frame** morph ("select models"), and **Extend video** (uses the last keyframe of an existing clip as the seed to predict motion continuation). Images fan out **4 options** at once, saved to both timeline and library.
*Mechanism → Byorn:* Our slot→generate→finalize already matches the placeholder pattern (independent convergence = validation). Deepen it: (a) a style-preset library on the slot; (b) start/end-frame conditioning where the provider supports it; (c) "extend clip" using last-frame as seed; (d) fan-out N candidates *into the take stack* (our take stack is the superior version of their one-shot 4-image fan-out).
*Idea-poach.* Effort **M**.

### T3 — nice-to-have

**#13 · Remove Retakes.** Segment-text similarity (fuzzy / sentence-embedding cosine) to cluster duplicate spoken lines; keep best by `avg_logprob`/`no_speech_prob` (already computed). Idea, **M**.
**#14 · Silence/gap trimming.** Timeline action over gaps our VAD (`min_silence_duration_ms`) already detects. Idea, **S**.
**#15 · Optional transcript-edit surface.** To match the (T) column *without* surrendering our spine: an edit-by-text *overlay* bound to timeline clips (delete text → ripple-delete the clip span), explicitly a secondary view — the inverse of Descript, where timeline is secondary. Only worth it once dialogue-heavy segments matter. Idea, **L**.
**#16 · Eye Contact / Auto-reframe / Auto-multicam / Green screen.** Parity visual actions; separate models (gaze-redirection GAN / speaker-tracking / waveform-driven angle switch). Green screen may already be within reach via our compositing. Idea, **L**.

---

## 5. Their weakness = our wedge (headline claims)

1. **"Your timeline is the source of truth, not a fallback view."** Even Descript's May 2025 timeline redesign is a projection of transcript-anchored scenes; reviewers call it "clunkier than Premiere/Final Cut," reached for only when the doc runs out of road. Byorn is a real multi-track NLE from day one.
2. **"Silence isn't a bug in the interface — it's the interface."** Descript's edit surface goes dark with no dialogue: silent reels, ASMR, gameplay, dance, product hero shots yield an empty transcript with nothing to grab. Byorn's generative-clip spine works identically with speech, music, or nothing.
3. **"Beat-synced, not word-synced."** For motion-graphics/music cutting, our Director reasons over clips/transitions/timing directly — "cut on the beat at 0:42" is a native op, not a transcript token that doesn't exist.
4. **"Persistent takes, not a one-shot fan-out."** Descript's regeneration is linear undo/redo or a one-time 4-image fan-out; there's no browsable, non-destructive per-slot take register. Our takes-as-clip-versions is a genuinely deeper primitive.
5. **"Consistent protagonist, not just a consistent narrator."** Descript solved *presenter* consistency (Avatars) but has **no seed-lock/persona for generated characters across B-roll/scenes** — it doesn't even surface the Character-Lock features Kling/PixVerse already have. Their own case study admits generated brand results "weren't close enough to actually use." This is exactly Byorn's #1 priority and it's *open*.
6. **"Typed timeline ops over MCP — not one opaque NL box."** Descript deliberately ships a single agentic endpoint; external agents can't compose it deterministically. Byorn's Director can expose typed operations *and* NL.
7. **"Transparent, generous AI — not a metered credit trap."** Descript's Sept 2025 media-minute + AI-credit overhaul triggered widespread backlash: "a month's worth of credits lasts about a day," bill-shock jumps ($30→$195/mo), fixing one word costs 10 credits, "predatory," "can't recommend it anymore." Simple, higher-default, non-metered AI is a clean counter-position.
8. **"Built for the whole video, not just the parts people talk during."** The most repeatable competitor line — reviewers 2023–2026 independently converge on "great for podcasts/talking-heads, skip it for anything visual/motion/non-dialogue."

---

## 6. What we already beat them on / deliberately ignore

**Already ahead:**
- **Timeline-native architecture** (multi-track, keyframes, layers as first-class) vs. transcript-anchored scenes.
- **Generative slots + persistent takes** vs. placeholder-fill + linear undo.
- **Diarization + multi-model TTS built** (`speaker-service`, `tts-service`) — ahead of what Descript *wires into its UI*; our gap is surfacing, not capability.
- **Cross-platform web, no install/login**; **22 hand-authored WebGL transitions**; **generation-provenance that survives export**; **local-first CLIP search + Whisper captions**.
- **Seed-lock personas** — the character-consistency primitive Descript structurally lacks.

**Deliberately ignore (for now):**
- **Transcript-first as the *primary* metaphor** — it's their moat *and* their ceiling; adopting it would import the ceiling. Keep timeline primary; add transcript only as an optional overlay (#15).
- **Avatar talking-head presenters** as a headline feature — narrow use case, off our visual-first thesis.
- **Chasing every one of the 38 AI Actions** — cherry-pick the high-value/low-effort ones (audio cleanup, repurpose text, translate) that reuse Whisper/XTTS; skip parity-for-parity's-sake visual actions (Eye Contact, multicam) until later.

---

## Extra deliverable — Director capability backlog (Underlord tasks we lack, ranked by value × effort)

Ranked for implementation on Byorn's Director tool layer. "Value" = user demand × strategic fit; "Effort" on our stack.

| Rank | Director capability | Value | Effort | Why now |
|------|--------------------|-------|--------|---------|
| 1 | **Show-plan + per-turn checkpoint/revert + self-review** (#3) | ★★★★★ | M | Table-stakes agent trust; we look unfinished without it |
| 2 | **Two-tier model routing + picker** (#2) | ★★★★★ | M | Directly fixes the weak-local-model soft spot |
| 3 | **Create Clips / Highlights from a prompt** (#10) | ★★★★☆ | M | Highest-demand repurpose op; reuses Whisper |
| 4 | **Filler-word + silence cleanup as Director commands** (#6,#14) | ★★★★☆ | S | Cheap, data already produced, universally expected |
| 5 | **Regenerate a spoken word (XTTS splice)** (#7) | ★★★★☆ | M | Flagship "magic" moment; XTTS already wired |
| 6 | **Text artifacts: titles / show notes / blog / social** (#10) | ★★★☆☆ | S | Pure LLM-over-transcript; trivial, broad appeal |
| 7 | **Translate + dub** (#11) | ★★★☆☆ | M | Reach; XTTS multilingual already present |
| 8 | **Generate-into-slot via NL with style presets** (#12) | ★★★★☆ | M | Deepens the spine; fan-out into takes = our edge |
| 9 | **Apply layout/template + transitions via NL** (Axis 1 B) | ★★★☆☆ | M | We own 22 WebGL transitions — expose them to the agent |
| 10 | **Add chapters / label speakers via NL** (#9) | ★★☆☆☆ | S | Diarization already built; wire to Director |

**Sequencing:** Ship #1–#2 first (they make *every* subsequent capability more trustworthy and cheaper to run), then the S-effort cleanups (#4, #6) for quick credibility, then the flagship generative/voice moments (#5, #8) that showcase our spine.

---

## 7. Freshness note (sources + model tiers + re-check schedule)

**Per-axis provenance (re-verify low-confidence Haiku items first):**
- **Axis 1 — Task taxonomy (Sonnet):** 38 tasks across 6 groups; solid. Caveat: `help.descript.com` returned HTTP 403 to direct fetch → some AI-Action details triangulated from snippets. "Season 6/Underlord" launch date conflicts across sources (2024 vs. a 2026-03-24 blog date) — **treat launch date as unverified**.
- **Axis 2 — Architecture (Opus):** High confidence on shape (two-tier orchestrator, tool-calling surface, model picker, public API+MCP, plan/self-review). Internal op-schema and agent-level undo are **inferred** (labeled). Model SKUs (Opus 4.5, Sonnet 4.6, GPT-5.2, Gemini 3.x) reproduced from Descript's 2026 changelogs, not independently verified against provider release notes.
- **Axis 3 — Generation (Sonnet):** Veo 3.1 / Sora 2 / Kling / PixVerse / GPT Image 2 marketplace confirmed. **Unconfirmed:** an aggregator claim that OpenAI is retiring the Sora app (2026-04-26) / Sora API (2026-09-24) — if true, a real risk to Descript's Sora-in-editor claim. Re-check against OpenAI primary sources.
- **Axis 4 — Transcript metaphor (Sonnet):** Well-corroborated across independent reviews. Reddit/X not directly fetchable → Reddit quotes relayed via aggregators (eesel.ai, Capterra); content corroborated, permalinks not verified.
- **Axis 5 — Voice/audio (Sonnet):** Strongest actionable axis; cross-checked against **Byorn's actual backend code** (`whisper-service`, `tts-service`, `speaker-service`). DeepFilterNet license (Apache-2.0/MIT) confirmed. `/clone-voice` consent gap confirmed in-repo.
- **Axis 6 — Pricing (Haiku — RE-VERIFY):** Plan structure + Sept 2025 overhaul + complaint corpus solid, but **flag for re-check:** exact AI-credit top-up per-unit cost (not published), per-plan Underlord prompt limits (unpublished), Hobbyist Overdub scope, project size caps, per-generation video credit cost (explicitly variable).

**Re-check cadence:** Descript changelogs move fast (Underlord v2 was Jan 2026). Re-verify **pricing + model picker + API/MCP surface quarterly**; re-verify the Sora-retirement claim before citing it anywhere; pin Canny changelog dates via a logged-in/rendered view when a date matters.

**Sources:** descript.com (product/pricing/underlord/blog), help.descript.com (403-limited), descript.canny.io (changelog + feature-requests), Cognitive Revolution podcast (Andrew Mason 2024), Descript blog "Don't ship your API as an MCP" (Helen Zeng), docs.descriptapi.com, Capterra/G2/Trustpilot, Style Factory / workfromyourlaptop / Cotovan / Chase Jarvis reviews, github.com/Rikorose/DeepFilterNet. Full URL list retained in the six sub-agent transcripts. All accessed **2026-07-09**.

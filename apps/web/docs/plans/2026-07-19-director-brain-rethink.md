# Director Brain Rethink — from faking it to real

> Companion to `2026-07-19-director-northstar.md` (the WHAT). This doc is the HOW-IT-THINKS:
> a first-principles pass over every brain decision — model choice, eyes, taste, tools,
> interface — prompted by the user's 2026-07-19 directive: "an actually useful, usable,
> professional product, not just something we're faking. I want it to be real."
> Status: ☑ drafted · ☐ folded into build briefs (amendment map below).

## Method: name the fake, define the real

Every agentic video editor today (ours included) fakes the same six things. Each fake maps to
an architectural decision.

### Fake 1 — The brain never watches the video → REAL: video-native eyes
Director reads text (captions, manifests, digests); the planned critic samples static frames.
Editing is motion + rhythm + performance + sound; description destroys all four.
**Decision:** perception and critique migrate to **video-input model calls** (Gemini-class:
video + audio + timestamps). The critic's end-state is *watch the rendered cut* on a low-res
proxy (we already build proxies) — not sample frames. Bet-2 v1 (12 frames) stands as
scaffolding; v2 = watch-the-cut, cost-tiered (proxy res/fps caps), still ADR-006-bounded.

### Fake 2 — LLMs can't feel time → REAL: split what from when
No text model senses a shot being 8 frames long-of-beat. **Decision:** the model owns intent;
deterministic craft code owns frame-accurate execution. The craft-macro pillar (P5) is not a
convenience layer — it is the prosthetic for the model's missing time-sense. Macros consume
the beat grid, silence maps, and (new) cut-on-motion detection; no model call inside a macro.

### Fake 3 — Taste-by-prompt → REAL: three measurable taste sources
1. **Edit grammars:** per-format structural profiles measured from professional work —
   shot-length distributions, cut-rhythm-vs-energy curves, hook placement, arc shapes
   (trailer / doc / social / podcast). The critic scores against a grammar, not adjectives.
   Ship as versioned data (`lib/director/taste/grammars/*`), hand-built v1, refined by data.
2. **Reference fingerprinting:** user drops a video they love → extract its *edit
   fingerprint* (pacing curve, cut rhythm, energy envelope) → target it. We already ingest
   and normalize reference videos for r2v; nobody offers "match this cut's rhythm." Unclaimed.
3. **The accept/reject flywheel:** every Proposal decision is a labeled taste example.
   Per-user → preference model (Bet 3, in flight). Aggregate (opt-in, tenancy-clean) →
   tunes the grammars. Learned taste without training a video model.

### Fake 4 — One chat loop pretending to be a production → REAL: staged, typed artifacts
Real work: **brief → treatment → selects → story plan/EDL → cut → notes.** Each artifact is
typed, persisted, inspectable, and user-editable BEFORE the next stage consumes it — that is
both the professional workflow and the trust mechanism (fix the treatment, don't argue with a
finished timeline). The Story Engine (P3) is specified as this pipeline, not a mega-prompt.
**Key workflow insight — radio cut first:** assemble the story on the audio/transcript spine
(dialogue/VO selects → radio edit), then lay picture. Matches documentary/social practice;
transcripts already exist; no agentic competitor does story assembly this way (Descript =
text-editing one clip, not multi-clip story assembly).

### Fake 5 — Chat as the interface → REAL: the timeline is the conversation
Directors give notes at timecodes. Director annotates the timeline directly — markers with
notes, clickable both directions (Director cites → timeline highlights; user selects clip →
"about this"). Proposals (P7) carry changes; markers carry notes; paragraph chat is fallback.

### Fake 6 — Brand-loyal brain choice → REAL: eval-decided routing
"Which LLM" is a routing table, not a loyalty:
- **Orchestrator/agent loop:** strongest agentic reasoner available — decided by the eval
  harness (P8), re-decided when models ship. Honest note: prod's Kimi k2.6 was a cost call,
  not a quality call; if Director is the moat, the brain is bought on measured quality and
  cost is recovered in pricing.
- **Eyes/critic:** video-native multimodal (Gemini-class today).
- **Cheap classification** (role tags, select scoring triage): small fast models.
- **Craft macros:** no model.
- **Latency tiers as a design constraint:** interactive verbs feel instant (<~2s), deep
  passes (perception index, whole-cut critique, story assembly) run async with visible
  progress. A pro will not wait 90s for a chat reply.

## What professionals actually judge (the bar for "usable, professional")

Reliability over brilliance: (1) never destroys work — checkpoint + Proposal + revert;
(2) honest failure — "I can't do X" beats a confident mess (system-prompt + verb-error
surfacing policy); (3) repeatability — same ask, same project ⇒ substantially same result
(eval-pinned); (4) speed — the latency tiers above. ADR-006 and Proposals are not hedges;
they ARE the professional posture.

## Amendment map (what this changes in live plans — no in-flight churn)

| Live item | Amendment |
|---|---|
| Bet 2 critic (in flight) | v1 unchanged (scaffolding). v2 target = watch-the-cut via video-input model on proxy; grammar-scored rubric. |
| Bet 1 perception (in flight) | v1 unchanged. Next increment after Selects: video-input extraction pass instead of frame-based, same schema. |
| P5 craft macros | Elevated: the time-sense prosthetic. Add cut-on-motion detection to the input set. |
| P3 Story Engine | Specified as staged typed artifacts; radio-cut-first is the default assembly strategy when speech footage dominates. |
| P7 Proposals | Add timeline markers/annotations as a first-class Director output channel. |
| P8 eval harness (in flight) | Explicitly the brain-procurement instrument: scored tier compares orchestrator candidates (incl. prod Kimi k2.6 vs frontier) — a standing decision input, not a one-off. |
| NEW — taste data | `lib/director/taste/`: edit grammars (v1 hand-built) + reference-fingerprint extraction. Queue as its own bet behind Bet-2 merge (critic consumes it). |

## Gates unchanged, one added

All existing gates stand. **Added:** aggregate (cross-user) taste-flywheel data collection is
opt-in + a user gate before any implementation — per-user stays inside current tenancy rules.

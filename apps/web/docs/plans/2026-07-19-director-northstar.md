# Director North Star — the full rethink

> Mandate (user, 2026-07-19): "We need it to be the best out there. We need it to be our moat.
> We need it to do what others couldn't… the strongest possible and most intelligent and most
> tasteful and most capable and most user friendly director."
> Supersedes-in-ambition (not in content): `2026-07-19-director-intelligence-architecture.md`
> — the three bets there are pillars 2/4/6 of this doc and stay in flight unchanged.
> Status: ☑ drafted · ☐ pillar gates signed · ☐ built.

## The one-sentence definition of "best"

**Give Director a folder of raw footage and a goal; get back a cut you'd ship — with every
decision inspectable, previewable, and reversible.**

No competitor can do this. Palmier is a tool-caller (46 tools, no judgment). Runway has models
and an abandoned editor. Higgsfield has one consistency trick. Vyra indexes footage but can't
edit. The full pipeline — *understand the footage → understand the intent → construct a story
→ execute the edit with craft → judge it → learn the user* — is unclaimed. That pipeline IS
the rethink.

## Anti-goals (what "ground-up" must NOT mean)

- **Not a rewrite.** The verb surface (`DirectorApi`), the agent loop, seed-lock, `getTimeline`
  are the chassis nobody else has. Rewrites are how Runway lost their editor. We rebuild the
  *capability architecture* on the existing chassis.
- **Not more modes.** We are deleting the 16-mode kitchen sink this week (revamp Part B+D).
  "Most capable" = the core job done excellently. Utility panels live in Tools; Director is
  one conversation that can do everything through verbs.
- **Not unbounded autonomy.** ADR-006 stands: advisory-first, hard ceilings, user-visible
  stops. Ambition lives in capability, not in spend.

## The eight pillars (organism, not organs)

### P1 — Intent: a durable Creative Brief (NEW)
A real director holds a vision; ours forgets it between turns. Add a versioned per-project
`CreativeBrief` — audience, purpose, tone, target duration/platform, references, constraints —
elicited conversationally at the first ask ("what are we making?"), refined continuously,
**cited by every downstream stage** (generation prompts, story engine, critic rubric).
Seam: extends `project-bible.ts` (the styleBible/tone machinery is the embryo of this).

### P2 — Perception: footage understanding (IN FLIGHT + one extension)
Bet 1 (deepened `AssetUnderstanding`) is building now. **Extension — Selects:** moment-level
understanding. Per asset, time-ranged moments `{startSec, endSec, kind: highlight|usable|dead,
score, note}` — where the good part *is*, not just what the clip is. This is what an assistant
editor does ("pulling selects") and it is the substrate story construction stands on. Speech
clips get structure from transcripts (already shipped); action clips from motion/energy.
Vyra indexes assets; nobody pulls selects.

### P3 — Story Engine: first assembly (NEW — the moonshot)
The capability leap: **brief + footage inventory (assets, selects, transcripts) → StoryPlan
(sections/beats, each with intent, candidate selects, target duration) → executed assembly on
the timeline via existing verbs → one bounded self-check critic pass → presented as a
Proposal.** A human's first assembly takes hours; this is minutes. It composes everything:
P1 gives the goal, P2 the material, P5 the craft, P4 the judgment, P7 the presentation.
Invoked as one user command ("make me a cut"), with disclosed bounded cost per ADR-006.

### P4 — Taste: the critic (IN FLIGHT)
Bet 2 (whole-edit `critiqueEdit`, advisory-first) is building now. It becomes: (a) the user's
notes-giver, (b) the story engine's self-check, (c) — later, gated — the autonomous polish
loop with ceilings. Its rubric reads P1's brief and P8's preference model: critique against
*your* goal and *your* taste, not a generic one.

### P5 — Craft: an editing playbook (NEW)
Taste without hands is a critic, not a director. Encode editing idioms as composite verbs /
macros the model (and the critic's `proposedFix`) can call at professional quality:
`cutOnBeat`, `jCut`/`lCut`, `duckMusicUnderSpeech`, `tightenToLength`, `punchIn`,
`hookFirst`. Auto-cut silence (@0a921956) proved the pattern — codified craft as a verb.
Each macro is deterministic, testable, and cheap (no model call inside).

### P6 — Memory: learning you (IN FLIGHT)
Bet 3a (preference distill from choose/reroll/discard) is building now; the capture hook (3b)
follows. Feeds generation defaults and the critic rubric. Compounds with usage — the moat
that widens over time.

### P7 — Collaboration surface: Proposals (NEW — the user-friendly wedge)
Chat describing edits is telling; a director *shows*. Every multi-step Director edit lands as
a **Proposal**: a named, previewable, revertible change-set on the timeline — accept, reject,
or pick apart. v1 = checkpoint-before-run + human-readable diff summary + one-click revert
(the undo/history command stack already exists). v2 = true side-by-side cuts on the vc
branch/clone machinery (built, flag-hidden per ADR-003 — using it internally is not un-hiding
collab UI). Plus timeline-anchored conversation both ways: Director cites elements/timecodes
as clickable references; user selects a clip and asks "about this." Nobody has a
review-and-apply UX for AI edits; this is how agentic editing becomes trustworthy.

### P8 — Measurement: the Director eval harness (NEW — how "best" stops being vibes)
"Best out there" must be falsifiable. A two-tier harness:
- **Deterministic tier (CI):** fixture projects (E2E-bridge seeding exists) + scripted briefs
  run through the loop with mocked model responses — asserts loop machinery, verb dispatch,
  timeline invariants. Guards every prompt/brain change (prod Kimi k2.6 vs local Gemini drift
  is a live risk today).
- **Scored tier (env-gated, real model):** the same fixtures scored against a rubric
  (critic-as-judge + golden assertions) → a tracked taste/capability number per brain+prompt
  version. This is the receipt behind every "our Director is better" claim.

## Sequencing (collision-aware with the in-flight wave)

| Order | Work | Cluster | Blocked by |
|---|---|---|---|
| now | P8 eval harness v0 (deterministic tier) | new `lib/director/evals/` | nothing — dispatched |
| now | Floor Wave 1 (B+D, E) + Bets 1/2/3a | as briefed | in flight |
| next | P1 Creative Brief (model + elicitation + verbs) | `project-bible.ts` + director-api/tool-catalog | Bet 2 merge (file collision) |
| next | P2 Selects extension | asset-understanding cluster | Bet 1 merge (same cluster) |
| next | P5 craft macros (first 3: cutOnBeat, tightenToLength, duckMusic) | new `lib/director/craft/` + verb registration | Bet 2 merge (registration files) |
| then | P7 Proposals v1 (checkpoint + diff + revert) | director.tsx + command stack | B+D and C merge |
| then | P3 Story Engine (design doc first, then fleet) | new `lib/director/story/` + orchestration | P1+P2-selects+P4+P5 |
| later | P7 v2 (vc side-by-side) · P4 autonomous polish loop (gated) · P8 scored tier | — | gates |

## EDITING-FIRST RE-RANK (2026-07-19, ADR-007 — supersedes the sequencing above where they conflict)

User decision: the Director must be fully valuable with **zero generations** (consent +
cost roadblocks on gen; see ADR-007). The north-star sentence already fits ("raw footage +
a goal → a cut you'd ship") — the re-rank changes *order*, not destination:

1. **P0 floor: prod transcription root-cause** (on-device Whisper init failure in the
   webpack prod build — un-root-caused; dialog-aware editing stands on it).
2. **Dialog-aware editing core:** filler-word/silence smart cleanup (extends the shipped
   auto-cut engine with transcript signals) → **text-based editing** (edit the transcript,
   the timeline follows — Descript's killer feature on a real timeline; fork-sweep-confirmed
   ecosystem gap) → radio-cut-first assembly (P3 v1 scoped to speech footage).
3. **Selects (P2-ext)** re-scoped: "find the best 30 seconds of this hour" is an
   editing-first deliverable, not a generation input.
4. **Composition plays on existing primitives:** transcript-driven b-roll placement (CLIP
   search × transcript topics over talking-head), multicam-by-audio-sync + speaker-switch
   (speaker-captions seam exists), punch-in variety macro (fake multicam from one camera —
   deterministic, model-free), music ducking + LUFS normalize (F3 backlog joins P5).
5. **P7 Proposals + P4 critic** unchanged — they are the trust and taste layers of exactly
   this experience. P8 eval fixtures become zero-generation projects first.
Persona/gen-side work: parked dark (Gate A stands); new gen backends not roadmapped.

## Gates for the user

- **Story Engine cost shape** — one "make me a cut" run = N model calls (plan + assembly
  checks + one critic pass). Priced and disclosed before the proactive path exists; billing
  wiring is money-floor (gated branch), same as the critic's.
- **P7 v2 on the vc layer** — internal reuse is fine; anything that *surfaces* collab UI
  re-opens ADR-003.
- Existing gates unchanged: ADR-004 un-hide (needs Bet-1 cost number), F-server schema,
  critic billing, autonomous loop (ADR-006).

## What this doc changes about the running mission

Nothing in flight is wasted — Wave 1 builds pillars 2/4/6 and the floor. This doc adds
P1/P3/P5/P7/P8 as first-class bets, names the composition (the north-star pipeline), and
re-ranks "done": the mission is not done when the nine floor items + three bets merge; it is
done when the north-star sentence is demonstrably true at eval-harness tier.

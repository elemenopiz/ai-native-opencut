# ADR-007 — Editing-first: the Director must be fully valuable with zero generations

Date: 2026-07-19 · Status: accepted (user decision, Director-intelligence mission)

## Context

Two live roadblocks sit on the generation path: (1) consent safeguards — real-face
generation is hard-blocked on the standard Seedance endpoint and the verified route needs
partner access + liveness infra we don't have; (2) cost — the BytePlus pool and per-clip
generation economics. Meanwhile the brain-rethink analysis showed video *understanding* is
cents, and the Director's chassis (verbs, timeline, transcripts, beat grid, critic) is
already an editing engine. The user's call, verbatim: "make the AI director so useful that
someone could use byorn and not even need to AI generate a video or photo once… let's focus
on the agentic editing experience first now. let's make it the best in class."

## Decision

1. **The Director's primary job is editing the user's own footage.** Every Director
   capability must deliver its full value on a project containing zero generated media.
   Generation remains a first-class *optional* layer (the generative-clip timeline stays the
   spine architecturally), but no roadmap item may assume generation to be useful.
2. **Transcript reliability is a floor.** Dialog-aware editing stands on transcription;
   the prod on-device Whisper failure is a P0. Until transcripts work on prod, editing-first
   claims are false.
3. **Roadmap re-rank:** dialog/transcript-driven editing (text-based editing, filler-word
   cleanup, radio-cut assembly), selects, craft macros, Proposals UX, and the critic outrank
   generation-side work (persona surfaces stay dark per Gate A; new gen backends parked).
4. Positioning: the wedge is "the agentic editor for footage you already have" —
   Descript-class transcript editing on a real timeline, with an agent that watches the
   footage and executes craft. Not a gen-video toy.

## Consequences

- The ADR-004 Understanding-Pass un-hide gets *more* attractive (it's the eyes for editing,
  ~$0.005–0.015/asset) while gen-backend expansion gets less.
- Character-consistency (moat #1) is deprioritized, not abandoned — machinery intact,
  revisit when the consent/verified-route path or demand justifies it.
- The eval harness (P8) gains editing-first fixtures: its scored scenarios must be
  zero-generation projects first.

# Director Autonomy — Architecture Direction

**Written:** 2026-09-18
**Question it answers:** the Director is confined to N specific actions. Does that constrain
it, and if so what replaces it? How does it stop being a planner and become a one-shotter
that takes a vlog and returns a finished, professional cut with no human in the loop?

---

## 1. The premise, examined

> "I'm not sure how I feel about the AI being confined to x amount of specific actions."

Half right — and the half that's wrong matters more than the half that's right.

Two different things get conflated under "actions":

**The vocabulary** — which primitives exist. This is *not* where creativity lives. A film
editor has maybe ten primitives: cut, trim, ripple, roll, slip, slide, dissolve, fade,
speed, reframe. Every film ever cut was made from those. The vocabulary has never been the
constraint.

**The policy** — when to use them, in what order, with what taste. This *is* where
creativity lives, and it is where Byorn's Director is genuinely over-constrained.

So "give it more actions" is the wrong move, and we have the receipts: the per-phase tool
ceiling in `phase-scope.test.ts` has been pushed **28 → 29 → 32** as verbs were added,
each with a comment explaining why this one had to fit. That is an architecture arguing
with itself. Verb #76 will not unlock creativity; it will make the tool list harder to
reason about and the phase buckets fatter.

The actual constraints, in order of how much they hurt:

1. **Macro verbs freeze creative decisions.** `cutOnBeat`, `tightenToLength`,
   `duckMusicUnderSpeech` are recipes — somebody's opinion about how to do a thing, baked
   in. The agent can invoke the opinion but cannot vary it. It cannot cut on *every third*
   beat, or on the downbeat only in the chorus, or hold one shot deliberately long against
   the grid for tension. Those are the interesting choices, and the macro is exactly what
   forbids them.
2. **Phase gating enforces plan-then-do.** briefing → production → polish, with verbs
   partitioned between them, *is* the planner shape. It is structurally impossible for the
   agent to behave like a one-shotter while the phase machine exists.
3. **The agent cannot see its own work.** It edits a timeline it has never looked at.
4. **The approval ceremony.** `proposeReel` → `reviseProposal` → `acceptProposal` is three
   verbs whose entire job is asking permission.

---

## 2. The direction: primitives + programs

### Layer 1 — Primitives. Keep them few, and make them *closed*.

The set of timeline operations that are complete: any edit a human can express in the NLE
is reachable by composing them. Byorn mostly has these already — `trim`, `move`, `split`,
`reorder`, `remove`, `addClip`, `addText`, `applyTransition`, `applyEffect`, `animateItem`.
Roughly fifteen.

**Stop adding to this layer.** The test is not "is there a verb for this task" but "can
this task be *composed*". If yes, no verb.

### Layer 2 — Programs, not macros. This is the unlock.

Replace the macro verbs with **data + a way to compute over it**.

Today the agent calls `cutOnBeat(...)` and gets someone's cutting philosophy. Instead, give
it the beat map, the transcript with word timings, scene boundaries and the loudness curve,
and let it write a short program over the primitives:

```
beats = project.beats()
for i, beat in enumerate(beats):
    if i % 3 == 0 and beat.confidence > 0.8:
        split(clip_at(beat.t), beat.t)
```

That is not a smaller action space than `cutOnBeat` — it is *strictly larger*, and it
contains `cutOnBeat` as one possible program. The logic already exists as library functions
in `lib/director/craft/`; the refactor is to stop exposing them as frozen verbs and start
exposing the **data they consume** plus the primitives they call.

Mechanically: one verb, `applyEdit(program)`, executing in a sandbox with access to the
primitives and the project's derived data. Forty macro verbs collapse into fifteen
primitives plus composition — and the tool list *shrinks* while the reachable space grows.

This is the difference between a tool-calling agent and a coding agent, and it is the
single highest-leverage change available.

**It is also how we keep safety.** A program is inspectable before it runs, its effects are
enumerable, and the whole run can be one atomic undo entry. Free-form creativity and a
reliable undo stack are not in tension if the creativity is expressed as a program.

### Layer 3 — Generation as an ordinary resource.

The agent decides "this cut needs a shot that doesn't exist" and makes one — video, image,
audio, voiceover — with no special mode and no separate approval. The backend registry
already routes by intent, so this is plumbing, not new capability.

---

## 3. Planner → doer

The planner behaviour is structural, not a prompt problem. Prompting a phase-gated agent to
"just do it" will not work, because the gate is real.

**Collapse briefing to a single turn.** One pass that asks 2–3 questions, at most once, then
commits. Not `proposeReel` → wait → `reviseProposal` → wait → `acceptProposal`.

**Drop the phase gates for the run.** After the brief is settled, all primitives are live.
The phase partition was a context-budget optimisation that became a behavioural cage.

**Run long.** A one-shot edit of a vlog is hundreds of operations. That needs a long
autonomous loop with progress streamed to the user, not a 16k-token turn that stops to
check in.

**Assume competence in the request.** "Edit this vlog" carries real information. The agent
should infer format, length and platform from the footage and the two answers it got, then
go — rather than interrogating the user into writing the brief themselves.

---

## 4. The part that is not about the action space at all

Honest pushback on "0 human intervention, professional output": the binding constraint is
not what the agent is *allowed* to do. It is that **the agent cannot see its own work.**

An agent with unlimited actions and no feedback produces confident garbage, faster. Every
professional edit is a loop: make a change, watch it back, react. The Director currently
does the first and third steps with the second missing — it reasons about a timeline it has
never viewed.

So the ordering matters. Give it eyes *first*:

- **Sample frames** from the rendered timeline at arbitrary times, and look at them.
- **Read the mix** — loudness curve, speech/music overlap — rather than assuming.
- **Score the cut** — `brain_activity` hook/attention/retention (see the challenge timeline
  doc), feeding `edit-critic.ts`.

Act → observe → revise. Without the middle step, more freedom is just a faster wrong answer.
With it, a narrower action space still converges on a good cut. **If only one thing gets
built this week, build the eyes, not the freedom.**

---

## 5. Sequencing

| # | Change | Why it's here |
|---|---|---|
| 1 | **Frame sampling + mix reads as verbs** | The feedback loop. Everything else is worth less without it. |
| 2 | **Collapse briefing to one clarifying turn; drop the approval ceremony** | Cheapest fix for the planner feel. Mostly deletion. |
| 3 | **`applyEdit(program)` + expose derived data** (beats, transcript timings, scenes, loudness) | The real unlock. Build it beside the existing verbs, don't cut over yet. |
| 4 | **Migrate macros to programs**, delete the verbs once parity holds | Tool list shrinks, reachable space grows. |
| 5 | **Remove phase gating** | Safe only after 3 — the gates are currently doing real context-budget work. |
| 6 | **Generation as an ordinary resource** | Mostly plumbing on the existing registry. |

**Not this week.** Items 1 and 2 are compatible with the 5-day challenge sprint; 3–6 are
the arc after it. Do not start the sandbox mid-sprint.

---

## 6. What this costs, honestly

- **A sandbox is real work** — a safe execution environment with resource bounds, a
  capability-scoped API, and no path to the network or the filesystem. This is the main
  reason item 3 is not a one-day change.
- **Programs fail in weirder ways than verbs.** A bad verb call returns a typed error; a bad
  program can loop, or make 400 edits. Bounds and a dry-run mode are not optional.
- **Evals become load-bearing.** With a fixed verb list you can enumerate what the agent
  might do. With programs you cannot, so the only way to know it still works is to run real
  scenarios. `lib/director/evals/` currently holds **one**. That has to change before item 3
  ships, not after.
- **MCP surface.** `/api/mcp` serves the same tool catalog, so the catalog shrinking is a
  breaking change for external agents. Version it.

---

## 7. One-line answer

Don't give the Director more actions — give it **fewer, more primitive** actions, the
**data** to reason over, the ability to **compose** them into programs, and above all the
ability to **see what it just made**. The creativity was never in the verb list.

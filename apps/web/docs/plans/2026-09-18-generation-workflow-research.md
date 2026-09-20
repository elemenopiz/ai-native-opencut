# How Higgsfield's Production Workflow Actually Works — and Where Byorn Diverges

**Written:** 2026-09-18
**Question:** how do the reference-first generation workflows work (characters, then setting),
and what does an AI director need to weave real footage with generated footage?

**Sourcing note.** `higgsfield.ai/blog/*` is blocked by this environment's egress policy, so
the three blog guides could not be read directly. What's below comes from: Higgsfield's own
MIT skills repo (`higgsfield-ai/skills`), a third-party MIT skills repo
(`OSideMedia/higgsfield-ai-prompt-skill`, 33 skills — community-written, **not** first-party,
treat as informed secondary), and search summaries of the blog posts themselves. Anything
marked ⚠️ is secondary and worth re-checking against the live blog.

---

## 1. The chain

Their documented master chain, in order:

```
[1] POPCORN          storyboard / keyframe images (consistent character + framing)
[2] SEEDREAM / SOUL  edit and style the keyframe
[3] ANIMATE          image → motion (Seedance / Veo / Kling)
[4] RECAST           swap character, keep motion
[5] LIPSYNC          audio performance
[6] VIBE MOTION      motion-graphic layers, titles, captions
[7] UPSCALE          delivery pass
[8] ASSEMBLE         "edit together in your video editor of choice"
```

Most short-form work uses 3–5 of the 8.

**Stage 8 is the whole story for us.** Their own pipeline terminates by handing you to
someone else's NLE. Everything upstream of that is generation; the assembly — the part that
decides whether it's *good* — is out of scope for them. That is not an oversight we can
expect them to fix, it's the shape of the product.

## 2. The part that actually matters: references before prompts

The reference-ordering intuition is right, and it's more disciplined than expected.

**References are pinned before the prompt is written.** Anything that must stay locked for
the whole video — a face, an outfit, a location, a prop, a palette — is supplied as a
reference image, *not described in text*. ⚠️ Search summaries put Seedance 2.5's ceiling at
up to 50 reference images per generation.

The rule underneath: **text drifts, references don't.** Describing a character in words
re-rolls their face every generation. Pinning the face as a reference makes identity an
input rather than a hope. So the order is: establish the character reference → establish the
setting reference → only then write prompts, which describe *what changes* rather than
re-describing what the references already fix.

Byorn's `identity-lock.ts` / seed-lock already embodies this. The gap is that it isn't the
Director's default reflex.

## 3. The methodology upstream of any tool

Before any generation, nine fields get locked:

> project type · main subject · visual style · scene goal · audience · mood · length ·
> setting · **what must stay consistent**

The last one is called load-bearing, and the reasoning is sharp: *"if you don't know what
must stay consistent across the project, every other field can be locked and the result will
still feel disjointed."*

Then: a **master script** (scene order, characters, camera rules, continuity rules, and an
explicit "what should never happen"), a **project bible**, **one job per scene**, reusable
**prompt modules**, and building **in passes** rather than shot-by-shot.

The diagnosis they give for skipping this is exactly Byorn's Director failure mode:
*"a project assembled prompt-by-prompt drifts on character, style, and continuity within
three or four generations."*

## 4. Byorn already has the machinery. It's missing the discipline.

This is the useful finding — almost every concept maps onto something already built:

| Their concept | Byorn's existing mechanism |
|---|---|
| Nine locked fields | `director-brief.ts` (the brief was widened in P1) |
| Project bible | `project-bible.ts`, `getProjectBible`, `approveHeroShot`, `revertBibleCheckpoint` |
| "What must stay consistent" | `ConsistencyContext`, `StyleBible.palette` / `lensMood`, `setConsistencyContext` |
| Master script | the story engine (SE-1…SE-4: typed artifacts → treatment → assembly → `draftCut`) |
| Prompt modules | `lib/studio/playbooks/` + the `readPlaybook` verb |
| Reference-pinning | `identity-lock.ts`, seed-lock, `intakeReferences` |
| Build in passes | the staged story-engine pipeline |

Nothing here is a missing capability. What's missing is that these are *available* to the
Director rather than *required* of it. The bible exists but nothing forces it to be written
before generation starts; consistency context exists but nothing forces it to be set before
shot 1.

**So the fix is sequencing and defaults, not new features** — which is the same conclusion
the autonomy doc reached from the other direction.

## 5. What nobody in that ecosystem does — and it's the thing you actually want

⚠️ Worth being precise, because the name collides: Higgsfield's **"Mixed Media"** is an
artistic *style-overlay* preset library (Noir, Sketch, Particles, Wireframe, Comic…) — photo
to art. It is **not** mixing real footage with generated footage.

Nothing in either skills repo covers weaving real footage with AI shots. Their pipeline is
generation end-to-end, then export to an editor. The reason is structural: deciding *"this
moment needs a B-roll shot that doesn't exist, generate one and cut it in here"* requires
simultaneous knowledge of the real footage (what's in it, where it sags, what it's missing)
and of generation. You need an NLE that understands both. They don't have an NLE.

**Byorn does.** So the "weave real and AI" director isn't a feature to catch up on — it's
unoccupied ground that only an AI-native editor can stand on.

The capability list for it is already mostly present: local Whisper transcript, local CLIP
visual search, scene detection, beat grid, the generation registry, generative-slot timeline
and takes. What's missing is the *judgment* — the Director deciding, unprompted, that a
generated shot would improve this specific cut. That judgment needs the feedback loop from
the autonomy doc (§4): it cannot know a moment is weak if it cannot watch the cut back.

---

## 6. What to do with this

1. **Make reference-pinning the Director's default**, not an option. Character reference,
   then setting reference, then prompts that describe only what changes. Prompts should stop
   re-describing anything a reference already fixes.
2. **Require the brief before generation.** Nine fields, with "what must stay consistent"
   mandatory. It exists in `director-brief.ts`; make it a gate, cheaply — the 2–3 clarifying
   questions are exactly this.
3. **Write the consistency context before shot 1**, not after drift appears.
4. **Generate in passes.** Rough pass → review → refine, which the story engine already
   stages but the Director doesn't reliably use.
5. **The weave is the differentiator.** "Find the weak stretch in real footage and generate
   B-roll to cover it" is a demo beat nobody else in that ecosystem can produce. It depends
   on `watchBack` landing first.

**Poach status:** nothing has been taken into the codebase from
`OSideMedia/higgsfield-ai-prompt-skill` yet — this document is research only. If prompt text
or structure from it lands in a playbook, it needs its own `POACH-LEDGER.md` row (MIT,
O-Side Media) separate from the existing `higgsfield-ai/skills` row.

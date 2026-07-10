# Reimagined Director Workflows

**The flagship strategy doc for Byorn's Director.** What the product becomes when the model can
SEE every asset and REMEMBER every decision — five inverted workflows, the three artifacts that
enable them, the competitor features we combine into structural gains none of them can match, and
the build order that gets us there.

> Every competitor claim in this doc is cited to a poach doc in `apps/web/docs/poach/`. Every
> "we have this today" claim is cited to a real file path. If a sentence isn't traceable, it
> doesn't belong here.

---

## 1. The paradigm shift: from librarian to director-of-taste

Every video editor ever built — ours included, until now — was designed around two disabilities
of the machine:

1. **The model is blind.** It cannot look at a clip and know it's the rooftop b-roll, the
   founder's face, the third near-duplicate of the product close-up. So the human catalogs,
   scrubs, renames, tags, and drags. The human is the librarian.
2. **The model is amnesiac.** It cannot remember that on Tuesday you decided the grade is warm
   amber with teal shadows, that the spokesperson is Mara, that the client hates slow zooms. So
   the human re-explains, every session, forever. The human is also the archivist.

Timelines, bins, tag panels, search boxes — the entire furniture of an NLE is a prosthetic for
those two disabilities. Remove them and the furniture is wrong.

Both constraints are now removable. A VLM can look at footage and produce captions, roles, faces,
and style reads — not just embeddings, actual comprehension (we already run the output half of
this: `apps/web/src/lib/director/vision-critic.ts` feeds a generated take's frames back to the
model as images for a pass/reroll/remix verdict). And a persisted document — which we already
ship in embryo as the `DirectorBrief` on `TProject`
(`apps/web/src/lib/director/director-brief.ts`) — can carry every creative decision across turns,
reloads, and projects.

**When the model can see every asset and remember every decision, the human stops being the
librarian and becomes the director-of-taste.** The division of labor inverts:

- **The machine does everything mechanical:** understanding footage, retrieval, continuity,
  self-review, failure recovery, re-tagging, assembly drafts.
- **The human does the three things machines shouldn't:** express intent, react to proposals,
  and approve at the gates that need judgment or carry liability.

Labor moves to the machine. Taste stays with the human. The old workflows were shaped by the
model's blindness and amnesia; the five workflows below are what the same product looks like with
those constraints deleted.

No competitor has made this inversion, because each is missing at least one leg. Vyra sees
footage but has no identity layer and no persisted creative memory
([vyra doc](poach/vyra-mcp-editor-poaches.md) §2 — "nothing on character consistency, seed-lock,
or persona"). Descript remembers everything in a persisted Project→Composition→Scene→Layer
document but is "structurally blind to non-verbal, multi-track, and generative-iteration editing"
([descript doc](poach/descript-underlord-poaches.md) §2). Higgsfield knows a face better than
anyone — 20–80 photos, a trained identity — but by its own copy has "no timeline"
([higgsfield doc](poach/higgsfield-soul-id-poaches.md) §2). Palmier samples footage shot-aware
and measures color numerically but is Mac-desktop-locked and GPL
([palmier doc](poach/palmier-search-compositing-poaches.md), license boundary;
[landscape doc](poach/competitive-landscape-2026.md) §2). Runway abandoned its timeline outright
([runway doc](poach/runway-poaches.md) §0 — editor "no longer being actively maintained").

We have the legs. This doc is about standing them up together.

---

## 2. The three enabling artifacts

Three artifacts carry the whole strategy. Two exist in partial form in the repo today; one is
new. Everything in §3 stands on these.

### 2.1 The Understanding Pass — comprehension as a background reflex

**What it is:** the moment media enters the library, a background pass produces full
comprehension of it — caption, role classification (hero / b-roll / logo / product / face),
face→persona reconciliation, style probe (palette, lens, mood), near-duplicate grouping, and
shot-splitting for multi-shot sources. Not a button. Not an "indexing…" progress gate. A reflex.

**What exists today:** more than half of it. `apps/web/src/services/search/embedding-service.ts`
already auto-indexes every asset in the background: frames sampled every
`DEFAULT_SAMPLE_INTERVAL_SEC` (2s), capped at `MAX_FRAMES` (120), embedded with CLIP ViT-B-32
into IndexedDB, plus zero-shot tags. The Director is already wired to it — `searchMedia` in
`apps/web/src/lib/director/director-api.ts` ranks the index by cosine similarity and `addClip`
closes the search→place loop. And `apps/web/src/lib/director/reference-intake.ts` proves the
VLM-comprehension pattern on the input side: the `intakeReferences` verb sends 1–6 dropped
reference images to the model as real image blocks and gets back a structured `StyleBible` plus
an optional `DerivedPersonaSketch` (name, physical descriptor, best face-anchor index) — failing
safe to an empty derivation rather than fabricating a look.

**What's missing — and it's exactly the gap the Vyra doc names (§4):** our tags come from a
fixed 20-label closed vocabulary (`ZERO_SHOT_LABELS` in
`apps/web/src/lib/search/embedding-types.ts`: outdoor, indoor, face, b-roll, product shot…) and
are computed from **only the first sampled frame** — one tag set per asset, no per-scene tags, no
person/face tagging, no captions, no role assignment. Vyra advertises ~18 open object+person tags
per clip; that's the bar. The Understanding Pass is the existing indexer widened: VLM caption +
role per asset, a face-embedding pass reconciled against the persona roster, per-shot tagging
using Palmier's luma-grid shot-split technique (below), and dedup grouping via the
`findDuplicates` cosine pass we already exceed Vyra on
([vyra doc](poach/vyra-mcp-editor-poaches.md) §4 table).

**The problem it fixes:** today the Director's comprehension of the library is a keyhole. Fixed
labels, first frame only, no faces — so "use the founder shots" is a guess, not a lookup.

### 2.2 The Asset Manifest — the library that describes itself

**What it is:** the queryable, compact output of the Understanding Pass — one structured record
per asset: caption, role, people (persona ids), style read, shot list, duplicate group,
provenance. The Manifest is what the Director actually reads when it plans; the raw embeddings
are how it searches.

**What exists today:** the raw material but not the artifact. Embedding records and tags persist
per-asset in IndexedDB (`MediaEmbedding` with `frames` + `tags`, `embedding-service.ts`), but the
Director's per-turn view of the library is `getProjectInfo` in `director-api.ts` — which caps at
`CONTEXT_LIST_CAP = 5` personas and the **5 most recent asset names**. Drop 30 assets and the
agent's standing context knows five filenames. That cap is the right instinct (keep the
once-per-turn prompt cheap) applied to the wrong data: five raw names is thin; thirty one-line
Manifest entries — `#12 rooftop b-roll · dusk, warm · 14s, 3 shots` — is both cheaper per unit of
meaning and sufficient to plan a whole reel from.

**The problem it fixes:** Flow B (propose-first) is impossible when the planner can't see the
inventory. The Manifest is the difference between "generate me 6 shots" and "shot 1 is your
rooftop b-roll, shot 3 doesn't exist yet — generate it."

### 2.3 The Project Bible — one document both parties read and write

**What it is:** a single persistent creative-brief document — look, cast, setting, intent,
constraints, decisions-so-far — that the human can open and edit like a doc, and the Director
reads every turn and writes back to when a decision is made. Versioned, so "go back to Tuesday's
look" is a click.

**What exists today:** three fragments with a durability fault line between them.

- **Durable:** the `DirectorBrief` (`director-brief.ts`) persists on the active `TProject` —
  goal, audience, tone, a one-line style bible, dos/don'ts, and up to `MAX_BRIEF_NOTES = 12`
  learned notes, folded into the agent's system prompt every turn via `summarizeBrief`. A stated
  preference already survives a reload. This is the seed of the Bible, shipped.
- **Evaporating:** the two richest artifacts are deliberately session-only. The reel-level
  `ConsistencyContext` (STYLE/CHARACTERS/SETTING block prepended to every shot's provider call,
  `consistency-prompt.ts`) and the `StoryboardPlan` (per-shot intent/camera/subject/duration plus
  the structured `StyleBible`, `storyboard-plan.ts`) both live in a `WeakMap` keyed by
  `EditorCore` — "naturally GC'd with the editor," as the code comments say. Close the tab and
  the Director forgets the plan it authored and the look it was enforcing.

The Bible **replaces the evaporating WeakMap state rather than patching it**: promote
`ConsistencyContext` and `StoryboardPlan` into the same persisted, versioned layer the
`DirectorBrief` already lives in, and render all three as one human-editable document. Descript
proves the pattern is right — their entire agent maturity rests on a persisted
Project→Composition→Scene→Layer doc with per-turn checkpoints and a Version History panel
([descript doc](poach/descript-underlord-poaches.md) §2, §4 #3). Their doc records *transcript*
state; ours records *creative intent* — which is the version that matters for generative work.

**The problem it fixes:** amnesia. Edit one Bible line ("grade is now colder") and every future
shot inherits it through the existing `withConsistencyContext` path — today that edit dies with
the session.

---

## 3. The five workflows

Each flow: the experience, the artifacts it stands on, and the competitor it beats.

### Flow A — Ingest IS understanding (zero-wait comprehension)

**The experience.** Drop 30 assets. An understanding pass fires immediately in the background —
caption, role, face→persona, style probe, dedup, shot-split. There is no "indexing…" gate, no
tagging chore, no moment where the user is asked to describe their own footage. By the time the
user finishes typing the brief, the library already understands itself and the Manifest has
self-assembled. Comprehension is ambient, not a step.

This is not speculative UX — it's the existing behavior of `use-embedding-indexer.ts` (auto-index
every new asset in the background, already shipped per the
[vyra doc](poach/vyra-mcp-editor-poaches.md) §4 audit) upgraded from "embeddings + 20 fixed
labels from frame 0" to full comprehension. The user's only visible artifact is that search,
proposals, and the Director's answers are simply *already grounded* the moment they ask.

**Stands on:** the Understanding Pass (2.1) writing into the Manifest (2.2).

**Beats:** Vyra — their headline is "your AI understands your footage," metered as cloud
processing credits; ours runs on-device at $0 marginal cost and privately, a wedge the vyra doc
(§5.0) says to surface, not build. Also beats Descript, whose comprehension is transcript-only:
"silent reels, ASMR, gameplay, dance, product hero shots yield an empty transcript with nothing
to grab" ([descript doc](poach/descript-underlord-poaches.md) §5 #2). Our pass sees the frame,
not the words.

### Flow B — Propose-first, not assemble-first

**The experience.** The Director reads {Bible + Manifest + brief} and drafts the **entire reel**
as an editable plan that cites specific assets per shot:

> cold open: rooftop b-roll #12 · hero: product-close #4 · founder VO over #7 · outro: logo #1 ·
> shots 3 & 5: no matching asset — generate to fill the gap.

The human reacts to a draft instead of hand-placing 30 clips. Accept it and slots materialize in
order; reject a line and only that line re-plans. Role tags are what make this possible — the
planner can only say "outro: logo #1" if the Manifest knows #1 is a logo.

**This is the single biggest UX unlock in the doc**, and it is gated squarely on the Manifest +
Understanding Pass. The plan artifact already exists: `StoryboardPlan` in `storyboard-plan.ts`
carries per-shot `intent`, `camera`, `subject`, `duration`, `importance`, a budget-allocated cost
`tier`, and the materialized `slotId` — everything a citable draft needs except the ability to
cite. Today `storyboard` plans shots it will *generate*; Flow B extends the same plan to shots it
can *retrieve*, choosing per shot between library asset, generation, or both (generate-to-match
an existing asset's look). The `getBackends`/tier machinery already routes hero shots to premium
backends and b-roll to cheap ones — the same importance signal now also decides "is the library
good enough, or do we spend?"

**Stands on:** Manifest (2.2) + Understanding Pass (2.1) for citations; Bible (2.3) for the look
the plan must honor; the existing `storyboard` → `setConsistencyContext` seeding path
(`bibleToConsistencyInput`, `storyboard-plan.ts`) so plan and prompt-time consistency come from
one source.

**Beats:** everyone, because nobody can do it. Vyra retrieves but doesn't plan against a persona
or persisted intent. Descript's Underlord plans impressively — shown plan, self-review
([descript doc](poach/descript-underlord-poaches.md) §4 #3) — but "the AI only extracts exact,
contiguous blocks of text from the transcript" (user quote, §2): it cannot cite visual assets it
cannot see. Adobe's Boards→Premiere bridge is the closest gesture — order-preserving auto-sequence
of selected board assets ([adobe doc](poach/adobe-firefly-poaches.md) §4 #5) — but the *human*
selects and orders; nothing proposes. CapCut templates pre-decide structure but are static
arrangements, not plans drafted against your library ([capcut doc](poach/capcut-poaches.md) §4 #1).

### Flow C — The living Project Bible as the interface

**The experience.** One persistent creative-brief document both human and AI read and write:
look, cast, setting, intent, decisions-so-far. Reopen the project next week → full memory, zero
re-explaining; the Director greets you already knowing the goal, the grade, and why take 3 won.
Edit one line — "wardrobe is now black denim" — and every future shot inherits it, because the
Bible feeds the same `withConsistencyContext` prepend that already wraps every provider call
(`consistency-prompt.ts` → applied in `studio-executor.ts`). Versioned, so "go back to Tuesday's
look" is a click, and every Director turn that touched the Bible is a diffable entry.

It is the *interface*, not a settings panel: the fastest way to steer the whole project is to
edit the document. The Director's `updateBrief`/`chooseTake` verbs already write learned notes
back (`director-brief.ts`); the Bible makes that bidirectional loop the product's center.

**Stands on:** nothing — it IS the substrate. Flows A and B read it; D writes to it at every
approval; E is what happens when it persists across projects.

**Beats:** Descript at their own game — their per-turn checkpoints and Version History
([descript doc](poach/descript-underlord-poaches.md) §4 #3) version the *edit state*; the Bible
versions the *creative intent*, which is the thing a generative project actually needs to rewind.
Beats Runway structurally: their references are "soft suggestions" re-sent per generation with
"no persisted identity object" ([runway doc](poach/runway-poaches.md) §3 #3) — the Bible is the
persisted object. Beats Vyra, which has no creative-memory layer at all in its public surface
([vyra doc](poach/vyra-mcp-editor-poaches.md) §4).

### Flow D — Taste in the loop, labor out of it

**The experience.** The human's job collapses to three verbs:

- **EXPRESS** intent — a conversational brief, or dropped references. `intakeReferences`
  (`reference-intake.ts`) already turns "make it look like THIS" pictures into a StyleBible and
  an optional lockable persona; `styleBibleToBriefLine` already writes the derived look into the
  durable brief so it survives across turns.
- **REACT** to proposals — steer the Flow-B draft in natural language: "colder open, swap shot 2
  for the drone pass, lose the zoom."
- **APPROVE** at the gates that need judgment or carry liability: **hero-shot selection**,
  **persona lock + voice-clone consent**, **final cut**. Everything else — understanding,
  retrieval, continuity enforcement, self-review (`vision-critic.ts` already grades takes on
  motion defects and cross-shot continuity), failure recovery, re-tagging — is ambient and
  automatic.

The consent gate is not optional polish. The descript doc (§4 #4) is blunt: Descript requires a
live consent statement verified by voice-fingerprint match *and* human review before a clone is
usable, while our `/clone-voice` path "just uploads a reference WAV and saves it — no consent, no
fingerprint, no gating. This is a liability gap, not just a feature gap." Flow D closes it by
making persona-lock + voice-consent one of the three human gates — the approval moment where the
cast becomes the cast.

**Stands on:** all three artifacts. Express writes the Bible; React edits the plan; Approve
stamps both (an approval is a Bible entry — that's how decisions compound).

**Beats:** Underlord's agent UX, by going one structural level deeper. Their per-turn revert
rolls back a chat turn; our slots/takes are versioned objects, so rollback is op-level — "revert
the caption pass, keep the recut" — a superiority the descript doc itself calls out (§4 #3
mechanism note). And it beats every generator's approve-nothing firehose: Higgsfield and CapCut
hand you output; nothing in their flow distinguishes the shots that deserve human judgment from
the ones that don't.

### Flow E — Compounding memory (the moat)

**The experience.** The Bible, personas, and Manifest persist **across projects**. The Director
learns your recurring look and your locked cast; project #10 opens already knowing "your" style —
the warm-amber grade you always land on, the founder persona with her locked seed and voice
profile, the b-roll library it has already understood. Each project makes the next one faster.
Memory compounds; the switching cost compounds with it.

**Stands on:** Bible versioning (2.3) extended with a cross-project layer; the persona roster
(`usePersonaStore`, already the identity source `buildConsistencyContext` pulls from); Manifest
records that outlive a single project's timeline.

**Beats — and this is white space none of them occupy:**

- **Vyra has no persona layer** — "nothing on character consistency, seed-lock, or persona"
  ([vyra doc](poach/vyra-mcp-editor-poaches.md) §2); their index understands clips, not *your
  cast*.
- **Higgsfield has no timeline and no project memory** — Soul ID is a trained identity locked
  inside their ecosystem, non-exportable, with "no timeline" by their own page and assembly
  conceded to DaVinci/Premiere plugins ([higgsfield doc](poach/higgsfield-soul-id-poaches.md)
  §2, §4.8). They remember a face; they remember nothing about your work.
- **Descript is transcript-blind to generated characters** — no seed-lock/persona for generated
  characters across scenes; their own case study admits generated brand results "weren't close
  enough to actually use" ([descript doc](poach/descript-underlord-poaches.md) §5 #5).
- **Runway's identity is ephemeral by design** — ≤3 prompt-time refs that "drift on angle/prompt
  change," no reusable identity object ([runway doc](poach/runway-poaches.md) §4 #6).

A Director that remembers you — across sessions, across projects, cast and look and taste — is a
product none of the four can retrofit without rebuilding their data model.

---

## 4. Poach-and-combine: structural gains no single competitor can copy

The poach docs are inventories. This section is chemistry: combinations where each ingredient is
verified in a competitor, but the *compound* is something none of them can make because each is
missing one leg. For every combination: the ingredients (competitor + doc), the structural gain,
and why it's defensible.

### Combo 1 — The comprehension trio (Vyra × Higgsfield × Descript × Palmier)

**Ingredients.**
- Vyra: per-clip visual indexing with object+person tags, "18 tags generated" per clip
  ([vyra doc](poach/vyra-mcp-editor-poaches.md) §5.0–5.1).
- Higgsfield: multi-photo face intake — 20–80 anchors, quality/recency gating, identity as a
  durable artifact ([higgsfield doc](poach/higgsfield-soul-id-poaches.md) §4.1, §4.3).
- Descript: the persisted project document with per-turn checkpoints + version history
  ([descript doc](poach/descript-underlord-poaches.md) §2, §4 #3).
- Palmier: shot-aware adaptive sampling — luma-grid fingerprint, new-shot threshold, coverage
  floor, best-per-shot dedup ([palmier doc](poach/palmier-search-compositing-poaches.md),
  Search §1; GPL — reimplement the idea, never the code).

**The compound:** the Understanding Pass + Manifest + Bible trio (§2) — which unlocks
propose-first editing (Flow B). Vyra's tags without persistence can't plan; Descript's
persistence without vision can't see; Higgsfield's faces without a library have nothing to find;
Palmier's sampling without an agent has nobody to tell. Together they are the machine that reads
{Bible + Manifest + brief} and drafts the whole reel with citations.

**Defensible because:** each competitor would need the other three legs. Vyra needs an identity
layer and a persisted doc; Descript needs to abandon the transcript spine (their moat *and* their
ceiling — descript doc §6); Higgsfield needs to build an editor it has publicly conceded to
Adobe/Blackmagic; Palmier needs to leave macOS. We need to widen an indexer we already ship,
on-device and free — the two properties (private, $0 marginal) the landscape doc (§4.3) lists as
already-uncopied.

### Combo 2 — The cast that sounds like itself (Descript × Higgsfield × our voice-lock)

**Ingredients.**
- Descript: Overdub-style regenerate-a-spoken-word via word-timestamp splice, Studio-Sound-class
  enhancement, and — critically — the consent gate: fingerprint + spoken consent before any clone
  ([descript doc](poach/descript-underlord-poaches.md) §4 #4–#7).
- Higgsfield: the *negative* ingredient — their lip-sync/audio "tops out at 5–10s per clip" with
  no cross-clip sequence ([higgsfield doc](poach/higgsfield-soul-id-poaches.md) §2, §5 #5).
- Ours, already in the repo: `VoiceProfile` + `voiceLockFragment` + `withVoiceLock` in
  `consistency-prompt.ts` — a character's vocal identity restated per TTS beat, recorded on the
  take's `GenerationSpec.voiceLock` next to seed-lock, resolved per persona via
  `getVoiceProfileForPersona`.

**The compound:** the persona becomes face AND voice, locked together, consented once at the
Flow-D gate, enforced across an entire multi-track reel. "Fix the word she said in shot 4"
regenerates in her locked voice; "give shot 6 a VO" uses the same cast member automatically.

**Defensible because:** it hangs voice on a persisted persona object. Descript can clone *the
user's own* voice but has no persona for generated characters (§5 #5); Higgsfield has the
character but no timeline to sync across. Only a product with both a persona store and a real
multi-track NLE can offer a *cast* rather than a narrator.

### Combo 3 — The export that remembers how it was made (Adobe × Runway × CapCut failures × our provenance)

**Ingredients.**
- Adobe: Content Credentials "break on the first re-encode / YouTube upload"
  ([adobe doc](poach/adobe-firefly-poaches.md) §5 #8).
- Runway: the C2PA paradox — source credentials vanish once footage is edited, while their
  background-removal signature has been reported to wrongly persist
  ([runway doc](poach/runway-poaches.md) §4 #5).
- CapCut: C2PA manifests "trivially stripped by a single ffmpeg remux"
  ([capcut doc](poach/capcut-poaches.md) §5 #7).
- Landscape doc: NLE XML export + provenance sidecar is already our named Sprint-3 move —
  "their XML loses all generation provenance; ours can carry a sidecar"
  ([landscape doc](poach/competitive-landscape-2026.md) §1 Tier 2, §6 #10).

**The compound:** export Premiere/DaVinci/FCPXML **plus a sidecar carrying seed, prompt, model,
persona, and the Project Bible itself.** The cut opens in any pro NLE, and the *project* — every
generative decision — survives the trip. Round-trip back into Byorn and regenerate any shot in
place. The whole industry's provenance breaks at export; ours is the export.

**Defensible because:** it requires per-clip generation records to exist at all. Transcript
editors and footage-first NLEs have nothing to write into the sidecar; generators have no
timeline to export. Only a generation-native timeline with takes-as-versions produces the data
this format carries.

### Combo 4 — Regenerate-in-place, now with eyes (Runway × Adobe × Descript × our takes)

**Ingredients.**
- Runway: Aleph 2.0's crown jewel — edit one frame, propagate the change across the clip
  ([runway doc](poach/runway-poaches.md) §3 #2) — currently landing in a bin because their
  timeline is abandoned (§0).
- Adobe: first/last-frame anchors a generated clip must hit
  ([adobe doc](poach/adobe-firefly-poaches.md) §4 #9), and background non-blocking generation
  (§4 #7).
- Descript: the self-review pass that diffs result against request and re-invokes to fix
  ([descript doc](poach/descript-underlord-poaches.md) §4 #3).
- Ours: takes-as-clip-versions + seed-lock, plus `vision-critic.ts` already grading takes on
  temporal defects and cross-shot continuity against `styleBibleDescriptors`
  (`storyboard-plan.ts`).

**The compound:** "AI Edit" as a clip context action — edit the frame, propagate, and the result
lands as a **new take on the same clip**, seed-lock respected, Bible enforced, vision-critic
verified, revertible per-op. The runway doc says it plainly: this lands "strictly better than
Runway's because we have a real timeline and they don't" (§3 #2) — we know shot boundaries
because they're our slots; Aleph has to detect them.

**Defensible because:** Runway ceded the timeline category in writing (§0); Adobe's only
timeline-native gen is a +2s extend into a two-app shuffle that "loses take history at import"
([adobe doc](poach/adobe-firefly-poaches.md) §2, §6). The take stack is the primitive neither
has, and neither can add it without rebuilding their editing model.

### Combo 5 — The private agent (Vyra × Runway × our on-device index)

**Ingredients.**
- Vyra: proof the MCP-editor market is real and paid — and that its visual index is metered as
  cloud processing credits ([vyra doc](poach/vyra-mcp-editor-poaches.md) §1, §5.0).
- Runway: the proven MCP shape — Streamable HTTP, OAuth-over-API-key, curated workflow-shaped
  tools ([runway doc](poach/runway-poaches.md) §3 #1).
- Ours: the on-device CLIP index already agent-wired (`searchMedia`/`addClip` in
  `director-api.ts`, in the shared `toolCatalog()` feeding the Sprint-2 MCP surface — vyra doc
  §4), plus per-project token auth already hardened on main.

**The compound:** *"the agent that sees your footage without your footage leaving the machine."*
External agents over MCP get retrieval, proposals, and edits grounded in an index that never
left the browser and costs $0 per query. Claude Code drives your timeline; your rushes stay
yours — a direct counter to CapCut's perpetual-license ToS grab
([capcut doc](poach/capcut-poaches.md) §5 #1) and Vyra's metered indexing.

**Defensible because:** Vyra's business model *is* the meter; going free-and-local breaks their
pricing. Palmier is on-device but Mac-only. We're the only web-reach product where "private" and
"agent-accessible" coexist — the landscape doc's white-space #3 pointed at the MCP lane.

### Combo 6 — The Bible gets instruments (Palmier × our vision critic × the StyleBible)

**Ingredients.**
- Palmier: the scopes engine — percentile black/white points, per-zone RGB, warm/cool bias, hue
  histogram: "what lets a text-only agent 'see' a color cast numerically instead of guessing from
  a thumbnail" — and the Apache-2.0 color-grading Skill's discipline: inspect before grading,
  match other shots to a graded hero by closing a numeric `gap`
  ([palmier doc](poach/palmier-search-compositing-poaches.md), Compositing §1 + Skill section;
  scopes = idea reimplementation, Skill = copyable with attribution).
- Ours: `vision-critic.ts` (VLM eyes on output) and the `StyleBible` (`storyboard-plan.ts`),
  whose `palette` line today is enforced only as prose in a prompt.

**The compound:** the Bible's look becomes a **measurable target**. Approve a hero shot (Flow D
gate) → scope it → every subsequent shot, generated or imported, is measured against those
numbers and either re-rolled (generation-side, via the critic) or graded toward the hero
(render-side, via the gap/hints loop). Look enforcement stops being hoped-for and becomes
closed-loop.

**Defensible because:** it needs both halves of the pipeline. Generators can't grade what they
render into your NLE; editors can't re-roll what they didn't generate. Only a product that owns
generation *and* rendering can close the loop in both directions — and Palmier, who owns the
scopes idea, has no generative persona/Bible to point them at.

### Combo 7 — Templates that carry a cast (CapCut × the Bible × personas)

**Ingredients.**
- CapCut: template-as-locked-slot-arrangement + the shareable remix link, their #1 distribution
  mechanic — which maps "structurally identical" onto our slot/take timeline
  ([capcut doc](poach/capcut-poaches.md) §4 #1–#2).
- CapCut's negative ingredient: Director Mode, their character-consistency answer, is "100%
  press-release… CapCut's own copy admits continuity is unsolved" (§2).
- Ours: the Bible + persona roster.

**The compound:** a shared Byorn arrangement carries not just pacing and structure but a
**StyleBible and empty persona slots**: open the link, drop in *your* cast and *your* product,
and the template regenerates around your identities with the look intact. CapCut templates swap
clips; ours swap casts.

**Defensible because:** the swap-your-cast move requires a persona layer CapCut has only press-
released, and a web no-login remix link their mobile-app deep-link flow can't match
([capcut doc](poach/capcut-poaches.md) §4 #2, §5 #4).

---

## 5. The competitive matrix

Columns are the capabilities the five workflows require. ● = shipped/verified in the poach docs,
◐ = partial or press-release, — = absent. Byorn column marks (●) where the leg exists in-repo
today and (○) where this doc's build makes it real.

| Capability → | Visual understanding of footage | Person/identity layer | Persisted creative memory | Real multi-track timeline | Propose-first drafting | Regenerate-in-place (takes) | Agent surface (MCP) | Cross-project memory | On-device / private | Cross-platform web |
|---|---|---|---|---|---|---|---|---|---|---|
| **Vyra** | ● (embeddings + ~18 tags/clip, cloud-metered) | — ("nothing on… persona", §2) | — | ● | — | — | ● (their whole product) | — | — (credit-metered) | ◐ (client-agnostic MCP; editor closed SaaS) |
| **Descript** | — (transcript-blind, §2) | ◐ (own voice only; no generated-character persona, §5 #5) | ● (Project→Comp→Scene→Layer + checkpoints) | ◐ (timeline is a derived projection, §2) | ◐ (shown plan, transcript-scope only) | — (linear undo / one-shot fan-out, §5 #4) | ● (single NL endpoint) | — | — | ● |
| **Higgsfield** | — (generator, no library) | ● (Soul ID, trained, 20–80 photos — the fidelity bar) | — | — ("no timeline," their own page) | — | — | — (no training API, §4.9) | ◐ (identities persist, locked in their cloud) | — | ◐ (web+mobile gen, no editor) |
| **Palmier** | ● (shot-aware sampling, SigLIP2 on-device) | — | — | ● | — | — | ● (local MCP) | — | ● | — (macOS/Apple-Silicon only) |
| **Runway** | ◐ (model-side; no library index) | ◐ (≤3 soft refs, drift, no persisted object, §4 #6) | — | — (officially abandoned, §0) | — | ◐ (Aleph propagate → lands in a bin) | ● (hosted MCP) | — | — | ● |
| **Adobe** | ◐ (Boards; no role/persona index) | — (character consistency = #1 unmet ask, §5 #1) | ◐ (Boards as moodboard, not agent-written) | ● (Premiere) | ◐ (order-preserving board→sequence, human-selected) | — (loses take history at import, §6) | — | — | — | — (Win/Mac desktop) |
| **CapCut** | ◐ (analytical AI: highlights/reframe) | ◐ (Director Mode = press release, §2) | — | ● | — (templates are static) | — | — | — | — (mandatory login, cloud) | ◐ (web is the "lite" surface) |
| **Byorn** | (●) index + searchMedia shipped; (○) captions/roles/faces | (●) personas + seed-lock + voice-lock wired | (●) DirectorBrief persists; (○) Bible absorbs WeakMap plan/context | (●) | (○) Flow B — gated on Manifest | (●) slots/takes/seed-lock end-to-end | (●) Sprint-2 MCP, token-auth | (○) Flow E | (●) CLIP + Whisper local, $0 | (●) |

Read the rows and the thesis falls out: **every competitor is one-to-three legs short, and the
legs they're missing are the expensive, data-model-deep ones.** Read the Byorn column and the
build is mostly promotion and widening of things already in the repo — which is why the
sequencing below is short.

---

## 6. Build sequencing

The dependency graph, not a backlog. Effort keys as in the poach docs (S=hours, M=1–3 days,
L=1–2 weeks).

```
Bible persistence (1) ──────────────┐
                                    ├──► Flow C live ──► Flow E (6)
Understanding Pass (2) ──► Manifest (3) ──► Flow B propose-first (4)
        │                                          │
        └── Flow A live (nothing else needed)      └──► Flow D gates (5)
```

1. **Bible persistence — the cheapest high-relief move (S–M).** Promote `ConsistencyContext`
   and `StoryboardPlan` from the `WeakMap` registries (`consistency-prompt.ts`,
   `storyboard-plan.ts`) into the already-persisted `DirectorBrief` layer on `TProject`
   (`director-brief.ts` + `editor.project.updateDirectorBrief`), and add version snapshots. The
   persistence rails exist; this is a promotion, not an invention. Payoff is immediate and
   user-visible: reopen next week, the Director remembers. Flow C ships here.

2. **The Understanding Pass — the keystone (M–L).** Everything downstream eats its output.
   Widen `embedding-service.ts`: per-scene tags via Palmier's luma-grid shot-split (idea
   reimplementation, palmier doc Search §1) instead of first-frame-only; open-vocab + VLM caption
   and role per asset; a face pass reconciled against `usePersonaStore` — the person-tagging the
   vyra doc (§5.1) calls "the one worth building, because it feeds persona/seed-lock, which Vyra
   cannot do at all." The VLM framing pattern is already proven in `reference-intake.ts` /
   `vision-critic.ts`; this points the same eye at the library. Flow A ships here.

3. **The Asset Manifest (M).** A derived, compact view over pass output; replace the
   `CONTEXT_LIST_CAP = 5` recent-asset keyhole in `getProjectInfo` (`director-api.ts`) with
   role-tagged one-liners, and add a `getManifest` verb for full listings on demand.

4. **Flow B — propose-first (L).** Extend `storyboard` to plan retrieve-vs-generate per shot,
   citing Manifest entries; render the plan as the editable draft the human reacts to. Gated on
   2+3; the plan/budget/slot machinery already exists in `storyboard-plan.ts`.

5. **Flow D gates (S–M each).** The consent-gated voice clone (fingerprint + consent phrase —
   descript doc §4 #4, flagged there as our open liability) and explicit hero-shot / final-cut
   approval moments that write their rationale into the Bible via the existing `chooseTake` /
   `appendBriefNote` path.

6. **Flow E — cross-project memory (M–L).** A user-level layer over Bible + personas +
   Manifest defaults; new projects open pre-seeded. Last because it compounds everything before
   it and requires nothing the others don't already build.

Two sequencing rules worth stating out loud. **First:** items 1 and 2 are independent — start
both now; 1 lands in days and makes every demo better. **Second:** do not let Flow B start before
the Manifest exists. Propose-first with a keyhole view is the demo that hallucinates asset
citations, and one hallucinated "#12 rooftop b-roll" costs more trust than the feature earns.

---

## 7. The white space, plainly

The landscape doc (§4) named the unoccupied position: cross-platform browser + real timeline +
on-timeline generation + a timeline-editing agent. This doc adds the second axis that makes the
position a *moat* rather than a head start: **memory**.

Every competitor is racing on generation quality or agent plumbing — both of which commoditize.
Runway's models will get better and so will everyone's, via the same adapters
([runway doc](poach/runway-poaches.md) §3 #4). MCP is already "table stakes across the OpenCut
ecosystem" ([vyra doc](poach/vyra-mcp-editor-poaches.md) §2). What does not commoditize is the
accumulated, persisted, portable understanding of *your* footage, *your* cast, and *your* taste:

- **Vyra** understands clips but will never know your cast — no persona layer, and their metered
  cloud index makes "understand everything ambiently" economically hostile to their own pricing.
- **Descript** remembers everything about the words and nothing about the pictures; escaping the
  transcript spine means abandoning their moat.
- **Higgsfield** knows the face perfectly and holds it hostage — non-exportable, no timeline, no
  API — in an ecosystem whose credits expire in 90 days.
- **Runway** quit the editor in writing and designed identity to be ephemeral.
- **Adobe** aggregated 30 models and still can't keep one character's face consistent — their
  users' single loudest unmet request ([adobe doc](poach/adobe-firefly-poaches.md) §5 #1).
- **Palmier and CapCut** are locked to a platform and a business model, respectively, that
  forbid the private, web-reach, identity-carrying version of this product.

The five workflows are one sentence in the end: **an editor where comprehension is ambient, the
draft comes to you, the project remembers itself, your only jobs are intent, reaction, and
judgment — and the tenth project is easier than the first.** Each competitor can copy a feature
from that sentence. None of them can copy the sentence.

Build the Understanding Pass. Persist the Bible. Let the memory compound.

---

*Grounding sources: `apps/web/docs/poach/vyra-mcp-editor-poaches.md`,
`descript-underlord-poaches.md`, `higgsfield-soul-id-poaches.md`,
`palmier-search-compositing-poaches.md`, `competitive-landscape-2026.md`,
`adobe-firefly-poaches.md`, `runway-poaches.md`, `capcut-poaches.md` (all last verified
2026-07-09/10). Codebase grounding: `apps/web/src/lib/director/{reference-intake,
consistency-prompt, storyboard-plan, director-brief, director-api, vision-critic}.ts`,
`apps/web/src/services/search/embedding-service.ts`,
`apps/web/src/lib/search/embedding-types.ts`. Competitor claims inherit the confidence tiers and
re-check cadences of their poach docs — re-verify before any external-facing use.*

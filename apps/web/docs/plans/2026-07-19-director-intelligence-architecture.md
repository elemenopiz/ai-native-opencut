# Director Intelligence — Architecture

> The "make Director actually intelligent" mission (distinct from the 9-item revamp floor in
> `2026-07-19-director-revamp-design.md`, which this builds on top of).
> Status: ☑ ARCHITECTURE drafted 2026-07-19 · ☐ Advisor red-team · ☐ gates signed · ☐ built.
> Ambition (user, verbatim): "make it more intelligent. Way better than any competitor."

## Thesis

A "director" is intelligent to the degree it runs a real loop:
**perceive → plan → act → critique → learn.** Today Director is a *reactive tool-caller*:
prompt in, tool calls out, report. It has thin slivers of each capability but no closed loop
and no notion of "good." The floor mission (items 1–9) stops it *looking* dumb; this mission
makes it *think*. The wedge no competitor has assembled is the **integrated loop on top of our
moats** (persona/seed-lock + MCP agency + cost). Competitors each own one arc and are blind on
the rest:

| | Perceive | Judge (taste) | Act | Learn you |
|---|---|---|---|---|
| **Palmier** | shallow | ✗ | ✓ 46 tools (reliability cracking) | ✗ |
| **Runway** | ✗ | ✗ | ✓ MCP (editor abandoned) | ✗ |
| **Higgsfield** | ✗ | ✗ | one consistency trick | ✗ |
| **Vyra** | ✓ visual indexing (their moat) | ✗ | thin | ✗ |
| **Adobe FF** | catalog | ✗ | ✗ | ✗ |
| **Byorn target** | **deep, your footage** | **whole-edit taste** | **full editor + persona/seed-lock** | **preference memory** |

## Current state — what each capability already is (cite before extending)

- **Perceive:** `AssetUnderstanding` (`src/lib/search/asset-understanding.ts`) = `{ mediaId,
  caption, role(+roleConfirmed override), roleConfidence, tags, faces, styleProbe }`, produced
  by a Gemini structured-output pass, stored async in IndexedDB
  (`services/search/asset-understanding-store`), primed into a sync cache
  (`understanding-lookup.ts`) the manifest + Director context read. **Shallow** (no motion,
  emotion, audio energy, composition, continuity fingerprint) and **autorun gated OFF for beta**
  (ADR-004) — the store is usually empty, so the manifest degrades to media-type counts.
- **Judge:** `vision-critic.ts` is mature but **per-take, per-prompt**: `reviewTake` decodes a
  take's frames → `CriticVerdict` (pass/reroll/remix) with `FailureAxis` classification,
  `ContinuityContext` for cross-shot checks, `VerdictRecord`/`recordVerdict`/`recentVerdictsFor`
  (a critique memory), and `CriticPick`/`parsePick` for A/B. **No model of the whole film.**
- **Act:** broad `DirectorApi` verb surface (`director-api.ts`, 160KB) — but item 1 proves it
  can't even see a hand-built timeline. `getTimeline` (Wave 1 Part A) is the first fix.
- **Learn:** `cross-project-memory.ts` promotes the *durable* slice of a project bible
  (styleBible look, tone, dos/donts, marked notes) up to `UserBibleDefaults` and re-seeds new
  projects. **Only explicit signals** — never learns from behavior (which takes you pick vs
  reroll, which edits you keep vs undo).

The point: **none of the three bets is greenfield.** Each extends a live seam.

---

## Bet 1 — Deep perception of *your* footage (the eyes)

**What exists:** `AssetUnderstanding` (caption/role/faces/styleProbe), model-extracted, cached.
**What to add:** deepen the per-asset record into a richer, continuity-aware fingerprint:

- `motion` (static / pan / handheld / fast-cut energy), `shotType` (wide/medium/CU/…),
  `composition` (rule-of-thirds, headroom, subject position),
- `emotion`/`tone` (the felt register of the clip),
- `audio`: energy envelope + the beat grid (we already compute a beat grid — `useBeatGridStore`,
  surfaced in the manifest), speech presence (transcripts exist),
- `continuityFingerprint`: lighting/white-balance/wardrobe/color signature for match-cutting and
  identity (fuses with persona/seed-lock — **the thing Vyra can't do**).

**Seam:** extend the `AssetUnderstanding` schema + the extraction prompt (`asset-understanding.ts`),
version the IndexedDB store, widen `adaptUnderstandingForManifest` + the manifest digest so the
new facts ride the Director prompt and are queryable via `getLibraryManifest`/a deeper verb.

**One-way doors / gates:**
- **Store schema change** = a versioned IndexedDB migration (local — lighter than Postgres, but
  still a data-shape door; needs a read-time upgrade path).
- **Turning the Understanding Pass ON** is un-hiding a beta-flagged surface (ADR-004) = **HARD
  GATE** (user + advisor) — *and* a **cost** decision: it runs a vision model per asset on ingest.
  Mitigation: demand-driven (understand on first Director use of an asset, not eagerly), cache
  forever, tier the model by asset importance.

**Cost shape:** one vision pass per asset, once, cached. Bounded by library size; degrades to
today's behavior when off.

## Bet 2 — Directorial taste: a whole-edit critic (the leap)

**What exists:** `vision-critic.ts`'s frame-decode → model → `CriticVerdict` pipeline, but scoped
to one take vs its prompt.
**What to add:** a NEW sibling critic that reasons about the **assembled cut as a film**:

- Samples frames ACROSS the timeline (via `getTimeline` from Part A + `reviewTake`'s frame decode)
  plus the audio beat grid and transcript.
- Judges: **pacing** (shot durations vs energy), **hook** (is the strongest moment in the first
  ~2s?), **shot variety** (are shots 3 & 4 near-identical? — reuse the CLIP dup detection
  `findDuplicateAssets` already has), **rhythm** (are cuts on the beat?), **dead air** (gaps,
  silence), **continuity breaks** (reuse `ContinuityContext`), **emotional arc**.
- Emits a structured `EditCritique` (issues, each with a location + severity + a *proposed fix as
  an executable verb*) — then can act: trim-to-beat, reorder, cut the weak shot, tighten the open,
  all through existing `DirectorApi` verbs.

**Seam:** new `edit-critic.ts` reusing `dataUrlToImageBlock`, the verdict-parse patterns, and a new
`EDIT_CRITIC_SYSTEM_PROMPT`. Invoked as a Director tool (`critiqueEdit`) AND proactively at natural
stopping points ("you paused after a build — want notes?").

**One-way doors / gates:**
- **Cost:** decoding many frames + a vision pass over the whole timeline is the priciest new
  operation. Must be budget-gated like generation (reuse the `budget.ts` reserve→settle gate),
  frame-sampled (not every frame), and opt-in for the auto/proactive path.

## Bet 3 — Memory that learns *you* (the compounding moat)

**What exists:** `cross-project-memory.ts` distills *explicit* style/tone/notes into
`UserBibleDefaults`; `VerdictRecord` already logs critic verdicts.
**What to add:** a **preference-learning** signal from *behavior*:

- Capture the choice events already flowing through `DirectorApi`: `chooseTake` (pick),
  `reroll`/`discard` (implicit reject), `compareTake` A/B outcomes, and timeline edit
  accept-vs-undo. These are the labels.
- Distill them into a durable per-user preference model (extend `UserBibleDefaults`, or a sibling
  `UserPreferenceModel`): favored pacing, shot lengths, look/palette, energy, aspect, "always/never"
  patterns — learned, not stated.
- Fold that model into (a) future generation prompts (seed the look the user keeps choosing) and
  (b) the Bet-2 critic's rubric (critique against *your* taste, not a generic one).

**Seam:** a `preference-learning.ts` (pure distill rules, testable like `cross-project-memory.ts`)
+ a storage glue extension of `services/storage/user-memory-store.ts`; a hook at the
`chooseTake`/`reroll`/`discard` call sites to log events.

**One-way doors / gates:**
- **New persisted per-user data shape** (the preference model) = one-way door. Start **local-first**
  (rides Bet-3/item-9 persistence), promote to server later. Privacy: it's behavioral inference on
  the user's own content — keep it user-scoped, never cross-tenant.

---

## The integrated loop (how they compose)

The agent gains an explicit **quality bar** and **proactivity** instead of "done = tool returned ok":

```
perceive:  deepened AssetUnderstanding + getTimeline + beat grid + transcript  (Bet 1 + Part A)
   ↓
plan:      storyboard/intent, now grounded in what the footage ACTUALLY is + learned prefs
   ↓
act:       generate / edit via DirectorApi verbs (full-editor agency)
   ↓
critique:  whole-edit critic scores the assembled cut vs the goal AND the user's taste  (Bet 2 + Bet 3)
   ↓ (below bar?)  → propose+execute fixes, loop
learn:     pick/reject/undo events distilled into the preference model  (Bet 3)
```

Two behavior changes make it *feel* intelligent: (1) a real **"is this good enough?"** gate that
loops instead of stopping at first tool success; (2) **proactivity** — it surfaces problems the user
didn't ask about ("hook buried at 0:08; shots 3–4 near-identical; 2s dead air at 0:14 — fix it?").

## Rollout / sequencing (relative to the floor)

1. **Floor first (Wave 1, in flight):** `getTimeline` (Part A ✅ merged), chat/tab/persistence fixes.
   A brain that can't see the timeline or remember the conversation can't be intelligent.
2. **Bet 1 (perception)** is the substrate → build + test behind the existing flag; **turning it on
   is a separate user+advisor gate** (ADR-004 un-hide + cost).
3. **Bet 2 (whole-edit critic)** on top of Bet 1 + `getTimeline` + beat grid — the visible "nobody
   has this" wow. Can ship a perception-lite v1 (frames + beat grid only) before Bet 1's full index.
4. **Bet 3 (preference memory)** accrues over time; the capture hook lands early (cheap), the payoff
   compounds. Rides item-9 persistence (local→server).

## One-way doors for the Advisor red-team (this is why it goes to Advisor before build)

1. **Understanding-Pass un-hide** — beta ADR-004 froze it. Turning it on = user gate + a cost model
   (vision pass per asset). Is demand-driven + cached enough for the BytePlus/credit budget?
2. **Deepened understanding schema** — IndexedDB versioned migration + read-time upgrade; do we risk
   invalidating existing understanding records?
3. **Whole-edit critic cost** — the priciest new op. Frame-sampling + budget gate + opt-in auto path —
   is the rubric worth the spend, and does it stay inside the credit economy?
4. **Preference-learning data shape** — new persisted per-user model; local-first now, server later.
   Privacy/tenancy of behavioral inference. What's the minimal honest signal set (avoid a
   speculative over-model)?
5. **"Quality bar loop" runaway** — an autonomous critique→fix loop can burn credits chasing a bar.
   Needs a hard iteration/spend ceiling and a user-visible "good enough" stop.

## Verification plan

Per bet: pure-logic unit tests (the distill/critique rules, like `cross-project-memory.test.ts`),
then browser-verify the loop end-to-end on a real edit — the critic finds a real pacing/variety
issue on a deliberately-flawed cut and its proposed fix executes. Cost measured, not assumed. Tier
target: **verified locally**; no push.

## Non-goals

Not rebuilding the generation backends or the model router. Not a generic "AI does everything"
scope — the loop is bounded to editorial intelligence over the user's project. Not un-hiding any
beta flag without the gate. The floor mission's items 1–9 are prerequisites, tracked separately.

## Step-0 orchestrator revisions (2026-07-19, advisor-tier red-team — binding for the build)

1. **Bet 2 v1 is ADVISORY-ONLY** (door #5 closed by demotion): `critiqueEdit` emits an
   `EditCritique` with proposed *executable* verbs but never auto-executes; the autonomous
   critique→fix loop is out of scope and returns later behind its own gate with hard
   iteration/spend ceilings. Recorded as ADR-006.
2. **Bet 2 v1 has NO credits wiring** — "`budget.ts` reserve→settle" above is imprecise:
   `budget.ts` is the shot-allocation cost model; reserve→settle is the server credits path
   (money floor ⇒ gated). v1 = flag-gated, manual-invoke, ≤12 sampled frames, single model
   call; billing wiring is a separate gated follow-up branch.
3. **Bet 2 v1 is perception-lite** (frames + beat grid + transcript) — no dependency on
   Bet 1's deepened fields; Bets 1 and 2 build in parallel.
4. **Door #2 downgraded:** the understanding store is a dedicated schema-less IndexedDB
   (`byorn-asset-understanding`, DB_VERSION 1, keyPath `mediaId`); additive optional fields
   need no version bump. Policy: lazy read-time upgrade — missing fields ⇒ shallow record ⇒
   demand-driven re-extract. No migration door unless indexes change.
5. **Bet 3 shape:** sibling `UserPreferenceModel` (not an extension of `UserBibleDefaults`);
   minimal honest signals only (choice-event log + distilled counters/top-k). Split build:
   3a distill+storage (disjoint), 3b `director-api.ts` call-site hook after Bet 2 merges
   (file-cluster collision).
6. **Bet 1 brief must report measured per-extraction cost** — the ADR-004 un-hide gate
   conversation runs on a number, not a guess.

## Open design questions (for the red-team to sharpen)

- Perception depth: how much of Bet 1 is worth it for the critic vs. diminishing returns? (Name the
  minimal field set that unlocks Bet 2.)
- Critic altitude: whole-edit-only, or also mid-build "as you go" nudges? Cost tradeoff.
- Preference model: extend `UserBibleDefaults` vs. a new `UserPreferenceModel` — schema blast radius.
- Where does the "quality bar" live — a Director setting, per-project, or learned?

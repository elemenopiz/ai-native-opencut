# Propose-First Drafting (Flow B) — API & Citation Contract

**Status:** shipped on `feat/director-context`. Implements Flow B from
`docs/reimagined-director-workflows.md` §3 ("propose-first, not assemble-first")
and §6 item 4.

The Director reads **{Bible + Manifest + brief}** and drafts the **entire reel**
as an editable plan that **cites specific library assets per shot** — choosing
per shot between retrieving a library asset, generating a new shot, or generating
in a cited asset's look. The human reacts to a draft instead of hand-placing
clips.

> **The hard rule** (`reimagined-director-workflows.md` §6, sequencing rule 2):
> a hallucinated `#12 rooftop b-roll` costs more trust than the feature earns. A
> plan may cite **only** asset ids that resolve against the real index; any
> citation that doesn't resolve is **repaired to `generate`**, never silently
> kept. See [Citation-validation contract](#citation-validation-contract).

Everything is pure, testable logic in
[`src/lib/director/reel-proposal.ts`](../src/lib/director/reel-proposal.ts) with a
thin service shell (the verbs) in
[`src/lib/director/director-api.ts`](../src/lib/director/director-api.ts). The
existing `storyboard` verb is unchanged and still works.

---

## The plan shape

A `ReelProposal` is the editable **draft** (session state, not persisted until
accepted). Each `ProposedShot` carries a **`source` decision** and, when it
retrieves or matches, a grounded **`citation`**.

```ts
type ShotSource = "library" | "generate" | "generate-to-match";

interface AssetCitation {
  mediaId: string;              // FULL media-library id — the ONLY safety-critical field
  ref?: string;                 // "#N" library position — filled from the resolver
  caption?: string;             // Understanding caption — filled from the resolver, NEVER the model
  role?: string;                // hero/product/logo/face-anchor/b-roll — from the resolver
  name?: string;                // filename — from the resolver (caption fallback)
  matchScore?: number;          // the searchMedia score the author saw (retrieve-vs-generate hint)
  sourceShotIndex?: number;     // for a multi-shot source asset, which sub-shot (clamped on validate)
  timeRange?: { start: number; end: number }; // seconds within the source asset
}

interface ProposedShot {
  index: number;                // 1-based
  source: ShotSource;           // post-validation (repairs applied)
  citation?: AssetCitation;     // present iff source is library | generate-to-match
  prompt: string;               // generation prompt (generate/g2m); description (library)
  intent?; camera?; subject?;   // storyboard-style creative notes
  duration: number;             // seconds
  importance?: "hero" | "support" | "broll";
  elementId?: string;           // materialized id, set on acceptProposal
}

interface ReelProposal {
  shotCount: number;
  shots: ProposedShot[];
  bible: StyleBible;            // seeds the consistency context on accept
  totalDuration: number;
  budget?: ReelBudget;         // allocated across the GENERATE shots (library shots are $0)
  repairs: CitationRepair[];   // citations that didn't resolve and fell back to generate
  createdAt: number;
}
```

### The three sources

| Source | Meaning | Materializes via | Cost |
|---|---|---|---|
| `library` | **Retrieve** — place the cited asset verbatim | `addClip({ mediaId })` | $0, instant |
| `generate` | No matching asset — render from a prompt | `addGenerativeSlot` (the storyboard path) | tier-priced |
| `generate-to-match` | **Generate** conditioned on a cited asset's look | `addGenerativeSlot` with the cited asset URL as an omni-reference (`spec.referenceImages`) | tier-priced |

### Retrieve-vs-generate allocation (`decideShotSource`)

The same importance signal that routes hero→premium / b-roll→cheap now also
decides "is the library good enough, or do we spend?":

- **No candidate** ⇒ `generate` (nothing to retrieve).
- **`hero` + candidate** ⇒ `generate-to-match` — a hero justifies generation
  spend but inherits the cited look.
- **`broll` + any candidate** ⇒ `library` — b-roll prefers retrieval (free,
  instant), forgiving of a loose match.
- **`support` + strong candidate** (score ≥ `DEFAULT_MATCH_THRESHOLD`, or no
  score) ⇒ `library`; a **weak** support candidate ⇒ `generate`.

A missing `matchScore` is treated as **trusted** (the author grounded it
deliberately, e.g. by role from the manifest). When the author omits `source`
entirely, it is derived by this rule from `importance` + whether a citation is
present.

---

## Verbs

Registered in [`tool-catalog.ts`](../src/lib/director/tool-catalog.ts) (the single
source of truth consumed by both the in-app agent loop and the external MCP
server). All descriptions teach the retrieve-vs-generate decision and the
no-fabricated-citations rule.

### `proposeReel({ shots, bible?, budgetUsd? })` — mutating

Draft the whole reel. Builds the proposal, **grounds every citation** against the
real index (repairs unresolved ones to `generate`), allocates the budget across
the generate shots for the draft's spend line, and stores the draft **pending**
(nothing is placed on the timeline). The result `message` **is** the rendered
markdown draft the human reads; `data.proposal` is the structured plan.

Each shot: `{ source?, citation?: { mediaId, matchScore?, sourceShotIndex? },
prompt?, intent?, camera?, subject?, importance?, duration? }`. The model must
**ground citations first** via `searchMedia` / `getLibraryManifest` and cite only
mediaIds it actually found.

### `reviseProposal({ index, ...patch })` — mutating

Re-plan **one line** and leave the rest **stable**. `index` is 1-based; the patch
may change `source` / `citation` / `clearCitation` / `prompt` / `intent` /
`camera` / `subject` / `importance` / `duration`. Every **other** shot is
preserved by reference (byte-for-byte). A swapped-in citation is re-validated (a
fabricated swap-in is repaired). Fails with no pending draft or an out-of-range
index.

### `acceptProposal({ seedConsistency? })` — mutating

Materialize every shot **in order**: library shots via `addClip`, generate /
generate-to-match shots as generative slots (g2m attaches the cited asset URL as
an omni-reference so generation inherits its look). Re-validates against the
**current** index first (assets may have changed since drafting), then:

1. persists the accepted plan as the durable `StoryboardPlan`
   (`storePlan` → read back off `getReel().plan`),
2. arms the reel budget if the draft carried one,
3. seeds the reel consistency context from the bible via `bibleToConsistencyInput`
   (unless `seedConsistency: false`), and
4. **write-throughs to the versioned Project Bible** (`syncBible`) — the accepted
   plan becomes a checkpointed, revertable bible state.

Then clears the pending draft. All materialization is one undoable transaction.

### `getProposal()` — read-only

Read the pending draft (the `message` is the rendered draft) without changing it.

---

## Citation-validation contract

`validateProposal(proposal, resolve)` (and its per-shot core `validateShot`) is
the **grounding gate**. It is pure and runs before a draft is shown *and* before
it is accepted.

`resolve: AssetResolver = (mediaId) => ResolvedAsset | undefined` is implemented in
`director-api.ts` (`resolveAssetForCitation`) over the **real index**:

- **Existence** = the media store (`editor.media.getAssets()`). A fabricated id
  is not found ⇒ `undefined`.
- **Enrichment** (`caption`/`role`) = the injected **Understanding Pass** lookup
  when present; **absent ⇒ the citation is still valid, just captionless** —
  grounding degrades gracefully when the understanding pass is still running or
  partial.
- **`ref`** = the asset's 1-based library position (`#N`).

For each shot whose source needs a citation (`library` / `generate-to-match`):

| Situation | Outcome |
|---|---|
| No `mediaId` cited | **Repair** → `generate`, citation dropped, `CitationRepair` recorded |
| `mediaId` doesn't resolve | **Repair** → `generate`, citation dropped, repair records `citedMediaId` |
| `mediaId` resolves | **Canonicalize** — `ref`/`caption`/`role`/`name` overwritten from the resolved asset (a model-supplied caption **cannot survive**); `sourceShotIndex` clamped to the source's shot count |

A pure `generate` shot carrying a stray citation has it dropped. The returned
`ok` is `true` only when **nothing** needed repairing.

**Guarantee:** no accepted shot can cite an id that isn't in the library. Proven
by `reel-proposal.test.ts` ("REJECTS a fabricated id…") and the API-level
`director-proposal.test.ts` ("REPAIRS a fabricated one to generate").

---

## Bible integration

- The draft **honors** the persisted look: `proposeReel` takes a `StyleBible`
  (typically from `intakeReferences` or the persisted bible), and any consistency
  context already active (hydrated from the Project Bible on editor mount) still
  applies to generation.
- On **accept**, the bible seeds the reel consistency context
  (`bibleToConsistencyInput` → `applyConsistencyContext`) and the accepted plan is
  recorded through the versioned Project Bible layer (`syncProjectBible`), so the
  plan is a checkpointed, revertable state (`revertBibleCheckpoint`).

---

## Tests

- `src/lib/director/reel-proposal.test.ts` — pure: `decideShotSource` allocation,
  `validateProposal` grounding (fabrication rejection + caption-canonicalization +
  sourceShotIndex clamp), `reviseProposalShot` single-line stability,
  `proposalToPlan` / `formatProposalDraft`.
- `src/lib/director/director-proposal.test.ts` — integration over a real
  `DirectorApi`: grounded drafting (with and without the Understanding Pass),
  single-line revision, and acceptance materialization (library→clip,
  generate/g2m→slot) + bible persistence.

Run: `bun test src/lib/director/ && bun run typecheck` from `apps/web`.

---

## For Flow D (later)

Flow D ("taste in the loop") gates package-approval moments — hero-shot selection,
persona-lock + voice-consent, final cut — into this flow. The natural hooks:
`acceptProposal` is the reel-level approval moment (it write-throughs to the
Bible, which is how decisions compound), and a per-shot approval can wrap the
`generate-to-match` / hero materialization path. The `CitationRepair` list and the
`ReelProposal` draft are the surface a Flow-D gate reads to decide what needs human
judgment.

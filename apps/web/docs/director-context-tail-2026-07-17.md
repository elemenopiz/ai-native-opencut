# Director context-gap audit — Tier 2/3/4 re-verification (2026-07-17)

Campaign C8 (director-intel), part 1. Re-derives OPEN/CLOSED status of the
2026-07-13 audit's Tier 2/3/4 backlog against code at commit `99ab432c`
(current `main` at the time of this pass), after the 2026-07-17 churn:
board verbs in `tool-catalog.ts` (~53 verbs counted via `toolCatalog()`,
close to the 56 quoted going in), guards in `lib/commands`, board/takes
unification. Tier-1 items (@9a1fcd76 manifest dims/provenance/styleProbe,
@baf15b0b findDuplicateAssets, @6ec49c2a brief targetDuration) are not
re-litigated here except where a Tier-2 item depends on them (T2.2).

Doc-only deliverable — no source files were touched to produce this.

**Fix-location key** (per item, "where would a fix live"):
- **(a)** `lib/director` internals excluding `director-api.ts` / `tool-catalog.ts`
- **(b)** `director-api.ts` or `tool-catalog.ts` — **frozen this campaign**
- **(c)** outside `lib/director` entirely

---

## Tier 2 — reel's own state under-surfaced

### T2.1 — `reelSummary()` drops per-slot timing
**Verdict: still-open.** `reelSummary()` in
`apps/web/src/lib/director/agent.ts:425-438` still emits only
`id / status / takes / prompt` per slot:

```
`  #${i + 1} id=${map.shorten(s.id)} status=${s.status} takes=${s.takeCount} prompt=${JSON.stringify(s.prompt)}`
```

`SlotSnapshot` (`apps/web/src/lib/director/types.ts:42-58`) already carries
`start` and `duration` — `toSnapshot()` in `director-api.ts:666-678`
populates both — so the data exists and is just not walked into the digest
line. `planSummary()` (`agent.ts:394-412`, the PLAN block folded into the
same digest) also has no per-shot timing. The only timing that reaches the
per-turn digest today is the reel-level total via `pacingClause()`
(`agent.ts:419-422`, `"34.0s built / 60s target"`). To learn one slot's
start/duration the agent must call `getSlot(id)` separately, once per slot.
**Fix location: (a)** — pure formatting change in `agent.ts`, using data
`director-api.ts` already returns. No frozen-surface edit needed.
**Effort: S.**

### T2.2 — brief had no duration/length field
**Verdict: closed** (by @6ec49c2a, confirmed intact after today's churn).
`DirectorBrief.durationSec` exists at
`apps/web/src/lib/director/director-brief.ts:114`, is read/written by
`patchBrief` (lines 158-166) and rendered into the brief prompt block
(`"TARGET DURATION: ${b.durationSec}s"`, lines 202-203).
`ReelSnapshot.targetDurationSec` (`types.ts:62-74`) is populated from it at
`director-api.ts:865` (`targetDurationSec: readBrief().durationSec`) and
folded into `getReel`'s digest via `pacingClause()`
(`agent.ts:419-422`). Full round trip confirmed: brief → reel snapshot →
per-turn digest.

### T2.3 — transitions are write-only
**Verdict: still-open**, and the code self-documents it. `applyTransition`
(`director-api.ts:4048-4079`) calls `AddTransitionCommand` and returns a
plain success message; the surrounding comment block
(`director-api.ts:4033-4041`) states outright: *"Neither `transitionOut`
nor an element's effect list is part of `SlotCapture`'s tracked fields, so
`withDelta` may report an EMPTY delta here even on success."*
`toSnapshot()` (`director-api.ts:666-678`) does not read
`element.transitionOut` into `SlotSnapshot`, even though the underlying
element type already carries it (`transitionOut?: TransitionData` on
`VideoElement`/`ImageElement`, `apps/web/src/types/timeline.ts:316,329`).
So a transition applied this turn is unreadable via `getReel`/`getSlot`
next turn. **Fix location: (b)** — the read path (`toSnapshot`,
`SlotCapture`) and the `SlotSnapshot` type addition both sit inside
`director-api.ts`/its co-located types; frozen this campaign.
**Effort: S** (the data already exists on the element; this is a read-out,
not new capture logic).

### T2.4 — voiceover/music-bed elements structurally invisible
**Verdict: still-open.** `isSlotElement()` (`director-api.ts:577-583`)
gates on `element.type === "image" || element.type === "video"` plus a
`generation` field. `addVoiceover` creates an **audio**-typed element via
`TimelineManager.addVoiceoverSlot` (`apps/web/src/core/managers/
timeline-manager.ts:395-426`) — the comment there even calls it *"the audio
twin of `addGenerativeSlot`"*, and it carries the same `generation` recipe
(`spec.kind === "voiceover"`) and `takes: []`. Because its `type` is
`"audio"`, `isSlotElement` returns `false` for it, so `locateSlots()`
never surfaces it and `getReel`/`getSlot` can't see it. `addMusicBed`
(`director-api.ts:3756+`) places a plain (non-generative) audio clip, so
it's doubly invisible — no `generation` field either. **Fix location: (b)**
— `isSlotElement`, `locateSlots`, `captureReel`/`SlotCapture`, and
`toSnapshot` all live in `director-api.ts`. **Effort: M** — voiceover
slots can reuse the existing `SlotSnapshot` shape (they already have
`generation`/`takes`); music-bed clips have no `generation` recipe, so
they'd need either a new snapshot variant or a separate "audio bed" read
verb — that decision is the real scoping work, not the plumbing.

### T2.5 — transcript segments not slot-timeline-linked
**Verdict: still-open.** `getTranscript` (`director-api.ts:1007-1011`)
takes `{ mediaId, startSec?, endSec? }` only — no `slotId` parameter and
no output field translating asset-relative segment times into the
timeline's coordinate space. The doc comment on the function
(`director-api.ts:997-1006`) is explicit that segments are in
"ASSET-RELATIVE seconds, the same timebase as `trim`'s
`trimStart`/`trimEnd`" — the caller must separately fetch the slot's
`trim`/`start` (via `getSlot`) and do the arithmetic itself; there's no
single call that answers "does the VO fit this shot." **Fix location:
(b)** — `getTranscript` lives in `director-api.ts`; a `slotId`-aware
variant would need to correlate the slot's active take's trim/start,
which requires reading slot/element state already private to that file.
**Effort: M.**

### T2.6 — `defaultResolveMusic` collapses Freesound's richer result
**Verdict: still-open.** `defaultResolveMusic`
(`director-api.ts:3689-3746`) takes `data.results?.[0]` — the single top
hit — and returns only `{ mediaId, name, duration, license, sourceUrl }`
(`ResolvedMusic`, defined at `director-api.ts:263`). The upstream route,
`apps/web/src/app/api/sounds/search/route.ts`, already parses and returns
far richer per-result data — `description` (line 128), `tags` (line 142),
`rating`/`ratingCount` (from `avg_rating`/`num_ratings`, lines 146-147) —
across a `results: SoundEffect[]` array, not just one hit. None of that
reaches the Director. **Fix location: (b)** — `defaultResolveMusic` and
`ResolvedMusic` are both defined in `director-api.ts`. **Effort: S** —
the richer data is already one HTTP call away; this is a matter of
carrying more fields through and/or returning top-N candidates instead of
auto-picking `[0]`.

---

## Tier 3 — beat grid + LUFS (in-flight this campaign, W2)

Marked in-flight per campaign instructions — recording current wiring
facts only, no verdict/fix-location assigned (a sibling worker is
implementing manifest surfacing for this now).

- **Zero references in `lib/director`, confirmed.** `grep -rn` for
  `beat-grid-store` and `use-loudness-normalization` under
  `apps/web/src/lib/director/` returns nothing.
- **Beat analysis: on-demand, not at ingest.** `useBeatGridStore`
  (`apps/web/src/stores/beat-grid-store.ts:44-64`) holds a single
  `grid: BeatGrid | null` (not a per-asset map). It's populated by
  `analyzeSelectedClipBeats` in `apps/web/src/hooks/timeline/
  use-audio-tools.ts:180-219`, which requires the user to have a
  music/audio clip **selected** in the timeline UI (toast: *"Select the
  music/audio clip to analyze"*, line 183) and calls
  `aiClient.analyzeBeats(file)` — a user-triggered action from the
  Timeline toolbar/audio-tools menu, not part of the ingest pipeline.
  `beatSnappingEnabled` is the only field that survives `reset()`
  (`beat-grid-store.ts:57-63`); the analyzed `grid` itself is dropped on
  project reset (project-scoped, not persisted to the DB/asset record).
- **LUFS: transient hook state, not persisted anywhere.**
  `useLoudnessNormalization` (`apps/web/src/hooks/
  use-loudness-normalization.ts:59-62`) holds `measurement` in a plain
  `useState<LUFSMeasurement | null>` local to the hook instance — no
  Zustand store, no DB write. It's consumed by exactly one component,
  `apps/web/src/components/editor/panels/assets/views/
  loudness-panel.tsx`. `measureLUFS()` (lines 8-57) runs synchronously
  against an already-decoded `AudioBuffer` when the user opens/uses that
  panel — also on-demand, not at ingest. Unmounting the panel loses the
  measurement entirely; nothing survives a re-render of the parent.

---

## Tier 4 — genuinely missing (real ingestion work)

### T4.1 — no quality signals (blur/shake/exposure/audio clipping)
**Verdict: still-open.** `AssetUnderstanding`
(`apps/web/src/lib/search/asset-understanding.ts:129-161`) has exactly:
`mediaId, caption, role, roleConfidence, roleConfirmed?, tags, faces,
styleProbe?, modelName, createdAt`. No quality field of any kind.
`ASSET_UNDERSTANDING_SYSTEM_PROMPT` (same file, from line 234) asks the
VLM for caption/role/tags/faces/style only — nothing about blur, camera
shake, exposure, or (for audio) clipping. **Fix location: (c)** —
`asset-understanding.ts` is outside `lib/director` entirely. Note:
capturing the signal here does NOT by itself make it visible to the
Director — `buildManifest()`/`getProjectInfo()` in `director-api.ts`
would need a follow-up (b) change to actually surface it in the digest.
Phase 1 (schema + VLM-self-reported blur/shake/exposure via prompt
addition) is cheap and non-surface; audio-clipping would need real signal
analysis, not just an LLM self-report. **Effort: M** (visual, prompt-only)
**/ L** (audio clipping, needs real DSP) for phase 1; phase 2 exposure is
small once T4.1 phase 1 lands.

### T4.2 — screen-rec gets the generic caption prompt, no OCR
**Verdict: still-open.** `screen-rec` is one of the `AssetRole` union
values (`asset-understanding.ts:64-81`) but there is exactly one system
prompt for every role (`ASSET_UNDERSTANDING_SYSTEM_PROMPT`, used at lines
751 and 956) — no role-conditional branch, and no "ocr"/"on-screen
text" instruction anywhere in the file (`grep -n "ocr\|OCR"` = 0 hits).
**Fix location: (c)** — same file, outside `lib/director`. Exposure to
the Director again needs a (b) follow-up if the OCR text should reach
`getProjectInfo`/`getLibraryManifest`. **Effort: M** — the VLM call
already happens per asset; a role-conditional prompt branch asking for
on-screen text when `role === "screen-rec"` is cheap. A dedicated OCR
pass (e.g. Tesseract.js) would be **L** and is not required for a
first cut — the VLM can plausibly transcribe legible on-screen text
itself from the sampled frames.

### T4.3 — no asset-level content-safety/rights flag
**Verdict: still-open.** Confirmed `safetyTier` only exists on
`GenerationBackend` (`apps/web/src/lib/studio/backends/types.ts:152`) —
a per-*backend* property (is this generation provider NSFW-safe), not a
per-*asset* one. `AssetUnderstanding` has no analogous field. **Fix
location: (c)** — `asset-understanding.ts`, outside `lib/director`; same
phase-1/phase-2 split as T4.1/T4.2. **Effort: M** — the VLM call
already returns structured JSON; adding a `contentFlag`/`rightsFlag`
enum is schema-only work, not new infra.

### T4.4 — `AssetFace.descriptor` is one flat prose string
**Verdict: still-open on current `main`.** `AssetFace.descriptor?:
string` (`asset-understanding.ts:91-106`) remains a single free-text
field, reused verbatim into `Persona.descriptor` when a face is locked.
Checked against today's C2 consistency-fold work
(`799bf08c fix(studio): fold consistency context + persona seed into
manual/rerun generate paths`, `7b148090 feat: fold StyleBible/
ConsistencyContext...`): **that work is NOT yet merged to `main`** —
`git merge-base --is-ancestor 799bf08c HEAD` fails; it lives on campaign
branches (`campaign/*`, `task/c2-*`) only. Even inspecting those commits'
touched files (`personas.ts`, `persona-still.ts`), the descriptor
threading stays a flat string — `weaveDescriptorIntoPrompt` /
`applyPersonaSeed`-style helpers in `personas.ts` concatenate it as prose
(`` `${prompt}. Featuring ${descriptor}.` ``), they don't structure it.
So C2 does not reshape this item; it's still a real Tier-4 gap. **Fix
location: (c)** — `asset-understanding.ts` (schema/VLM prompt) plus
`personas.ts`/`persona-still.ts` (consumers), all outside `lib/director`.
**Effort: L** — structuring into outfit/setting/build sub-fields touches
the VLM prompt, the type, and every consumer that currently treats
`descriptor` as an opaque string (persona creation, prompt weaving,
persona-still generation); higher blast radius than the other Tier-4
schema additions, and now has a live consumer (C2) to keep in sync with
once that campaign merges.

### T4.5 — vision-critic verdicts are transient, never persisted
**Verdict: still-open** (marked in-flight this campaign, W3 — recording
facts only). `CriticVerdict` (`vision-critic.ts:57-77`) is produced
per-call inside `reviewTake`'s auto-review loop
(`agent.ts:891-1166`, e.g. `let verdict: CriticVerdict` at line 1002) and
used immediately to decide reroll/remix — nothing writes it back onto the
`Take`. `Take` (`apps/web/src/types/timeline.ts:267-284`) has no
`criticHistory`/`verdictHistory`/`rejectCount` field; confirmed zero hits
for those names anywhere non-test. **Fix location:** split — extending
`Take`'s type is (c) (`types/timeline.ts`), but writing a verdict onto a
take can only happen through `director-api.ts` (where `reviewTake` and
all element/take mutation already live) — so the persistence write is
**(b)**, surface-gated, even though the type addition alone is (c).
**Effort: M**, and explicitly not this campaign's to pick up (W3 owns
it) — recorded here for completeness only.

### T4.6 — shot-boundary segmentation computed then discarded
**Verdict: still-open.** `segmentShots()`
(`apps/web/src/lib/search/asset-understanding.ts:569`, referenced at
`apps/web/src/services/search/asset-understanding-service.ts:243`) runs
inside `sampleUnderstandingFrames()` purely to pick which frames to hand
the VLM (`pickShotRepresentatives(shots, MAX_VLM_FRAMES)`,
`asset-understanding-service.ts:244`) — the `shots` boundaries/count are
local to that function and never written onto `AssetUnderstanding`.
A multi-shot source (e.g. a 3-scene edited clip uploaded as one file)
therefore looks identical to a single continuous shot everywhere
downstream. **Fix location: (c)** — `asset-understanding.ts`/
`asset-understanding-service.ts`, outside `lib/director`. **Effort: S**
— the computation already runs every time; this is purely "keep the
result and put it on the record" (`shotCount`/`shotBoundaries` field),
cheaper than T4.1-T4.4 which need new VLM prompt behavior. Phase-2
surfacing into the Director's manifest is a small (b) follow-up.

### T4.7 — `searchMedia` collapses to one best frame per asset
**Verdict: still-open.** `searchMedia`
(`director-api.ts:1185-1241`) loops `media.frames`, tracks a single
`bestScore`/`bestTs` per asset (lines 1212-1220), and pushes exactly one
`MediaSearchHit` per asset into the result — other strong in-video
moments (e.g. two separate strong matches inside one long clip) are
discarded, confirmed by direct read of the loop body. **Fix location:
(b)** — lives entirely inside `director-api.ts`. **Effort: M** — needs a
design decision (return top-K frames per asset vs. flatten to
frame-level hits across assets, with a cap so results don't blow up the
digest budget), not just a code change.

### T4.8 — no exhaustive library listing/paging
**Verdict: still-open.** Every current path into the library is capped:
`getProjectInfo` (`director-api.ts:945-969`) returns `recentAssets:
assets.slice(-CONTEXT_LIST_CAP)` with `CONTEXT_LIST_CAP = 5`
(`director-api.ts:875`); `getLibraryManifest`'s heroes/face-anchors are
capped at `HERO_NAME_CAP = 3` / `FACE_ANCHOR_CAP = 2`
(`asset-manifest.ts:295,297`); `searchMedia` defaults to `limit ?? 5`
(`director-api.ts:1208`) and — notably — has **no upper bound** on a
caller-supplied `limit`, but it still requires a non-empty semantic
`query` (line 1190: `if (!query) return fail(...)`), so it cannot be used
as a true "list everything" call; there is no verb that pages through
the full asset list deterministically. **Fix location: (b)** — a new
paging verb (`listAssets`/`getAssetsPage`) needs both a
`director-api.ts` implementation and a `tool-catalog.ts` entry.
**Effort: M** — mechanically simple (offset/cursor over
`editor.media.getAssets()`) but is a new verb, i.e. squarely inside the
frozen surface.

---

## Recommended next slice (no `director-api.ts` / `tool-catalog.ts` edits)

Ranked by ROI given the campaign's surface freeze:

1. **T2.1 — add start/duration to `reelSummary()`.** (a), S effort,
   immediate payoff: today the agent must call `getSlot` per-slot to
   learn timing that's already sitting in `ReelSnapshot.slots[i]`. Purely
   a formatting change in `agent.ts`.
2. **T4.6 — capture `segmentShots()`'s output instead of discarding it.**
   (c), S effort: the computation already runs on every understanding
   pass; add `shotCount`/`shotBoundaries` to `AssetUnderstanding` now.
   Doesn't reach the Director yet (that's a phase-2 (b) change) but it's
   free prep that de-risks the eventual surface change — no re-deriving
   needed once the freeze lifts.
3. **T4.1/T4.2/T4.3 — VLM prompt + schema additions in
   `asset-understanding.ts`.** (c), S-M effort each: add
   blur/shake/exposure self-report, screen-rec on-screen-text extraction,
   and a content/rights flag to the existing structured-JSON VLM
   response. All three piggyback on a call that already happens per
   asset — no new ingestion pass, no new infra. Also prep-only until a
   phase-2 (b) exposure change, same caveat as #2.
4. **T4.4 descriptor structuring** is higher effort (L) and now has a
   live, currently-unmerged consumer (C2 consistency fold) — worth
   sequencing AFTER C2 merges to avoid a rebase/rework collision, not
   picked up this slice.

None of the above touches `director-api.ts` or `tool-catalog.ts`. All of
them leave a documented "exposure" gap (the new field exists on
`AssetUnderstanding`/`ReelSnapshot` but a human still has to wire a
follow-up read into `director-api.ts`) — that follow-up is listed below,
not implied as free.

## Surface-gated (queue rows, not this campaign's work)

Everything below requires editing `director-api.ts` and/or
`tool-catalog.ts`, which are frozen this campaign. Queue as follow-up
work once the freeze lifts:

| Item | What the surface change is | Effort |
|---|---|---|
| T2.3 | Read `element.transitionOut` into `SlotSnapshot` in `toSnapshot()` | S |
| T2.4 | Extend `isSlotElement`/`locateSlots` to cover voiceover (and decide a shape for music-bed) elements | M |
| T2.5 | `slotId`-aware `getTranscript` variant that resolves timeline-relative offsets | M |
| T2.6 | Carry `tags`/`description`/`rating` (and/or top-N candidates) through `defaultResolveMusic` | S |
| T4.5 (W3-owned) | Persist `CriticVerdict` onto a `Take` via a `director-api.ts` write path | M |
| T4.7 | `searchMedia`: return more than one hit per asset (top-K design decision) | M |
| T4.8 | New paging verb (`listAssets`) in both `director-api.ts` and `tool-catalog.ts` | M |
| T4.1-T4.3/T4.6 phase 2 | Surface the new `AssetUnderstanding` fields (once added) into `buildManifest`/`getProjectInfo` | S each |

---

## Surprises

- **Nothing was silently fixed by today's (2026-07-17) churn.** The board
  verbs, `lib/commands` guards, and board/takes unification landed
  elsewhere in the tree (board plumbing, takes-unification) and don't
  touch any of the Tier 2/4 read paths audited here — every item's
  file:line citation above is from the post-churn tree and matches the
  audit's original claim in substance, only line numbers moved.
- **T2.3's gap is self-documented in the code** — the comment at
  `director-api.ts:4033-4041` already says outright that `withDelta` can
  report an empty delta for a successful `applyTransition` call. Whoever
  wrote that knew about the gap; it was never closed.
- **T4.4's stated "reshaped by C2" caveat does not apply**: the C2
  consistency-fold commits (`799bf08c`, `7b148090`, plus the wider
  campaign branch) are **not on `main`** as of this pass
  (`git merge-base --is-ancestor 799bf08c HEAD` fails) — they live on
  `campaign/*`/`task/c2-*` branches only. Even so, reading those commits'
  diffs shows they thread the *same* flat descriptor string further
  (prompt concatenation), not a structured replacement — so T4.4 stays
  open regardless of whether/when C2 merges, but merging C2 first would
  reduce T4.4's future rebase risk.
- **`searchMedia`'s `limit` param has no upper bound** — a caller could
  ask for `limit: 10000`, but since a non-empty semantic `query` is
  still required, this doesn't give T4.8 a backdoor; it just means the
  existing cap is a soft default, not a hard ceiling.

# Palmier agent tool-surface spec (reverse-engineered)

A full catalog of **Palmier Pro's** agent/MCP tool surface (`palmier-io/palmier-pro`,
`Sources/PalmierPro/Agent/Tools/`), described in our own words, with every tool
mapped against our Director API (`apps/web/src/lib/director/director-api.ts`).
Sibling to `palmier-idea-poaches.md` — that doc ranks *ideas*; this one is the
exhaustive *tool-by-tool* gap map behind those rankings.

> **License boundary — read first.** `palmier-pro` is **GPL-3.0** (Swift). Our
> web app is MIT. **Do not copy any code, types, schema JSON, parameter names,
> or literal description strings** from `palmier-pro` into this repo — GPL-3.0
> is copyleft and would force us to relicense. This document is a *conceptual*
> spec written from understanding, not transcription: tool behaviors are
> paraphrased, input/output shapes are described in prose, and every proposed
> verb below is designed in OUR type system (`DirectorResult<T>`,
> slot/take/reel vocabulary) — implement from this doc, never from their source.

**Sources read:** their tool schema declarations, the ~28 category-split
executor extension files, and the MCP HTTP transport layer. Their surface is
**45 tools**: 40 shared core tools, 1 extra for the in-app assistant
(skill loading), and 4 extra for the MCP server (project open/close/create/list).
(An earlier draft said "44" — undercount; the Clips & tracks group lists 12
including `undo`, not 11. Corrected 2026-07-09 against `ToolDefinitions.swift`
HEAD `cd74ce3`, which declares 45 tools.)

> **DELTA 2026-07-14 (v0.6.6, HEAD `092bc9e`) — count is now 46; this catalog
> describes the 45-tool v0.6.3 surface.** Changes since: the 4 MCP-only project
> tools (list/open/create/close) were consolidated into one
> `manageProject{action}` router (#299, which also introduced per-session
> project *binding* — mutations refused when a different project is frontmost,
> reads allowed via an allowlist); new `manageExports{list|cancel}` over a
> FIFO export queue (#298, `exportProject` now returns a `jobId`); and 3 new
> multicam tools `manageMulticam`/`changeCam`/`getMulticam` (#283). Also
> `manageTracks` gained stable `trackId` addressing (#307) and `generateAudio`
> gained `sourceMediaRef`/`targetLanguage` for voice-cleanup/dubbing (#294).
> Full delta: `palmier-delta-refresh-2026-07-14.md` §4–5. The per-tool prose
> below remains accurate for all unchanged tools.

**Our surface today** (19 verbs): `getReel`, `getSlot`, `storyboard`,
`reserveSlot`, `setPrompt`, `generate`, `reroll`, `remix`, `chooseTake`,
`trim`, `move`, `split`, `reorder`, `remove`, `undo`, `redo`, `export`,
`getConsistencyContext`, `setConsistencyContext`.

**Verdict legend** used throughout:

- ✅ **covered** — an existing Director verb already does this
- 🟡 **partial** — we have the verb but theirs does meaningfully more
- 🔺 **gap** — their agent can do it, ours can't; proposed verb included
- ⛔ **n/a** — macOS-specific, billing-specific, or irrelevant to a gen-first web reel editor (at least for now)

---

## If we build 5 things from this spec, build these first

Ranked by (agent capability unlocked) × (implementation cost given our existing
`director-api.ts` patterns). Cheap + high-value first. #1 and #2 match the P0s
in `palmier-idea-poaches.md`; the rest are new conclusions from the full map.

| # | Build | Why first | Effort |
|---|-------|-----------|--------|
| 1 | **Short-id boundary** (`lib/director/short-id.ts`) | Pure token savings on every single agent turn; zero product risk; unblocks nothing but compounds with everything. Detailed algorithm below. | S |
| 2 | **Mutation-delta returns** on every mutating verb | Keeps the ReAct loop inside `MAX_STEPS`; the agent stops re-calling `getReel` after each edit. Detailed algorithm below. | M |
| 3 | **`searchMedia` verb** — expose our shipped CLIP visual search to the agent | We already built local CLIP search; one thin verb makes the agent footage-aware ("find the harbor shot and put it in slot 3"). Their agent's killer read tool, nearly free for us. | S |
| 4 | **`addText` / `updateText` verbs** | `TextElement` already exists in `types/timeline.ts`; titles/captions-as-text is the single most-requested edit an agent gets after generation. Thin delegation, same pattern as `reserveSlot`. | S |
| 5 | **Agent-scoped `undo`** | Safety before power: once verbs 3–4 land the agent touches timelines humans also edit. Tag history entries with an origin and make the Director `undo` refuse to revert human edits. Their mechanism described below. | S–M |

Honorable mentions (build 6–8): `readPlaybook` (lazy-load full playbook text —
our system prompt already lists titles only; mirrors their skill-loading tool
and is nearly free), `listModels` (serve `lib/studio/model-capabilities.ts`
through a verb so the agent picks valid durations/resolutions), and
`inspectFrame` (render-a-frame-as-observation; gated on a vision-capable model,
see idea-poach #10).

---

## Cross-cutting mechanisms (the executor pipeline)

Before the per-tool catalog: the most valuable things in their codebase are not
individual tools but the *pipeline every tool call passes through*. Ours in
`agent.ts` is: parse JSON → look up verb → run → append `result.message` to the
scratchpad. Theirs is a five-stage pipeline; each stage is independently
poachable.

Their execution order, conceptually:

1. Snapshot the current **id universe** (every clip/track/asset/timeline id).
2. **Expand** any shortened id prefixes in the incoming arguments to full ids.
3. Run the tool. If it mutated the timeline, push the change onto an
   **agent-owned undo stack**.
4. Record success/failure into a feedback tracker (fuel for their
   report-a-limitation tool).
5. **Shorten** every full UUID in the outgoing result text against the union
   of the pre-call and post-call id universes (so both freshly-created ids and
   just-deleted ids still round-trip short).

### Mutation-delta responses — implementation detail

**What it is.** After any timeline-mutating tool, they return a *diff against a
before-snapshot* instead of the full timeline. Our project memory flags this as
a general agent-context-efficiency idea worth adopting regardless of feature
parity. Here is the actual algorithm, at implementation level, in prose:

**Snapshot.** Before running a mutating tool, walk every track and record, per
clip id: which track it's on, the track's index, its start frame, and its
duration. Also record the ordered list of track ids. This is cheap — a flat
`Map<string, {trackId, trackIndex, start, duration}>` plus a `string[]`.

**Diff.** After the tool runs, take a second snapshot and classify every clip:

- **Changed** = (a) any id the tool itself reports it touched (tools pass their
  known-touched ids into the diff helper as a hint), plus (b) any id present
  after but absent before (created).
- **Pure shift** = present in both snapshots, same track, same duration, only
  the start frame moved. Record `(oldStart, delta)` for each.
- Anything else that moved (changed track or duration) is folded into
  **changed**.
- **Removed** = present before, absent after → returned as a plain list of ids.

**Shift compression — the key trick.** Group the pure shifts by
`(trackIndex, delta)`. Any group with **≥ 3 members** is emitted as a single
rule — conceptually *"on track N, everything from frame F onward moved by Δ,
affecting K clips"* — instead of K per-clip entries. Groups smaller than 3 are
cheaper to just enumerate, so they get demoted back into **changed**. Rules are
sorted by (track, from-frame) for deterministic output. This is what makes a
ripple edit that shifts 40 clips cost ~1 line instead of 40.

**Caption-group collapse** (their captions are hundreds of tiny clips sharing a
group id): if ≥ 3 changed clips share a caption-group id, they're removed from
the changed list and replaced by one group summary (count, frame range, text
preview). Our analog: if we ever emit per-word caption elements, collapse the
same way; until then this clause is skippable.

**Caps and staleness notes.** Changed clips are serialized in the same compact
shape the main timeline read uses (so the agent never learns two formats), and
capped at **30** — past the cap, a note says "showing 30 of N, re-read for the
rest". If the track *list* changed (a track was created, removed, or reordered),
a note warns that track indices are stale and index-based calls need a fresh
read first. Created tracks are listed with their new index and type. All floats
are rounded to 3 decimal places before serialization (a small but real token
saver on transforms).

**Our implementation sketch** (matches idea-poach #1): a
`snapshotPlacements(editor)` helper + a `computeDelta(before, after, touched)`
in `director-api.ts`; every mutating verb (`trim`, `move`, `split`, `reorder`,
`remove`, `storyboard`, and eventually `placeAsset`/`cutRange`) returns
`DirectorResult<MutationDelta>` where `MutationDelta = { changed: SlotSnapshot[],
shifted?: { trackIndex, fromTime, by, count }[], removedIds?: string[],
createdTracks?: { index, type }[], notes?: string[] }`. In `agent.ts`,
serialize the delta as the observation instead of `result.message` alone. Note
our timeline is seconds-based, so our shift rule speaks seconds; equality
checks on start times should use an epsilon, not `===`.

### Short-id (UUID prefix-shortening) — implementation detail

**What it is.** Full UUIDs internally; shortest-unique-prefix ids in every
byte that reaches the model, expanded back on the way in. Also flagged in our
project memory as a general token-savings idea. The algorithm:

**The id universe.** A function collects every id the agent could legitimately
reference right now: all timeline ids, every clip id on every track, caption-
and link-group ids, and every media-asset id. This set is recomputed per tool
call — it's the ground truth both directions of the translation resolve
against.

**Shortening (output direction).** Build a map from full id → shortest unique
prefix:

1. Sort all ids lexicographically.
2. For each id, its longest shared prefix with any *other* id in the set is
   necessarily with one of its two sorted neighbors — so compute the
   common-prefix length with the previous and next id only. That makes the
   whole map **O(n log n)** for the sort and O(n) for the scan, not O(n²).
3. The short id is the first `max(FLOOR, sharedLen + 1)` characters, where
   `FLOOR = 8`. The floor keeps ids visually id-like and leaves headroom so a
   *new* id created later rarely collides with a prefix the model already holds.
4. Apply the map to the outgoing result by regex-matching the standard UUID
   pattern in the serialized text and substituting; unknown UUIDs pass through
   untouched. They run this on the union of pre-call and post-call universes so
   ids created *or deleted by this very call* still shorten (a removed-ids list
   in a delta would otherwise leak full UUIDs).

**Expansion (input direction).** Before a tool runs, walk the argument object
recursively. They keep two explicit allow-lists of *which argument keys hold
ids* (one for scalar id fields, one for id-array fields) and only rewrite
those — this avoids mangling a prompt string that happens to contain 8 hex
chars. For each candidate value:

- exact member of the universe → keep as-is (full ids always work);
- shorter than the floor → leave untouched (never treat tiny strings as prefixes);
- otherwise find all universe ids having it as a prefix: exactly one match →
  substitute the full id; multiple matches → **throw a self-describing
  ambiguity error** telling the agent to re-read state; zero matches → leave
  the value alone so the tool itself emits its usual not-found message.

**Our implementation sketch** (matches idea-poach #2): `lib/director/short-id.ts`
exporting `buildShortIdMap(ids)`, `shortenIds(text, map)`, and
`expandId(ref, ids)` (throwing a typed `AmbiguousIdError`). Our id universe =
slot ids + take ids + media ids + track ids. Wrap the boundary in `agent.ts`
(shorten the observation/`reelSummary`, expand `args` values whose key ends in
`Id`/`Ids` before dispatch). The Director API itself keeps speaking full UUIDs
— translation is strictly an agent-boundary concern, so the manual UI is
untouched. Unit-test: single-id universe (floor applies), two ids sharing a
long prefix (short ids grow past the floor), ambiguous prefix throws.

### Agent-scoped undo

Their executor keeps a private stack of *names of edits the agent made this
session*. When an edit lands and the timeline actually changed, the platform
undo manager's current action name is pushed. Their undo tool then: refuses if
the agent stack is empty ("the user's edits are theirs to undo"); refuses if
the top of the *real* undo stack doesn't match the top of the agent stack
(i.e. the human edited since); otherwise undoes exactly one step, pops, and
tells the agent all previously returned ids/frames may now be stale.

**Ours:** our `undo()` blindly calls `editor.command.undo()`. Poach: tag
command-manager history entries with an origin (`"agent" | "user"` — set by
whoever constructs the transaction), and make the Director `undo` refuse when
the top entry's origin isn't `"agent"`, with a plain-language message. `redo`
gets the mirror check. (Idea-poach #7.)

### Other pipeline guardrails worth copying as *conventions*

- **Batch atomicity:** every multi-entry tool validates all entries up front
  and rejects the whole call on one bad entry — no partial state. Our
  `storyboard` already does this via the transaction buffer; new batch verbs
  must too.
- **Unknown-key rejection:** args carrying fields outside the declared set are
  rejected with a message listing the allowed fields — catches model typos
  (`stratFrame`) that would otherwise silently no-op. Cheap to add to our arg
  coercion in `agent.ts`.
- **Non-finite number rejection** with a path to the offending value.
- **Self-describing refusals that name the fix**: e.g. their ripple-delete
  refusal names the blocking sync-locked track and the exact parameter to
  override it. Our `fail()` messages should keep doing this as verbs grow.
- **Per-tool telemetry** (name, duration, changed-timeline flag, error) — we
  log nothing per verb today.

---

## Tool catalog and gap map

Grouped by their executor categories. Each entry: what the tool does, the
conceptual I/O shape, and the verdict against our Director API.

### 1. Projects (MCP server only — 4 tools)

Only exposed on their MCP surface, not to the in-app assistant, because an
external client (Claude Desktop/Cursor) needs to pick which project to drive.

| Tool | What it does | Shape | Verdict |
|---|---|---|---|
| list projects | Lists known projects, most-recent first, flagging which is open/active. | no input → project descriptors + the active one | ⛔ for the in-app agent (our agent is born inside a project route). 🔺 **for a future MCP surface**: a `listProjects`/`openProject` pair over our project store becomes necessary the day idea-poach #15 ships. Defer until then. |
| open project | Makes a project active (by name, id, or package path); brings its window forward; returns an orientation snapshot (fps, resolution, media count, generation entitlement, timelines). | identifier → snapshot | same as above |
| new project | Creates an empty project (optionally with fps/aspect/quality) and activates it; refuses duplicate names. | name + optional canvas settings → snapshot | same as above |
| close project | Saves and closes; next open project becomes active. | optional identifier → new active project | ⛔ web app; tabs close themselves |

### 2. Timeline reads and settings (6 tools)

**get_timeline** — *their single most important tool.* Returns project settings
(fps, resolution, total length), all tracks with index/type, and every clip.
Design features worth copying wholesale:

- **Windowing**: optional start/end frame bounds return only intersecting
  clips; tracks report a total count when the window hides some.
- **Default omission**: any field equal to its default (speed 1, opacity 1,
  zero trims, identity transform…) is simply absent. Massive token savings.
- **Gap listing**: each track lists its empty spans so the agent can place
  clips without arithmetic.
- **Linked-audio folding**: a video clip's paired audio clip is nested inside
  it (only deviating fields), not repeated on its own track.
- **Caption-group summarization**: hundreds of caption clips collapse to one
  summary per group unless the caller opts into per-clip detail.
- **Round-trippable sub-objects**: a clip's color grade and effects come back
  in exactly the shape the grading/effects tools accept, so "copy the grade" is
  paste-back.

Verdict: 🟡 **partial**. `getReel` covers the generative-slot view but (a) omits
non-generative elements (text, plain media, audio) so the agent is blind to
half the timeline, (b) has no windowing or gap listing, (c) serializes every
take verbatim (our `SlotSnapshot.takes` includes full specs — expensive), and
(d) omits nothing. Proposed evolution, not a new verb: `getReel({ window?,
includeTakeSpecs? })`, add per-track element listing beyond slots, elide
default fields, and summarize takes to `{id, status, seed}` unless asked.

**inspect_timeline** — renders the *composited* preview at a frame (or samples
N frames across a range) and returns actual images, each with its frame number
burned in, plus per-frame lists of which clip ids are visible top-down. The
agent's self-verification loop: make an edit, look at it. Verdict: 🔺 **gap**
(idea-poach #10). Proposed `inspectFrame({ time, endTime?, maxSamples? }) →
DirectorResult<{ images: dataUrl[], visible: slotId[][] }>` via our existing
canvas renderer; gated on a vision-capable agent model.

**create_timeline** — creates a new timeline (empty, or a full deep copy of an
existing one) and switches to it. The copy is their **versioning primitive**:
duplicate, then edit the copy ("make a 9:16 version") while the original stays
intact. All ids in the copy are new. Timelines can also be nested into other
timelines as a single sequence clip. Verdict: 🔺 **gap, medium-term**. We are
single-timeline-per-reel today. The cheap slice worth having:
`duplicateReel() → DirectorResult<{ reelId }>` as an agent-safe "branch before
a big change" primitive, once our project store supports multiple sequences.
Nesting is ⛔ for now.

**set_active_timeline** — switches which timeline all other tools target;
warns that all previously seen ids are now invalid. Verdict: ⛔ until we have
multiple timelines; then it rides along with `duplicateReel`.

**set_project_settings** — changes fps, resolution/aspect (presets or exact),
and auto-refits existing clips (transforms recomputed, frame positions rescaled
on fps change). Verdict: 🔺 **gap**. Our reels have an orientation/resolution
notion per-spec but no agent verb for the project canvas. Proposed
`setReelFormat({ orientation?, resolution?, fps? }) → DirectorResult` — and the
auto-refit behavior is the important part to replicate, not the setter.

**export_project** — renders to H.264/H.265/ProRes, or writes NLE interchange
XML (Premiere flavor vs. Resolve/FCP flavor), or a self-contained project
package. Video renders async with an OS notification; interchange formats
return inline. Verdict: 🟡 **partial**. Our `export()` exists but returns a
not-wired failure. First slice: wire it to the existing render path with
`{ resolution?, format? }`. NLE interchange is ⛔ near-term (and note: they
*lose* generation metadata on XML export — our provenance-sidecar counter-move
is idea-poach #12).

### 3. Media library (5 tools)

**get_media** — the library inventory: every asset with name, type, duration,
dimensions, audio flag, folder, and — for generated assets — the *prompt that
made it* as a content hint. A transient generation/import status field appears
only while an asset is unresolved; its absence means ready. Filterable by
explicit id list (the cheap way to poll a generation placeholder), folder, or
pending-only. Verdict: 🔺 **gap**. Our agent cannot see the media store at all.
Proposed `getAssets({ ids?, pendingOnly? }) → DirectorResult<AssetSnapshot[]>`
over our media store, where `AssetSnapshot = { id, name, type, duration?,
width?, height?, generatedFromPrompt? }`. Cheap; makes `searchMedia` results
actionable.

**inspect_media** — deep-look at one asset: images return the image + EXIF;
videos return sampled frames + a transcription; audio returns transcription;
optional storyboard-grid overview mode for long media; windowed re-calls
transcribe only the window. Timestamps come back in source seconds, or mapped
into timeline terms when the caller names a clip that references the asset.
Verdict: 🔺 **gap, two-stage**. Stage 1 (cheap, text-only): return metadata +
our stored thumbnails. Stage 2 (needs vision model + transcription): frames +
transcript. Proposed `inspectAsset({ assetId, window? })`.

**search_media** — semantic search over the library: visual matching (query
phrased like an image caption) and spoken matching (transcript keywords +
semantics), ranked as two independent groups, never blended. Hits are
source-second ranges designed to be passed straight into clip placement with
no unit conversion. An index-health object appears *only when* it explains
missing results (still indexing, model downloading, disabled…) so the agent
reports "still indexing" instead of "footage doesn't exist". Verdict: 🔺 **gap
— and our #3 build**. We shipped local CLIP visual search; this is one thin
verb: `searchMedia({ query, limit? }) → DirectorResult<{ hits: { assetId,
score, timeRange? }[], indexStatus? }>`. Include the conditional
`indexStatus` from day one (idea-poach #11) and the best-per-shot dedup +
relative cutoff (idea-poach #8).

**import_media** — pulls external media into the library from exactly one of:
an HTTPS URL (async download), a local path (file or recursive directory),
inline base64 bytes (small files only), or a generated solid-color matte.
Async imports return a placeholder id to poll via get_media. Strict
type/extension allow-list; everything else is rejected rather than transcoded.
Verdict: 🔺 **gap, medium**. For us: `importAsset({ url, name? })` fetching
into the media store (client-side fetch → OPFS/IndexedDB). Local-path and
directory modes are ⛔ (no filesystem); matte generation is a cute S-sized
extra (canvas-generated solid PNG) that makes "add a black background layer"
trivial for the agent.

**organize_media** — batch library housekeeping in one undoable action:
create folders, move items, rename, delete — items addressed by asset id,
timeline id, or folder path. Deleting an asset also removes every clip
referencing it and reports the count. Returns only what actually happened.
Verdict: ⛔ **for now** — our media panel has no folder tree. If folders land,
the design lesson is: one batch verb, ordered phases, references resolved
against pre-call state.

### 4. Clip and track operations (11 tools)

**add_clips** — batch-places assets on the timeline. Per entry: an asset
reference, an optional track index, a start position, and either an explicit
end (frame-exact fill) or a source range in seconds. Omitting track indexes on
*all* entries auto-creates shared tracks; mixing specified/omitted is rejected.
Same-track overlap resolves like a drag-overwrite (existing clips trimmed/
split/removed). A video with audio automatically spawns a linked audio clip. A
timeline id can be passed instead of an asset to nest it. Verdict: 🔺 **gap —
the other half of #3.** Our agent can only create *generative* slots; it
cannot place existing library/searched footage. Proposed `placeAsset({
assetId, startTime?, trackId?, sourceRange? }) → DirectorResult<{ elementId }>`
delegating to the existing add-element path. (Our vocabulary stays
seconds-based throughout.)

**insert_clips** — same placement, but *ripple*: everything at or after the
insertion point on the target track (and sync-locked tracks, and the linked-
audio track) shifts right by the inserted duration; nothing is overwritten.
Their doc frames it explicitly as the non-destructive counterpart to add.
Verdict: 🔺 **gap**. Our `reserveSlot` appends at the end or at an explicit
time but never ripples. Proposed either `insertSlot({ atTime, ... })` or a
`ripple: true` option on `reserveSlot`/`placeAsset`, implemented as a
transaction: shift all later elements, then place.

**move_clips** — batch move to a new track and/or start position; destination
overlap resolves like add; linked partners follow as a *delta* so deliberate
audio/video offsets survive. Verdict: ✅ **covered** by `move` (single-element;
batch is a nicety, linked-partner deltas become relevant only when we get
linked audio).

**remove_clips** — batch delete by id; a clip in a link group takes the whole
group. Verdict: ✅ **covered** by `remove` (single). Batch = trivial loop in a
transaction if the agent ever needs it.

**split_clips** — batch split, two addressing modes: explicit (clip id + frame)
pairs, or "cut this track at these frames" where each frame resolves to
whichever clip contains it (pairs naturally with transcript output). Multiple
cuts on one clip in one call; cut points must fall strictly inside a clip;
linked partners split at the same frame and the right-hand halves re-link.
Verdict: ✅ **covered** by `split` for the single case; the track-at-frames
mode is a nice-to-have once transcripts exist.

**ripple_delete_ranges** — the batch cut-and-close-gaps tool, their fast path
for dead-air/filler removal. Give it many ranges at once (project-frame ranges
spanning any clips on a track, or ranges inside a single clip in source
seconds); overlapping ranges merge; linked partners are cut in sync; later
clips shift left to close every gap; sync-locked tracks shift along, and if one
*can't* absorb the shift the call refuses, names the blocking track, and
documents the exact override parameter. Returns the post-cut track layout so
no re-read is needed. Verdict: 🔺 **gap**. We can `split`+`remove`+`reorder`
our way there in 3+ agent steps; one verb does it in one. Proposed
`cutRange({ ranges: {start, end}[], trackId? }) → DirectorResult<MutationDelta>`
— and it's the poster child for returning a delta with a shift rule.

**set_clip_properties** — batch-set uniform generic properties: duration,
source trims, speed (with automatic timeline-length rescale), volume, opacity,
static transform, blend mode. Explicitly forbids using raw transforms for
multi-clip layouts (that's the layout tool's job) and warns that setting a
static value clears any keyframe track on that property. Timing changes
propagate to linked partners; per-clip look fields don't. Verdict: 🟡
**partial**. `trim` covers timing; there is no agent path to speed/volume/
opacity/transform. Proposed `setSlotProperties({ slotId, speed?, volume?,
opacity?, transform? }) → DirectorResult<SlotSnapshot>` delegating to the
existing element-update path.

**set_keyframes** — replaces the whole keyframe track for one property of one
clip: volume, opacity, rotation, position, scale, or crop. Rows are
clip-relative (keyframes travel with the clip), each row = frame + values +
optional interpolation (linear/hold/smooth), last-duplicate-wins, empty array
clears. Their descriptions are painstaking about coordinate semantics (top-left
vs. center, normalized sizes vs. scale factors) — the hard-won lesson being
*document the coordinate system in the schema or the model will guess*.
Verdict: ⛔ **until our timeline has keyframes**; then it's a straight port of
the design.

**apply_layout** — the correct-by-construction compound op (idea-poach #9): a
named layout enum (side-by-side, top/bottom, four PIP corners, 2×2 grid,
70/30 main+sidebar, three-up) with named slots; the tool computes every
transform and cover-crop; anchor controls (coarse names or continuous 0–1
x/y) bias which part of the source survives the crop; letterbox mode opt-in.
Two modes: place fresh assets (stacked tracks auto-created) or re-frame
existing clips in place. Raw-transform layout building is *forbidden to the
agent* in prose. Verdict: 🔺 **gap** — proposed `applyLayout({ layout, slots:
{ name, slotIds }[] })`, worth it the day we have multi-track visual comps;
priority behind text/search.

**manage_tracks** — batch track ops: reorder stacking (constrained within
video/audio zones), set flags (mute, hide, sync-lock), remove tracks with
their clips. All indexes resolve against call-time order; returns the
resulting track order because indexes shift. Verdict: 🟡 **partial/deferred**.
Our verbs are slot-centric and tracks are implicit; first need appears with
multi-track layouts. When needed: `setTrack({ trackId, muted?, hidden? })`.

**sync_clips** — aligns clips to a reference by embedded timecode or audio
cross-correlation (dual-system sound / multicam), returning per-target offset
+ confidence + method, refusing weak matches. Verdict: ⛔ — irrelevant to a
generation-first reel tool; revisit only if we court real-footage editors.

**undo** — see *Agent-scoped undo* above. Verdict: 🟡 **partial** — we have
undo/redo, theirs is agent-scoped. Build #5.

### 5. Transcript-driven editing (4 tools)

All four sit on their on-device transcription/speech-analysis stack. For us
this whole category is gated on adding a transcription pipeline (Whisper-class
model server-side or WASM) — the *designs* below are what to copy when we do.

**get_transcript** — transcript of the *timeline* (not a source file): walks
every audio/video clip, maps each word through that clip's trim/speed/position
into timeline terms, concatenates in order. After cuts it reflects exactly
what's audible — no stale text. Words come back as compact
(index, text, start) rows where the **index is a stable global word number**;
a sentence-level granularity mode returns far cheaper rows that carry a
first-word-index to jump back into word mode. Speaker turns are run-length
encoded. Capped with pagination. Verdict: 🔺 **gap (gated)**. Proposed
`getTranscript({ window?, granularity? })` when transcription lands.

**remove_words** — Descript-style text-based editing: pass transcript word
indices (or index ranges), or exact filler tokens to purge everywhere; the
tool resolves words to time, absorbs surrounding pauses so survivors aren't
double-spaced, merges adjacent removals, cuts linked partners, closes gaps.
A tightness knob controls how much breathing room survives each cut. Refuses
edits spanning multiple unlinked tracks; indices go stale after any edit
(re-read first). *The agent never touches frame numbers — that's the whole
pitch.* Verdict: 🔺 **gap (gated)** — proposed `removeWords({ wordIndices?,
matchTokens? })`, the highest-value transcript verb.

**remove_silence** — removes speech-free dead air detected by on-device speech
analysis (level-relative so music beds survive), with boundary slop to avoid
clipped-feeling cuts; ripple-closes; no arguments at all. Verdict: 🔺 **gap
(gated)** — `removeSilence()`, after transcription.

**detect_beats** — on-device beat/downbeat detection on an asset's audio,
returning beat times in source seconds + bpm, with the downbeat/beat
distinction called out for musical vs. montage cutting. Analysis cached;
windows trim the response, not the work. Verdict: 🔺 **gap (independent!)** —
this one needs *no* transcription stack, only onset detection (doable with
web-audio/DSP or a small WASM lib). `detectBeats({ assetId }) →
DirectorResult<{ bpm, beats: number[], downbeats: number[] }>` unlocks
"cut my reel to the beat" — very on-brand for us.

### 6. Text and captions (3 tools)

**add_texts** — batch-adds text clips as timeline layers: content (multiline),
start/end, optional normalized text-box transform (center-only auto-fits
size), typography (font, size, bold/italic, color, alignment, outline,
background), an animation preset enum, and a per-word highlight color.
Omitting track on all entries creates one new top layer. Unknown fields
rejected. Verdict: 🔺 **gap — build #4.** `TextElement` already exists in
`types/timeline.ts` with content/font/style fields. Proposed `addText({
content, startTime, duration, style?, trackId? }) →
DirectorResult<{ elementId }>` delegating to the existing add-element path.

**update_text** — restyles/rewrites existing text clips by id — or an entire
caption group via its group id in one call: content, typography, transform,
animation. Content changes re-auto-fit the box unless a transform is passed.
Verdict: 🔺 **gap — build #4's second half.** `updateText({ elementId,
content?, style? })`.

**add_captions** — transcribes the timeline's spoken audio and creates a styled
caption track in one shot: no targeting needed, per-word animation timed from
the transcript, profanity masking, max-words-per-caption, letter-case
control. Returns a *group summary* (group id, clip count, frame range, style,
text preview) rather than hundreds of clip ids — restyling later goes through
the group id. Verdict: 🔺 **gap (gated on transcription)**. The group-summary
return shape is the design keeper: never make the agent hold N caption ids.

### 7. Color, effects, audio cleanup (4 tools)

**apply_color** — a full colorist surface as named knobs: exposure/contrast/
saturation/vibrance/temperature/tint, lift-gamma-gain-style tonal zones,
per-zone color wheels expressed as hue-angle + amount, master and per-channel
tone curves as control-point arrays, hue-targeted secondary correction
(shift/saturate/lighten a source hue without a mask), and LUT file application
with strength. Two behaviors worth stealing whenever we do grading: **merge
semantics** (only passed knobs change; a reset flag starts from neutral) and
**grade round-tripping** (the returned grade object is exactly what the
timeline read shows and exactly what the tool accepts — copying a grade
between clips is paste-back). Verdict: 🔺 **gap, deferred** — we have no
grading engine; when we add filters/LUTs, expose `applyColor({ slotIds,
...knobs })` with merge semantics from day one. Note the interplay with our
generation-side alternative: style consistency via `setConsistencyContext` +
film-look presets (idea-poach #14) covers much of the same user intent
*before* render, which is our wedge.

**apply_effect** — non-color effects (blur, sharpen, stylize, glow, keying…)
as a live effect stack: merge-by-type, per-effect enable/bypass without
removal, explicit remove list, out-of-range params clamped, fixed canonical
render order regardless of pass order, and the effect catalog with param
ranges/defaults is *generated into the tool description from the registry* —
a genuinely good trick (single source of truth; the schema can't drift from
the engine). Verdict: 🔺 **gap, deferred** — our `EffectElement` exists but
the engine is thin. When built: `applyEffect({ slotIds, effects, remove? })`
with the same merge model, and generate the catalog into the agent's tool doc
from our registry.

**inspect_color** — color *measurement*: black/white points, clipping %, mean
and per-channel levels, per-zone color tilt, saturation, warm-cool and
green-magenta balance, and a hue histogram — for a graded clip or a raw
asset, optionally *compared against a reference* image/video with a gap
readout phrased in the grading tool's own knob vocabulary. The intended loop
is grade → measure → read the gap → adjust. Verdict: ⛔ **near-term** (needs
the grading engine first), but the grade-by-the-numbers loop is the right
long-term answer to text-only agents doing color.

**denoise_audio** — background-noise removal via an on-device speech-
enhancement model, expressed as a dry/wet strength with a deliberately
conservative default because full strength sounds gated; bakes in the
background; disable flag removes it. Verdict: ⛔ — model is platform-specific;
if we ever want it, it's a server-side job on our media pipeline, not a
Director design problem.

### 8. Generation (5 tools)

Their generation model is **generate-to-library**: every generation returns a
placeholder *asset* id immediately, the render happens in the background, the
asset self-resolves in the library, and placement on the timeline is a
separate step. Ours is deliberately **generate-to-slot** (takes attached to a
timeline slot) — a real philosophical difference, and honestly ours is the
better default for a reel-first product: provenance, versioning (takes), and
placement come for free. The mapping below reflects that.

**list_models** — lists available models with per-model capability metadata:
supported durations, aspect ratios, resolutions, first/last-frame support,
reference-input caps, voices for TTS, upscaler speed class; typed by
video/image/audio/upscale. Explicitly returns a loaded flag so an empty list
during catalog sync isn't misread as "no models exist". Verdict: 🔺 **gap,
cheap** — `lib/studio/model-capabilities.ts` already scaffolds the catalog
(idea-poach #6). Proposed `listModels({ kind? }) →
DirectorResult<ModelCapability[]>` so the agent stops guessing valid
durations/resolutions for `GenerationSpec`.

**generate_video** — async text/image/video-to-video generation: prompt,
model, duration/aspect/resolution, first-frame and last-frame image inputs,
a source video for edit-style models (optionally scoped to a clip's trimmed
range only), and reference images/videos/audio addressed inside the prompt by
placeholder tokens. Guards: signed-in, has credits, plan-gated models fail
with a message telling the agent what to tell the user. Costs money, not
undoable. Verdict: ✅/🟡 **covered in our model** by `generate`/`reroll`/
`remix` + `GenerationSpec` (which already carries mode, resolution,
orientation, duration, seed, reference frames). Genuine deltas worth folding
into `GenerationSpec`/verbs rather than new verbs: multi-reference inputs, and
the trimmed-range-only source scoping. The entitlement-guard *pattern* (fail
early with a user-facing next step, and surface a `canGenerate` flag in
`getReel`) is worth copying now.

**generate_image** — same shape for stills: prompt, model, aspect,
resolution, quality tier, reference images. Verdict: ✅ **covered** —
`GenerationSpec.mode` handles image slots.

**generate_audio** — TTS (model + voice + delivery-style instructions),
text-to-music (lyrics, instrumental flag, duration), and video-to-audio
*scoring*: hand it a timeline span or a video asset and it generates matching
audio — and when you pass a timeline span, the result is **auto-placed on the
timeline at that span**, no separate placement call. Verdict: 🔺 **gap, high
product value** — voiceover + music is half of a finished reel. Proposed
`generateAudio({ kind: "tts" | "music" | "score", prompt, voice?, span? }) →
DirectorResult<{ slotId }>` running through our executor boundary as an
audio-typed take. Depends on provider adapter support; the auto-place-on-span
behavior is the design keeper.

**upscale_media** — async AI upscale of an asset, model chosen from the
upscaler catalog, optionally scoped to one clip's visible range. Verdict: 🔺
**gap, small** — natural fit as `upscaleTake({ slotId, takeId? })` appending a
higher-res take to the same slot (keeps our takes-as-versions story), pending
an upscale-capable provider in the adapter.

### 9. Meta (2 tools)

**send_feedback** — the agent files a product bug/limitation report when it
*can't do what the user asked*: category enum (missing capability, wrong
result, confusing UX, failure, suggestion), one-line summary, severity. Hard
privacy rule baked into the description: paraphrase everything, never include
verbatim user content; app version and recent tool names auto-attach; sends
without user confirmation. The executor feeds it from a per-session record of
recent tool successes/failures. Verdict: 🔺 **gap, cheap and sneaky-valuable**
— an agent-side capability-gap telemetry channel is exactly how you learn
what verbs to build next. Proposed `reportLimitation({ category, summary })`
POSTing to a simple endpoint (or just logging), with the same
paraphrase-only rule in our system prompt.

**read_skill** (in-app assistant only) — lazily loads the full body of a named
skill/playbook whose one-line descriptions are listed in the system prompt;
the agent calls it before starting a matching task. Classic progressive
disclosure to keep the base prompt small. Verdict: 🔺 **gap, nearly free** —
we already do the first half: `agent.ts` embeds `PLAYBOOK_POINTER`
(titles/descriptions only) precisely to keep the prompt small for a local
model, but there is **no way to load the full playbook**. Proposed
`readPlaybook({ id }) → DirectorResult<string>` returning the full text from
`lib/studio/playbooks.ts`. One afternoon, big quality win for UGC-style asks.

---

## Coverage summary

| Category | Their tools | ✅ covered | 🟡 partial | 🔺 gap | ⛔ n/a |
|---|---|---|---|---|---|
| Projects | 4 | — | — | (future MCP) | 4 today |
| Timeline reads/settings | 6 | — | get_timeline, export | inspect frame, duplicate reel, reel format | set-active (for now) |
| Media library | 5 | — | — | get/inspect/search/import | organize |
| Clips & tracks | 11 | move, remove, split | set-properties, tracks, undo | place, insert-ripple, cut-ranges, layout | sync, keyframes (for now) |
| Transcript | 4 | — | — | all 4 (3 gated on transcription; beats independent) | — |
| Text & captions | 3 | — | — | all 3 (captions gated) | — |
| Color/effects/audio | 4 | — | — | color, effects (deferred) | inspect-color (near-term), denoise |
| Generation | 5 | gen video/image (as slots/takes) | — | list models, gen audio, upscale | — |
| Meta | 2 | — | — | report limitation, read playbook | — |

Net: of their 44 tools, roughly **5 are already covered** by our slot/take
model, **5 are partial**, **~24 are genuine gaps** (about half immediately
buildable, half gated on transcription/grading/multi-timeline
infrastructure), and **~10 are n/a** for a web-based, generation-first
product today.

The single biggest *structural* difference: their agent is a **full editor
operator** (footage, transcript, color, layout) whose generation tools are
side-doors into a library; our agent is a **generation director** (storyboard,
takes, consistency) that is blind to footage, text, and audio. The five
build-first items close the cheapest, highest-leverage parts of that gap
without abandoning our generate-to-slot spine — which remains the thing they
don't have.

---

## Transport note (how they expose this surface)

Their tool layer is one shared executor consumed by two thin callers: the
in-app assistant (native function calls, plus the skill-loading tool) and a
loopback-only local HTTP MCP server on a fixed port (adds the four project
tools; registers every tool by mapping the same definitions into MCP schema
objects; also exposes MCP resources and server-level instructions text). The
executor never knows which transport called it. That is exactly the
`toolCatalog()` boundary idea-poach #4 tells us to formalize in
`director-api.ts` before any MCP work (#15) starts — this spec's proposed
verbs should all land *behind* that boundary so the future MCP server
enumerates them for free.

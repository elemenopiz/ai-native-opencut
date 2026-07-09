# Palmier Timeline/Project idea-poach implementation guide

Deep dive on **Palmier Pro**'s `Sources/PalmierPro/Timeline/` (18 files) and
`Sources/PalmierPro/Project/` (9 files), compared against our own timeline/
project/versioning stack. Sibling to `palmier-idea-poaches.md` (agent + tool
layer) and `palmier-mcp-schema-spec.md` (44-tool agent surface) — read those
first; this doc does not repeat anything they already cover (mutation-delta
responses, UUID short-ids, placeholder→finalize, agent-scoped undo, frames-vs-
seconds, caption/link groups, `apply_layout`, keyframe design, etc. are already
documented there).

> **License boundary — read first.** `palmier-pro` is **GPL-3.0** (Swift). Our
> web app is MIT. **Do not copy any code, types, schema JSON, parameter names,
> or literal strings** from `palmier-pro` into this repo — GPL-3.0 is copyleft
> and would force us to relicense. Everything below is an *idea/architecture*
> poach, described in prose from understanding, to be reimplemented from
> scratch in our own type system and our own code.

**Scope note.** The two assigned directories turned out to be almost entirely
SwiftUI *view/interaction* code (drag state machines, snap math, canvas
drawing, tab bars, onboarding screens) — not the core clip/track/project data
model the task expected there. The actual data model lives in
`Sources/PalmierPro/Models/Timeline.swift` and `Models/ProjectFile.swift`. To
answer the core questions this task asked (generative-clip representation,
nesting, versioning, undo patterns) I read those two files as well; they're
cited explicitly below wherever used. Everything else in this doc comes from
the 27 files actually inside `Timeline/` and `Project/`.

## Read this first: where we already exceed Palmier

Before the poach list — three places our own stack is **already more capable**
than what Palmier has, so nobody re-derives them as "gaps" later:

- **Version control.** Our `VersionManager`
  (`apps/web/src/core/managers/version-manager.ts`) is a full git-like system:
  branches, merge with conflict resolution, cherry-pick, rebase, bisect, stash,
  keyframe+delta commit storage, auto-commit. Palmier's only versioning
  primitive is `create_timeline` (duplicate a timeline, edit the copy) — no
  branches, no merge, no history graph. Nothing to poach here; if anything the
  direction of learning runs the other way.
- **Migration chain.** Our `services/storage/migrations/` is an explicit,
  numbered `v0-to-v1.ts` … `v9-to-v10.ts` sequence with a progress UI
  (`MigrationState`, `runStorageMigrations`). Palmier has one fallback: a
  bare-`Timeline` JSON blob (their pre-multi-timeline format) decodes by
  wrapping itself into a single-timeline `ProjectFile` (`Models/ProjectFile.swift:11-24`).
  That's a fine *one-time* compat shim but it's not a real migration system —
  ours is stronger for handling N breaking format changes over time.
- **Keyframe clamp/rescale is already generic.** Palmier hand-rolls
  `clampKeyframesToDuration()` / `rescaleKeyframes(by:)` per concrete field
  (`Models/Timeline.swift:352-395`) called from `setDuration()`. We already do
  the same *invariant* — clamp animations when a clip shrinks — through one
  type-agnostic `clampAnimationsToDuration()` called from
  `UpdateElementDurationCommand`
  (`apps/web/src/lib/commands/timeline/element/update-element-duration.ts:38`).
  Same correctness, less duplication on our side.
- **Transaction grouping already exists.** Palmier's
  `editor.undoManager?.beginUndoGrouping() / endUndoGrouping()` pattern
  (`TimelineInputController.swift:469-479`) is exactly our
  `CommandManager.beginTransaction()/commitTransaction()`
  (`apps/web/src/core/managers/commands.ts:73-96`), already wired through
  `TimelineManager`. No gap.

The real gaps are below.

## Priority summary

| # | Idea | Relevance | Effort | Priority |
|---|------|-----------|--------|----------|
| 1 | Content-addressed waveform/thumbnail cache | High | M | **P0** |
| 2 | Resume in-flight generations on project load | High | M | **P0** |
| 3 | Reference-based nested clips (wire up dead `CompoundClip`) | High | L | **P1** |
| 4 | Storage resilience: never let a bad parse become a bad write | High | S | **P1** |
| 5 | Generation audit log, independent of live timeline state | Medium | M | P1 |
| 6 | Snap stickiness + per-kind priority thresholds | Medium | S | P2 |
| 7 | No-op drag/commit guard audit | Medium | S | P2 |
| 8 | First-class per-clip fade in/out | Medium | S | P2 |
| 9 | Consistent id/group remap on duplicate (`freshenIds`) | Medium | S | P2 |
| 10 | Promote scene switcher to a persistent tab bar | Low–Medium | S | P2 |
| 11 | Sample projects with real agent chat history | High (strategic) | M | P2 |
| 12 | Persist Director chat sessions in project state | Medium | M | P3 |
| 13 | Project-settings mismatch dialog on first clip drop | Low | S | P3 |
| 14 | Per-scene timeline view state (zoom/scroll/playhead) | Low | S | P3 |

`S`=hours, `M`=1–3 days, `L`=1–2 weeks.

---

## 1. Content-addressed waveform/thumbnail cache (P0)

**What it is.** `MediaVisualCache` (`Timeline/MediaVisualCache.swift`) never
regenerates a waveform or video filmstrip it's already computed. Cache key =
SHA256 of `path|size|mtime` (`diskCacheKey`, lines 248-255) — edit the source
file and the key changes automatically; nothing needs an explicit invalidation
call except on relink (`invalidate(mediaRef)`). Waveforms persist as a raw
`Float32` binary blob, not JSON. Video thumbnails persist as **one JPEG sprite
sheet + a small JSON sidecar** (`tileWidth/tileHeight/columns/times`) instead
of one file per frame — the sidecar is written *last* so its mere existence is
the completeness marker (lines 275-332). Generation is rate-limited
(`AsyncSemaphore(value: 2)` for waveforms, `value: 4` for image thumbnails) so
it never starves playback decode, and long-video thumbnails publish
progressively every 50 frames instead of appearing all at once.

**Why it matters.** We have no equivalent. `AudioWaveform`
(`apps/web/src/components/editor/panels/timeline/audio-waveform.tsx:11-40`)
recomputes peaks from the live `AudioBuffer` via `wavesurfer.js` on every
mount — no disk/IndexedDB persistence, no content-hash cache key, so scrolling
a track in and out of view, or reopening a project, redoes the work. We found
no video-filmstrip-thumbnail generation at all in the timeline UI. On a
reel with a dozen clips this is a real, felt perf/battery cost, and it will
only get worse as reels get longer.

**How to implement.**
- Add an IndexedDB-backed cache (new table, e.g. `visualCache`) keyed on
  `${mediaId}:${byteLength}:${lastModified}` (browser equivalent of their
  path+size+mtime hash — we don't have file mtimes but MediaAsset metadata
  gives us the rest) so edits to the underlying blob change the key.
  - `waveform`: store the extracted `Float32Array` peaks directly (structured
    clone handles typed arrays natively in IndexedDB — no JSON encode needed).
  - `thumbnails`: render N `<canvas>` frames into one sprite-sheet `ImageBitmap`
    → blob, store `{ blob, tileWidth, tileHeight, columns, times }`.
- Gate concurrent extraction with a small semaphore (a `p-limit`-style helper,
  2 for waveform decode via `OfflineAudioContext`, a few more for canvas
  `drawImage` thumbnail sampling) so a reel with many clips doesn't stall
  playback.
- `AudioWaveform` becomes: check cache → hit, draw directly; miss, extract via
  `OfflineAudioContext`, draw, then write-through to the cache.
- Ties into `MediaManager` for the invalidate-on-relink hook if we ever add
  relink/replace-source.

## 2. Resume in-flight generations on project load (P0)

**What it is.** On `VideoProject` load, `restoreAssetsFromManifest()`
(`Project/VideoProject.swift:493-606`) checks every media entry: if
`asset.isRecoveringGeneration` (the process quit mid-generation), it's reset
to `.generating` and the whole batch is handed to
`editorViewModel.generationService.resumePendingGenerations(editor:)`
(line 600) — polling picks back up automatically. A partial *import* (not
generation) that was interrupted is instead marked `.failed("Import
interrupted")` rather than either silently vanishing or retrying forever.

**Why it matters.** This is the concrete mechanism the already-tracked
`palmier-idea-poaches.md` #5 (placeholder→finalize) and the "wiring TODO" in
our own code are pointing at but don't yet solve. Our
`hooks/use-generation-polling.ts` (`stores/generation-status-store.ts`) is
landed but **nothing calls it** — the file's own header says so explicitly
("Nothing currently calls this hook; wiring it into the timeline slot / Takes
grid is a later phase"). Today, if a user closes the tab or the app crashes
while a `Take.status` is `"queued"` or `"generating"`, that take has no path
back to a terminal state on reload — it's a placeholder clip stuck showing
"generating" forever with a dead `jobId` reference nobody re-polls.

**How to implement.**
- On `ProjectManager.loadProject` (`apps/web/src/core/managers/project-manager.ts:127`),
  after scenes are initialized, walk every track/element for `takes` with
  `status === "queued" || status === "generating"` (mirrors the shape already
  in `TimelineManager.getElementTakes`,
  `apps/web/src/core/managers/timeline-manager.ts:465-471`).
- For each recovered take, call `useGenerationPolling`'s underlying
  `startPolling(jobId, poll)` from `generation-status-store.ts` — the polling
  primitive already exists, it just needs a caller at load time instead of
  only at generate-time.
- If polling comes back "not found" / 404 for a job (server restarted, TTL
  expired), mark the take `status: "failed"` with a clear error, mirroring
  Palmier's "Import interrupted" degrade-gracefully move rather than leaving
  it stuck.
- This closes the loop `palmier-idea-poaches.md` #5 already flagged as needing
  `use-generation-polling.ts` + `generation-status-store.ts` wiring — this is
  the wiring.

## 3. Reference-based nested clips — wire up the dead `CompoundClip` (P1)

**What it is.** In Palmier a "clip" can *be* another timeline: `Clip.mediaRef`
holds a timeline id when `mediaType`/`sourceClipType == .sequence`
(`Models/Timeline.swift:37, 62`). `Timeline.reachableTimelines(resolve:maxDepth:include:)`
(lines 49-70) does a cycle-safe BFS over these references (a `seen: Set<String>`
guards against infinite loops from a timeline nested inside itself). This BFS
is what the mutation-delta doc's "only re-render if the touched timeline is
reachable from the active one" guard (`palmier-idea-poaches.md` #5) actually
runs on. Because nesting is **by reference** into `ProjectFile.timelines[]`
(not embedded), one nested sequence can be reused from multiple parent tracks
— edit it once, every parent that references it updates.

**Why it matters.** We already scaffolded the opposite shape and never wired
it up: `CompoundClip` in `apps/web/src/types/timeline.ts:375-386` has
`innerTracks: TimelineTrack[]` — an **embedded, owned copy** of tracks, not a
reference. We confirmed by grep that `CompoundClip` is unused anywhere else in
the codebase — it's dead scaffolding. Meanwhile we already have real
multi-timeline infrastructure that Palmier's `Timeline` array maps directly
onto: `TScene[]` via `ScenesManager`
(`apps/web/src/core/managers/scenes-manager.ts`). The natural port isn't to
finish `CompoundClip` as designed — it's to let a `VideoElement`/`ImageElement`
reference a **scene id** as its media (a "nested scene" clip), reusable across
tracks and scenes, with Palmier's BFS-reachability pattern reused for both
cycle prevention (a scene can't nest itself, directly or transitively) and the
already-documented re-render/reference-patching guards.

**How to implement.**
- Add an optional `nestedSceneId?: string` to `GenerativeFields`-adjacent base
  element fields (or a new discriminated variant) in `types/timeline.ts`,
  parallel to `mediaId` — when present, render/composite pulls frames from the
  referenced scene's tracks instead of a media asset.
- Port `reachableTimelines()` as `reachableScenes({ sceneId, resolve, maxDepth,
  include })` in `lib/scenes.ts`, used both to block creating a cycle (scene A
  can't nest a scene that transitively nests A) and, per idea-poach #5, to
  scope re-renders to only the timelines actually affected by a finalize.
- Drop (or repurpose) the dead `CompoundClip` type once the reference-based
  version lands — don't maintain two nesting primitives.
- This is genuinely L-effort (renderer, `scene-builder.ts`, and export all
  need to understand nested references) — sequence it behind the P0/P1 items
  above.

## 4. Storage resilience: never let a bad parse become a bad write (P1)

**What it is.** `VideoProject.applyLoadedContents` tracks
`manifestLoadFailed` (`Project/VideoProject.swift:37-39, 106-118`): if
`media.json` exists but fails to decode, Palmier does **not** treat that as
"empty manifest" for save purposes — `manifestSnapshot(manifest:loadFailed:)`
(lines 196-200) refuses to write an empty manifest back over a load failure,
so the next save preserves the original (possibly recoverable) file via
`copyPreservedFile` (lines 258-267) instead of silently destroying it. The
project stays open with media flagged offline rather than losing data.

**Why it matters.** This is a general storage-layer principle, not a
file-format detail: *a parse failure on read must never become a write of
empty/default state on the next save.* Our `runStorageMigrations`
(`apps/web/src/services/storage/migrations/runner.ts`) writes migrated records
back with `projectsAdapter.set(...)` per-migration (line 94) — worth an
explicit audit: if a migration transform throws or a project record is
malformed mid-chain, does anything downstream (autosave via `SaveManager`,
`ProjectManager.saveCurrentProject`) risk persisting a partially-recovered or
default-valued project over the original IndexedDB record? The migration
runner already has a `result.skipped` escape hatch (line 85-87) that looks
like it's guarding against exactly this, but it's worth a deliberate test:
corrupt a project record, confirm the app degrades (error banner, keep old
data) rather than silently overwriting it with an empty new one.

**How to implement.**
- Audit `ProjectManager.saveCurrentProject` / `SaveManager` for any path where
  a project object with an empty/default `scenes` array could get written
  over IndexedDB data that failed to fully load.
- Add a guard: if `loadProject` catches a decode error partway through
  (scenes parse but media manifest doesn't, or vice versa), don't let the
  in-memory partial state autosave until the user explicitly acknowledges/
  retries — mirror Palmier's "degrade to offline, preserve the file" move
  rather than "best-effort merge and save."

## 5. Generation audit log, independent of live timeline state (P1)

**What it is.** Palmier's project package carries a `generation-log.json`
(`Project.generationLogFilename`, referenced throughout
`VideoProject.swift:120-121, 226-227, 401-406`) that is a **separate file from
the timeline**. It records every generation ever run for the project, and
survives clip deletion or timeline edits. If it's ever missing (e.g. an old
project), `editorViewModel.seedGenerationLogFromAssets()` (line 406)
reconstructs a best-effort log from surviving asset metadata rather than
starting blank.

**Why it matters.** This is different from — and complements —
`palmier-idea-poaches.md` #12 (clip generation-provenance panel), which is
about inspecting a *currently-existing* clip's recipe. A generation log is a
project-wide, append-only ledger that answers "what did we generate and what
did it cost, across the whole project's life" even after a take is deleted,
a slot is cleared, or a scene is removed — directly useful for cost tracking
(`lib/studio/cost.ts`) and for a "regeneration history" view that outlives any
single clip.

**How to implement.**
- Add a lightweight `generationLog` array to project persistence (or a
  separate IndexedDB store keyed by project id, so it isn't reserialized on
  every scene edit): `{ id, elementId?, spec: GenerationSpec, seed, model,
  costCredits?, createdAt, resultTakeId? }`, appended whenever
  `TimelineManager.addTakeToElement` runs.
- Keep it append-only and independent of `takes[]` on the element — deleting a
  take or the whole element must not delete its log entry.
- Cheap win once it exists: a project-level "Generation History" panel and a
  server-side cost rollup, both currently impossible since we only know about
  takes still attached to a live clip.

## 6. Snap stickiness + per-kind priority thresholds (P2)

**What it is.** `SnapEngine.findSnap` (`Timeline/SnapEngine.swift:64-107`) has
two things our `findSnapPoints`
(`apps/web/src/lib/timeline/snap-utils.ts`) doesn't: **sticky/hysteresis**
snapping (once snapped, stay snapped until the cursor moves `2.5×` the base
threshold away — `Snap.stickyMultiplier`, lines 75-84 — so snap doesn't
flicker right at the threshold boundary), and **per-target-kind thresholds**
(the playhead gets a wider capture radius than a plain clip edge —
`Snap.playheadMultiplier`, line 92-94 — so it's easier to land exactly on the
playhead when scrubbing near it).

**Why it matters.** Our snap system actually has *more kinds* of snap points
already (element-start/end, playhead, bookmark, **and** keyframe — Palmier
only has clip-edge/playhead/beat) — this isn't a capability gap, it's a feel
gap. Sticky snapping is a small, well-understood UX polish item that's
noticeable the moment it's missing on a trim/move interaction.

**How to implement.**
- Add a `SnapState { currentlySnappedTo, currentProbeOffset }` carried across
  drag ticks in whatever hook owns drag state (`use-element-interaction.ts`),
  with a hold threshold of `baseThreshold × 2.5` before releasing.
- Give `SnapPoint.type === "playhead"` (and maybe `"bookmark"`) a wider
  effective threshold than `"element-start"/"element-end"` in
  `findSnapPoints`'s distance comparison.
- Natural pairing with the already-tracked `detectBeats()` agent verb
  (`palmier-mcp-schema-spec.md`) — once beats exist, add `"beat"` as a fourth
  snap-point type for free.

## 7. No-op drag/commit guard audit (P2)

**What it is.** Every drag case in `TimelineInputController.mouseUp`
(`Timeline/TimelineInputController.swift:437-539`) checks whether the drag
actually changed anything before committing: a move with `deltaFrames == 0`
and no track change is a no-op (`break`, line 442-445); a volume-keyframe or
fade-knee drag that ends where it started calls
`editor.revertClipProperty(clipId:)` instead of committing (lines 510-522).
Nothing gets pushed onto the undo stack for a click that didn't actually move
anything.

**Why it matters.** We spot-checked one call site —
`use-element-interaction.ts:451-458/463-469` — where `editor.timeline.moveElement(...)`
(which pushes a `MoveElementCommand` onto history,
`apps/web/src/core/managers/timeline-manager.ts:158-167`) fires on drop with
no visible guard for "did `newStartTime`/`targetTrackId` actually change from
where the element started." We did not verify whether `MoveElementCommand`
itself no-ops internally on an identical before/after snapshot — that's the
thing to check first. If it doesn't, every click-without-drag on a clip is
quietly polluting undo history with a redundant entry, which both wastes
memory and makes "undo" feel wrong (undoing a click does something visible
even though nothing should have changed).

**How to implement.**
- Audit `MoveElementCommand`, `UpdateElementTrimCommand`, and the keyframe
  drag-commit paths for a before/after equality check before pushing to
  history; add one where missing (delta-based commands are the easy case —
  just check `delta !== 0` at the call site before invoking the manager
  method, mirroring Palmier's `if drag.deltaFrames != 0`).

## 8. First-class per-clip fade in/out (P2)

**What it is.** `Clip.fadeInFrames`/`fadeOutFrames` plus a per-edge
`Interpolation` (`linear`/`smooth`) are first-class clip fields
(`Models/Timeline.swift:156-159`), composed as a multiplicative envelope
(`fadeMultiplier(at:)`, lines 300-316) layered under keyframe volume
automation and the clip's static volume/opacity
(`volumeAt(frame:)`/`opacityAt(frame:)`, lines 209-277). Dragging a fade
"knee" handle is its own `DragState` case
(`Timeline/DragState.swift:29-36`), separate from generic keyframe dragging.

**Why it matters.** This is the same "correct-by-construction primitive over
raw keyframes" philosophy already documented for `apply_layout`
(`palmier-idea-poaches.md` #9) applied to audio/video fades. We have a fully
general keyframe system (`ANIMATION_PROPERTY_PATHS` includes `opacity` and
`volume`, `apps/web/src/types/animation.ts`) but no explicit fade concept — a
user (or an agent, once `setSlotProperties`-style verbs exist per
`palmier-mcp-schema-spec.md`) has to hand-build a 2-point keyframe curve to
fade a clip in, instead of "fade in over 12 frames."

**How to implement.**
- Add `fadeInDuration?`/`fadeOutDuration?` (+ optional interpolation) to
  `BaseTimelineElement` or specifically video/audio elements in
  `types/timeline.ts`.
- Compute the fade envelope at render/export time as a multiplier on top of
  whatever opacity/volume keyframes already resolve to (same layering
  Palmier uses) — no change needed to the existing keyframe system, this is
  additive.
- Cheap agent win later: a `setFade({ slotId, edge, frames })` verb is a
  one-line addition once the field exists, much cheaper for an LLM to emit
  correctly than a keyframe pair.

## 9. Consistent id/group remap on duplicate — `freshenIds` (P2)

**What it is.** `Clip.freshenIds(groups: inout [String: String])`
(`Models/Timeline.swift:333-344`) gives a duplicated clip a fresh id, and
remaps its `linkGroupId`/`captionGroupId` through a **shared dictionary**
threaded across the whole duplicate operation — so if you duplicate ten clips
that share a caption group, they end up sharing one *new* caption group
consistently, not each getting an independent new id (which would silently
break the group).

**Why it matters.** We already have the same class of shared-id problem:
`DuplicateElementsCommand` (used by `TimelineManager.duplicateElements`,
`apps/web/src/core/managers/timeline-manager.ts:771-779`) and any future
scene-duplication or `VersionManager.cherryPickCommit`/merge path that copies
multiple linked elements at once. If/when we add link groups (video+audio
pairs) or caption groups (per the already-documented caption-group-collapse
idea in `palmier-mcp-schema-spec.md`), duplicating a multi-element selection
needs exactly this "one remap table for the whole batch" discipline or groups
silently desync on copy.

**How to implement.**
- Add a small `remapGroupIds(ids, groupMap)` helper in `lib/timeline/` mirroring
  the two-line pattern in `freshenIds`: look up in a shared `Map<string,
  string>`, generate-and-cache on miss.
- Thread one `groupMap` through `DuplicateElementsCommand`'s whole batch (not
  a fresh map per element) — the bug this prevents only shows up with ≥2
  grouped elements duplicated together, so a single-element test won't catch
  a regression here.

## 10. Promote the scene switcher to a persistent tab bar (P2)

**What it is.** `TimelineTabBar` (`Timeline/TimelineTabBar.swift`) is an
always-visible tab strip above the timeline: `openTimelineIds` (a subset,
browser-tab style) vs. `allTabs` (every timeline, reachable via an overflow
"…" menu even if not currently "open"), with rename/duplicate/close/close-
others/delete all live in a per-tab context menu.

**Why it matters.** We already have the full data-model and command layer
this needs — `ScenesManager` supports `createScene`, `deleteScene`,
`renameScene`, `switchToScene` — but the only UI we found,
`components/editor/scenes-view.tsx`, is a `Sheet` (slide-over drawer) with a
grid of scene cards, opened on demand rather than always visible. That's a
fine "manage scenes" surface but it's a heavier interaction than Palmier's
one-click tab switch for the common case of "I have 2-3 scenes and want to
flip between them constantly while editing."

**How to implement.**
- Add a thin tab strip above the timeline panel (reuse whatever tab-strip
  primitive exists in `components/ui/`) bound to `editor.scenes.getScenes()`
  / `switchToScene`; keep `ScenesView`'s sheet as the "manage all scenes"
  overflow entry point rather than replacing it.
- Low effort since zero new manager/command work is needed — purely a new
  view over existing `ScenesManager` state.

## 11. Sample projects with real agent chat history (P2, strategic)

**What it is.** `SampleProjectService` (`Project/SampleProjectService.swift`)
downloads curated example projects on demand (not bundled in the binary) —
each one a full `.palmier` package including real generated clips **and
recorded AI chat transcripts** in a `chat/` directory. `WelcomeOverlay`'s
"Watch Tutorial" button (`Project/WelcomeOverlay.swift:84-100`) opens the
first sample and auto-starts a guided walkthrough grounded in real agent
conversation history, not a scripted fake.

**Why it matters.** This is a strong "show, don't tell" onboarding move
exactly matched to our positioning (AI-native editor, agent does real work).
A new user's first five minutes seeing an actual Director conversation that
produced an actual finished reel is more convincing than any empty-state copy.

**How to implement.**
- Ship 2-3 curated example projects (IndexedDB-importable bundles: scenes +
  media refs + a recorded Director transcript) fetched lazily from a small
  API route rather than baked into the client bundle.
- Gate on #12 below (Director session persistence) existing first — there's
  no transcript to ship until sessions are actually saved somewhere.
- Reuse for the empty-editor-guide / onboarding flow
  (`apps/web/src/components/editor/onboarding.tsx`,
  `empty-editor-guide.tsx` already exist as hook points).

## 12. Persist Director chat sessions in project state (P3)

**What it is.** Every AI chat session in Palmier is saved as its own JSON
file inside the project package
(`ChatSessionStore.encodeSession`, referenced in `VideoProject.swift:188-192,
247-256`), keyed by session UUID, only sessions with actual messages — so
reopening a project restores prior agent conversations instead of losing them.

**Why it matters.** We grepped for a Director/agent chat store and found
none — conversation history in `lib/director/agent.ts` appears to be ephemeral
component state, gone on reload. That's a real loss for a product whose pitch
is "the agent is a first-class collaborator" — the record of what you asked
it to do and why disappears the moment you refresh.

**How to implement.**
- Add a `directorSessions` IndexedDB store keyed by `projectId` + session id,
  written incrementally as messages land (not just on project save, so a
  crash mid-conversation doesn't lose it).
- Load on project open, offered as a "resume conversation" affordance in
  whichever panel hosts the Director chat UI.
- Direct prerequisite for #11 (sample projects need a transcript format to
  exist before one can be shipped).

## 13. Project-settings mismatch dialog on first clip drop (P3)

**What it is.** `ProjectSettingsMismatchView`
(`Project/ProjectSettingsMismatchView.swift`) fires when a clip being added
has a different fps/resolution than the current project and offers "Keep
Current" vs. "Change to Match" (which auto-applies the clip's fps/resolution
to the whole project).

**Why it matters.** Small but real first-run polish: today a new project
silently locks to `DEFAULT_FPS`/`DEFAULT_CANVAS_SIZE`
(`apps/web/src/core/managers/project-manager.ts:96-98`) regardless of what the
user's first real footage or generated clip actually is, with no prompt to
reconsider.

**How to implement.**
- On the first non-generative-placeholder clip added to an otherwise-empty
  project, compare its native resolution/fps to `TProjectSettings` and, if
  they differ, show a small confirm dialog offering to adopt the clip's
  format — same "Keep Current / Change to Match" framing.

## 14. Per-scene timeline view state (P3)

**What it is.** `TimelineViewState` (`Models/Timeline.swift:10-14`) —
playhead frame, zoom, scroll offset — is stored **per timeline** in
`ProjectFile.viewStates: [String: TimelineViewState]`, restored per-tab on
switch. Explicitly noted as "written on tab switch and save, not live" to
avoid autosave storms from a 60fps-updating playhead.

**Why it matters.** Our `TProject.timelineViewState`
(`apps/web/src/types/project.ts:37-41, 49`) is a single project-global field.
Now that we have real multi-scene support, switching scenes likely resets or
shares zoom/scroll/playhead instead of restoring where the user left off in
that specific scene — a small but noticeable rough edge once #10's tab bar
makes scene-switching more frequent.

**How to implement.**
- Change `TProject.timelineViewState` to `Record<sceneId, TTimelineViewState>`
  (or store it on `TScene` itself, next to `bookmarks`/`markers` which are
  already per-scene); update `ProjectManager.setTimelineViewState`/
  `getTimelineViewState` to key off the active scene id.
- Keep the existing "checkpoint on switch/save, not live" discipline — no
  need to write it on every playhead tick.

---

## Sequencing recommendation

1. **Reliability batch (P0):** #1 (visual cache) and #2 (resume generations)
   are independent, high-value, and don't touch the data model — do these
   first.
2. **Data model (P1):** #3 (reference nesting) is the biggest lift and should
   land before anything else in this doc depends on multi-timeline reuse
   (notably #5's per-project audit trail benefits from it but doesn't require
   it). #4 (storage resilience audit) is cheap and should happen alongside
   any work that touches `ProjectManager`/migrations regardless.
3. **Polish batch (P2):** #6-#10 are all small, independent, UI/interaction
   quality-of-life items — good candidates for a single low-context sprint.
4. **Onboarding pair (P2→P3):** #12 (session persistence) unlocks #11 (sample
   projects) — do them in that order, not in parallel.
5. **Nice-to-haves (P3):** #13, #14 whenever touching their respective files
   for other reasons.

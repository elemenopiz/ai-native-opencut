# Palmier generation-pipeline idea-poach implementation guide

Architectural and product ideas worth taking from **Palmier Pro**'s generation
engine (`Sources/PalmierPro/Generation/` — 28 files: catalog, job submission,
credit/cost accounting, upload staging — and `Sources/PalmierPro/Models/` —
17 files: `MediaAsset`, `GenerationInput`, `MediaManifest`, `MediaResolver`)
and how to apply each to our codebase.

> **License boundary — read first.** `palmier-pro` is **GPL-3.0** (Swift). Our
> web app is MIT. **Do not copy any code, types, or literal strings** from
> `palmier-pro` into this repo — GPL-3.0 is copyleft and would force us to
> relicense. Everything below is an *idea/architecture* poach: reimplement from
> our own understanding, in our own code and type system
> (`GenerationSpec`/`Take`/`GenerationJobState`), never transcribed from
> theirs.

**Scope note.** This doc is sibling to `palmier-idea-poaches.md` (Agent/Tools
+ product ideas) and `palmier-mcp-schema-spec.md` (44-tool agent surface).
Both already cover the agent-facing side of generation (`list_models`,
`generate_video/image/audio`, `upscale_media`, mutation-delta, placeholder→
finalize, server-driven catalog as idea #6). **This doc covers what those two
don't**: the actual submission/polling/cost/catalog *plumbing* underneath the
agent tools and the manual UI, found only by reading
`Generation/`+`Models/` file by file. Where an idea here overlaps a tool-level
concept already ranked in `palmier-idea-poaches.md` (e.g. server-driven
catalog #6, provenance panel #12, first/last-frame #13), it's cross-referenced
rather than re-ranked.

## Priority summary

| # | Idea | Relevance | Effort | Priority |
|---|------|-----------|--------|----------|
| 1 | Rich per-model capability schema + pre-submit `validate()` | High | M | **P0** |
| 2 | Batch N-variation generation as one job, not N round trips | High | M | **P0** |
| 3 | Decouple "generation succeeded" from "import succeeded" + retry-import | High | S | **P0** |
| 4 | Cost estimator driven by the model catalog (2D lookups, recompute-on-rerun) | Medium | M | P1 |
| 5 | Error taxonomy: expected vs. unexpected submit failures | Medium | S | P1 |
| 6 | Downscale oversized reference video before upload | High | S | P1 |
| 7 | Resumable generation across page reload | Medium | M | P1 |
| 8 | Real-time job updates instead of fixed-interval polling | Medium | M | P1 |
| 9 | Declarative per-clip AI-action gating with human-readable disabled reasons | Medium | S–M | P2 |
| 10 | Model-existence-checked regenerate/rerun guard | Medium | S | P2 |
| 11 | Per-model ETA surfaced during generation (`p75DurationSeconds`) | Low | S | P2 |
| 12 | Split "recipe" from "wire params" (`GenerationInput` vs `*GenerationParams`) | Medium | S | P2 |
| 13 | Low-res proxy export for video-to-audio scoring input | Low | M | P2 |
| 14 | User-level model hide/show preferences | Low | S | P3 |
| 15 | Server-authoritative cost/credits on the completed job | Strategic | — | P3 |

`S`=hours, `M`=1–3 days, `L`=1–2 weeks.

---

## P0 — wire the dead catalog, fix the two real gaps

### 1. Rich per-model capability schema + pre-submit `validate()` (P0)

**What it is.** Palmier's `VideoModelConfig`/`ImageModelConfig`/`AudioModelConfig`
(`Generation/Catalog/*Config.swift`) aren't just capability *flags* — each has
a `validate(...)` method returning a self-describing error naming the field,
the offered value, and the full allowed list (`unsupportedValue(model:field:
value:allowed:)` in `VideoModelConfig.swift`), called **before** any network
request. The schema itself is richer than a boolean per feature:
`maxReferenceImages`/`maxReferenceVideos`/`maxReferenceAudios` are separate
*counts*, `maxTotalReferences` caps the combined count, `maxCombinedVideoRefSeconds`/
`maxCombinedAudioRefSeconds` cap combined *duration* (not just count),
`framesAndReferencesExclusive` flags models where first/last-frame mode and
omni-reference mode can't be mixed, and `requiresSourceVideo`/
`requiresReferenceImage` distinguish edit-style models from generate-style
ones. `VideoGenerationSubmission.InputAssets.validate(for:)` runs the whole
battery — reference type-checking included (`referenceImageMediaRefs entry
'X' must be a image asset`) — right before building the submit body.

**Why it matters.** This is the missing piece that turns our already-ported-
but-unwired `lib/studio/model-capabilities.ts` into something that actually
prevents bad requests. Today nothing stops a caller (manual UI, Director
agent, a future MCP surface) from asking Seedance for an 800p resolution or a
30-second duration — the request just goes to BytePlus and fails remotely,
burning a round trip (and, once we meter credits, real money) on a mistake
we could catch client-side in microseconds. The mcp-schema-spec doc already
flags `listModels` as a **gap, cheap** agent verb (build #6 in that doc's
"build these first" list) — this idea is what that verb should actually
*validate against* once it exists, and what our manual `generation-form.tsx`
should call before hitting submit too.

**How to implement.**
- Extend `apps/web/src/lib/studio/model-capabilities.ts`'s
  `VideoModelCapabilities`/`ImageModelCapabilities` with the count/duration
  caps we're missing: `maxReferenceImages`, `maxReferenceVideos`,
  `maxTotalReferences`, `maxCombinedVideoRefSeconds` (Seedance's omni-reference
  almost certainly has *some* such cap even if undocumented — start
  conservative and tighten from observed API errors), and a
  `framesAndReferencesExclusive` flag if `lastFrameUrl` + `referenceImages`
  can't coexist on Seedance 2.0 (verify against the live API — the current
  `provider-adapter.ts` comment block doesn't say either way).
- Add `validateGenerationSpec(spec: GenerationSpec): string | null` next to
  the catalog, mirroring `VideoModelConfig.validate` — check duration range
  (`durationRangeSec`), resolution/orientation membership, and reference
  counts, each failure naming the field/value/allowed set like their
  `unsupportedValue` helper (not our own literal string, our own message
  format).
- Call it in three places: `generation-form.tsx` before submit (inline error,
  no round trip), `apps/web/src/app/api/studio/generate/route.ts` as a
  server-side guard (never trust the client), and — once built — the agent's
  `generate`/`reroll` verbs in `director-api.ts`.
- This is what makes `model-capabilities.ts`'s own "WIRING TODO" comment
  finally true.

### 2. Batch N-variation generation as one job, not N round trips (P0)

**What it is.** When Palmier generates multiple variations
(`GenerationService.generate(..., numImages: Int)`, clamped `1...4`), it
creates `count` placeholder assets up front, submits **one** backend job
carrying the batch size, and fans the returned `resultUrls` back out to each
placeholder by `outputIndex` on completion — one submit, one poll/subscribe
loop, N results. If the backend returns fewer URLs than placeholders, the
extras are marked failed individually rather than the whole batch failing.

**Why it matters — this is a real, measurable inefficiency in what we ship
today.** Our `useSlotGeneration.generateIntoSlot` (`hooks/use-slot-generation.ts`)
implements "N alternatives" as a literal `for` loop calling
`generateTakeMedia` — full submit-and-poll-to-completion — **sequentially, N
times**, `await`ing each one before starting the next. Requesting 4
alternative takes today means 4 separate BytePlus job submissions and 4
independent poll loops run one after another, when the same request could be
1 submission (if BytePlus's API supports a batch/count parameter — check the
ModelArk docs) or, failing that, at minimum 4 *concurrent* submissions
instead of 4 *sequential* ones. Sequential-await is the bigger bug: it makes
"generate 4 takes" take ~4× as long in wall-clock time as it needs to, for no
benefit — the requests are independent.

**How to implement.**
- Cheapest, no-provider-change fix: in `use-slot-generation.ts`, change
  `generateIntoSlot`'s loop from sequential `await`-in-a-`for` to
  `Promise.all` (or a small concurrency-limited fan-out if we're worried
  about hammering BytePlus) — same number of provider calls, but they run in
  parallel instead of serially. This alone fixes the wall-clock problem with
  no adapter changes.
- Better, if BytePlus ModelArk's video-task API accepts an item/count field
  for generating N variants from one submission (check
  `docs.byteplus.com/en/docs/ModelArk/1520757` for a batch parameter) — add
  it to `GenerateVideoParams` in `provider-adapter.ts` and have
  `generateTakeMedia` (`lib/studio/generate-take.ts`) accept a `count` and
  return N results per job, mirroring Palmier's `outputIndex` fan-out. This
  cuts both round-trip count *and* removes N-way poll overhead.
- Either way, keep the "auto-select first ready take" behavior
  (`selectIfFirst`) — Palmier's `FirstOnlyFlag` pattern (guard so only the
  first successful output of a batch fires the "replace clip" callback) is
  the right guard once results can arrive concurrently/out of order.

### 3. Decouple "generation succeeded" from "import succeeded" (P0)

**What it is.** Palmier tracks two independently-failable steps as separate
states: `.generating` (provider job running) → `.downloading` (provider
returned a URL, now pulling bytes locally) with a distinct `pendingDownloadURL`
field. If the download/finalize step fails after generation *already
succeeded* (network hiccup, disk error), `downloadAndFinalize` stores the
remote URL on `asset.pendingDownloadURL` and marks the asset `.failed` — but
`retryDownload(asset:editor:)` can re-run **just the download**, without
re-submitting to the (often paid, non-refundable per their own docs) provider.

**Why it matters.** Look at `importVideoAsset` in
`apps/web/src/lib/studio/generate-take.ts` (lines 14–30) and
`generateTakeMedia`'s call site (lines 104–110): if
`importVideoAsset` throws — the same-origin proxy fetch fails, `blob()`
errors, `processMediaAssets` chokes on the file, `editor.media.addMediaAsset`
throws — the `catch` block at the bottom of `generateTakeMedia` swallows it
into a generic `{status:"failed", error}`, and the take's already-completed,
already-paid-for `videoUrl` is discarded entirely. The only recovery today is
regenerating from scratch, which re-runs (and re-bills) the BytePlus job for
a failure that had nothing to do with BytePlus. This is a narrow but real
robustness gap, and it's the cheapest of the three P0s to close.

**How to implement.**
- In `types/timeline.ts`'s `Take`, add an optional `resolvedVideoUrl?: string`
  (or reuse `jobId` + a `TakeStatus` value like `"importing"` distinct from
  `"generating"`) so a take can be "provider done, import pending" as a
  distinct, resumable state — mirroring Palmier's `.downloading` status +
  `pendingDownloadURL`.
- Split `generateTakeMedia` into two awaitable phases: `submitAndPoll(spec) →
  { videoUrl, seed }` (already-existing logic, lines 62–102) and
  `importResult(editor, projectId, videoUrl, name) → GenerateTakeResult`
  (existing `importVideoAsset` call, lines 104–110). Catch failures around
  *only* the import phase separately, persist `resolvedVideoUrl` on the take
  before attempting import, and expose a `retryImport(take)` entry point in
  `use-slot-generation.ts` that calls only the second phase when
  `resolvedVideoUrl` is already present.
- Surface a "Retry import" action (distinct from "Regenerate") in the take UI
  wherever failed takes are shown, so the user isn't nudged toward a
  redundant paid regeneration for what was actually a local/network hiccup.

---

## P1 — cost, safety, and freshness

### 4. Cost estimator driven by the model catalog (P1)

**What it is.** `CostEstimator.swift` computes cost per model *kind* from the
catalog entry itself (`creditsPerSecond`/`creditsPerImage` dictionaries keyed
by resolution or `"resolution|quality"` compound keys, falling back to a
resolution-agnostic `""` key), not a hardcoded table — and exposes
`cost(for: GenerationInput)` so a **rerun** recomputes cost from the model's
*current* catalog entry rather than trusting a stale number from when the
asset was first generated (pricing can change between the original run and a
rerun months later).

**Why it matters.** Our `lib/studio/cost.ts` is a flat, hand-maintained
`RATE_PER_SEC` table keyed only by `VideoResolution`, entirely decoupled from
`model-capabilities.ts` — if we ever add a second model (the adapter's own
comment says "could slot in later"), `cost.ts` won't know it exists. It's
also purely a *live estimate* for the current form state; there's no
`estimateCost`-equivalent that takes a persisted `GenerationSpec` (e.g. for a
provenance-panel "regenerate" button, idea-poach #12 in the sibling doc) and
recomputes what *that* recipe would cost today.

**How to implement.**
- Move the `RATE_PER_SEC` table's data into `model-capabilities.ts`'s
  `VideoModelCapabilities` (a `creditsPerSecond`-shaped field, even if it's
  USD not credits today) so cost lives next to capability, and have
  `cost.ts`'s `estimateCost` read the rate from the catalog entry for
  `spec.provider`/`spec.model` instead of a standalone table.
  keyed the way Palmier's `resolvedRate` falls back (`dict[resolution] ??
  dict[""]`) so a model without per-resolution pricing still works.
  - Note: this doesn't require credits/billing to exist yet — USD range
    estimation is exactly what we do today, just make it catalog-driven so a
    second model or a resolution-dependent price tier doesn't require
    touching `cost.ts`.
- Add `costForSpec(spec: GenerationSpec): {low,high} | null` reading the
  catalog by `spec.model`, so provenance-panel regenerate (idea-poach #12)
  and rerun can show "this will cost ~$X" from the stored recipe, not just
  the live form.

### 5. Error taxonomy: expected vs. unexpected submit failures (P1)

**What it is.** `GenerationService.runJob`'s catch block classifies submit
errors into an `expected` set (`insufficient_credits`, `subscription_required`,
`plan_required`, `rate_limited`, `invalid_params`) logged at `.warning`
(local only), versus anything else logged at `.error` (which their logger
routes to Sentry). The distinction exists purely so their crash-reporting
signal isn't drowned by routine, user-facing failures like "you're out of
credits."

**Why it matters.** We don't have this distinction anywhere in
`provider-adapter.ts`/`generate-take.ts`/the `/api/studio/generate` route
today — every BytePlus failure (a malformed prompt, a transient 503, an
actual bug in our request-building) surfaces identically. This is cheap now
and gets more valuable the moment we wire real monitoring/alerting (Sentry or
otherwise) on the API routes — without it, "user hit a rate limit" and "we
have a bug" look the same in the alert stream.

**How to implement.**
- Define an error-code union in `provider-adapter.ts` covering the
  BytePlus failure modes we actually see (map `mapByteplusStatus`'s
  `"failed"`/`"expired"`/`"cancelled"` plus HTTP-level 4xx codes into named
  codes) and a small `EXPECTED_CODES` set (rate-limited, invalid-params-class
  4xxs) vs. everything else.
- In the `/api/studio/generate` route and `generate-take.ts`'s catch blocks,
  log expected codes at a lower severity / skip alerting, and let genuinely
  unexpected errors bubble to whatever monitoring we add later. Low effort,
  pure logging hygiene, no behavior change to the user-facing error message.

### 6. Downscale oversized reference video before upload (P1)

**What it is.** `VideoCompressor.compressIfNeeded(url:maxLongSide:)` checks a
reference video's long-side pixel dimension against the target model's known
cap (their comment: "keep reference videos inside model size caps (e.g.
Seedance's ~1112 px max long side)") and transcodes down to 960×540 *only
when* the source exceeds it — smaller sources pass through untouched. It's
wired specifically into the omni-reference video path in
`VideoGenerationSubmission.make` (`preprocessRef` closure, only when
`videoRefs` is non-empty).

**Why it matters — this literally names our provider.** Their comment cites
Seedance's ~1112px long-side cap as the reason this exists, and our
`provider-adapter.ts` calls the exact same model (`referenceVideos` →
`role: "reference_video"` in `byteplusSubmit`). If a user drops a 4K reference
video into the omni-reference slot today, we upload it as-is with no
client-side check — best case BytePlus silently downscales it server-side
(wasted upload bandwidth/time), worst case the request is rejected or the
oversized reference is ignored/degrades quality, and we have no visibility
into which happened.

**How to implement.**
- We're a web app, so this becomes a browser-side (canvas/`MediaRecorder` or
  a `ffmpeg.wasm` pass, whichever we're already using for other media
  processing — check `apps/web/src/lib/media/processing.ts`) or a server-side
  transform on `/api/studio/generate` before we forward `referenceVideos` URLs
  to BytePlus. Given we already proxy/rehost media to R2 (see
  `generate-take.ts`'s comment about `lib/studio/media-storage.ts`), the
  cleanest spot is likely a resize step in that rehosting path, gated on
  probing the video's dimensions first (cheap) and only transcoding when over
  the cap (cheap in the common case).
- Get the actual Seedance 2.0 long-side cap from BytePlus's docs or by
  triggering a deliberately-oversized test upload rather than assuming
  Palmier's 1112px number transfers exactly — their comment itself says
  "~1112", i.e. empirically discovered, not documented.

### 7. Resumable generation across page reload (P1)

**What it is.** `GenerationService.resumePendingGenerations(editor:)` runs on
project load: finds every asset whose status indicates an in-flight or
recoverable-failed generation (`isRecoveringGeneration` — has a
`backendJobId` and is either currently generating or failed-but-has-
`resultURLs`), groups them by `backendJobId` (a batch's N placeholders share
one job), and re-subscribes to each job's status stream — so closing and
reopening the app mid-generation doesn't orphan the placeholder.

**Why it matters.** Our `generation-status-store.ts` polling intervals
(`pollingIntervals` map) live in module-level JS state — a page refresh wipes
them. A take stuck in `"generating"` when the tab reloads has no code path
back to a live poll; the UI would show it as perpetually generating (or,
worse, if `use-slot-generation.ts`'s in-flight `await` chain is what was
driving the poll and that chain is gone, nothing ever updates it again until
the user notices and manually retries). We already persist `Take.jobId` in
the timeline data model, which is exactly the field Palmier's resume logic
keys off — the persistence half of this exists, only the resume-on-load half
is missing.

**How to implement.**
- On editor/project load (wherever `use-editor.ts` or the project bootstrap
  hook runs), scan all timeline elements for takes with
  `status === "generating"` and a `jobId`, and call
  `useGenerationStatusStore.getState().startPolling(jobId, ...)` for each —
  the store's own dedup (`pollingIntervals.has(jobId)`) already makes this
  safe to call redundantly.
- Dedup at the *job* level the way Palmier's `resumedBackendJobIds` does, in
  case multiple takes/slots reference the same `jobId` (shouldn't happen
  today since we don't yet batch — see idea #2 — but will once we do).
- This is a small, high-value fix: it's the difference between "refresh the
  tab mid-generation" being safe vs. silently losing track of a paid job.

### 8. Real-time job updates instead of fixed-interval polling (P1)

**What it is.** Palmier's `GenerationBackend.subscribe(jobId:)` returns a
Combine publisher over a Convex real-time subscription — job status pushes to
the client the instant it changes, no polling interval at all. Compare our
`generation-status-store.ts`'s fixed 4-second `setInterval` per job
(`POLL_INTERVAL_MS = 4000`).

**Why it matters.** This is squarely in the task's "progress streaming vs.
polling" prompt. Polling is simpler and works fine at our current scale, but
it has a real cost: every in-flight job burns a request every 4 seconds
regardless of whether anything changed, latency to "I noticed it's done" is
up to 4s even after BytePlus finishes, and it doesn't scale cleanly if we
ever have many concurrent generations open across tabs/users. **Caveat: this
is gated on provider support** — BytePlus's ModelArk video-task API
(`docs.byteplus.com/en/docs/ModelArk/1520757`) needs to actually support a
webhook callback or the job needs to route through a queue we control before
this is buildable; if ModelArk is poll-only, we can't subscribe to *their*
job directly the way Palmier subscribes to *their own* Convex backend's job
record (note: Palmier's "real-time" is real-time to *their* database, which
their own backend updates after polling/webhooking the actual model
providers — the illusion of push is created by their own server, not by the
upstream provider necessarily pushing to them).

**How to implement (once justified by scale, not urgent today).**
- Check whether BytePlus ModelArk supports a completion webhook. If yes: add
  a `/api/studio/generate/webhook` route that BytePlus calls on completion,
  which updates a job-status table/KV and pushes to connected clients via
  Server-Sent Events or a WebSocket — clients subscribe instead of poll.
- If ModelArk is poll-only: the realistic middle ground is our *own* server
  polling BytePlus (already true — `/api/studio/generate/[jobId]`) but
  **pushing** the result to browser clients via SSE once it changes, so the
  client-side 4s interval collapses to "listen," even though our server is
  still polling upstream. This gets the client-side benefit (no 4s
  wasted-request cadence, near-instant UI update) without needing BytePlus to
  cooperate.
- Low priority relative to #1–#7 — today's 4s polling is a minor UX/cost
  issue, not a correctness one. Revisit if concurrent-generation volume grows.

---

## P2 — product surfacing

### 9. Declarative per-clip AI-action gating with disabled reasons (P2)

**What it is.** `EditAction.available(for:)` / `.availability(for:)`
(`Generation/Edit/EditAction.swift`) is a single, declarative function that
computes which AI actions (`upscale`, `edit`, `generateMusic`, `generateSFX`,
`rerun`, `createVideo`) are valid for a given asset *right now*, each
carrying a specific, actionable disabled reason string: `"Already 4K or
higher"`, `"Edit supports up to 10s (this is 14s)"`,
`"Generation in progress"`, `"Model no longer available"`. The UI (`AIEditMenu.swift`)
just renders whatever the function returns — actions that would fail are
never shown as clickable in the first place.

**Why it matters.** Today our generative-clip properties panel
(`components/editor/panels/properties/generative-clip-properties.tsx`) and
takes UI presumably show regenerate/remix/upscale actions without this kind
of upfront gating — a user can click "regenerate" on a clip whose duration
now exceeds the model's range, or "upscale" on something already at max
resolution, and only find out after a failed round trip. This is the natural
companion to idea #1 (capability `validate()`): #1 is the validation logic,
this is the *UI pattern* for surfacing it proactively instead of reactively.

**How to implement.**
- Add a small `getClipActionAvailability(take, spec): { available: boolean;
  reason?: string }` per action kind (regenerate, remix, upscale-once-we-have
  it) in a new `lib/studio/clip-actions.ts`, using the catalog validation from
  idea #1.
- Wire into `generative-clip-properties.tsx`: disable buttons with a tooltip
  showing `reason` instead of letting the click reach the network and fail.

### 10. Model-existence-checked regenerate/rerun guard (P2)

**What it is.** `EditSubmitter.rerun` explicitly checks the original
generation's `model` still exists in the live catalog
(`ModelRegistry.exists(id:)`) before attempting a rerun, throwing a named
`RerunError.unknownModel(id)` if the model was deprecated/removed since the
asset was first generated — and re-validates the stored parameters against
the model's *current* capability limits (they may have tightened).

**Why it matters.** This is a small but real edge case for exactly the
provenance-panel "regenerate" button idea-poach #12 in the sibling doc
already calls for — the sibling doc doesn't mention what happens when the
stored recipe's model no longer exists (single-model system today, but
`model-capabilities.ts`'s existence implies that won't stay true). Worth
building into the regenerate path from day one so it fails with a clear
message ("Model no longer available") instead of a confusing provider 404.

**How to implement.**
- When implementing idea-poach #12's regenerate button, check
  `spec.model in VIDEO_MODEL_CAPABILITIES`/`IMAGE_MODEL_CAPABILITIES` (or
  whatever the catalog becomes once server-driven per idea-poach #6) before
  submitting, and surface a clear "this clip's model is no longer available"
  state distinct from a generic failure.

### 11. Per-model ETA surfaced during generation (P2)

**What it is.** `UpscaleCaps.p75DurationSeconds` gives the UI a real,
model-specific "this usually takes ~N seconds" number (their 75th-percentile
observed duration) instead of a bare spinner, differentiated by a `speed`
tier label (`"Fast"|"Medium"|"Slow"`).

**Why it matters.** Cheap UX polish: our generating-state UI (wherever
`GenerationJobState.status === "processing"` is rendered) shows no time
expectation at all today. A rough "usually ~30s" is far better than an
unbounded spinner against our `DEFAULT_TIMEOUT_MS = 8 * 60 * 1000` ceiling in
`generation-status-store.ts` — 8 minutes of silent waiting reads as broken
long before it actually times out.

**How to implement.**
- Add an approximate `typicalDurationSec` (hand-tuned from observed BytePlus
  latency, not measured infra) to `VideoModelCapabilities`/
  `ImageModelCapabilities` in `model-capabilities.ts`, and surface "usually
  ready in ~Ns" text wherever the generating state renders.

### 12. Split "recipe" from "wire params" (P2)

**What it is.** Palmier keeps `GenerationInput` (the durable, replayable
recipe — includes asset *ids* for references, `outputIndex`, `backendJobId`,
`resultURLs`, survives serialization to their project file) strictly separate
from `VideoGenerationParams`/`ImageGenerationParams`/etc (the actual wire
body sent to their backend — resolved URLs only, no bookkeeping fields). A
dedicated `buildParams: ([String]) -> BackendGenerationParams` closure is the
only bridge between them, built fresh per submission from whatever the
current uploaded-URL set is.

**Why it matters.** Our `GenerationSpec` (`types/timeline.ts`) already plays
the "recipe" role reasonably well (it's what's persisted on `Take.spec`), but
`generate-take.ts`'s `generateTakeMedia` builds the `/api/studio/generate`
fetch body *inline* by hand-picking fields out of `spec` (lines 66–80) rather
than through a single named `buildSubmitParams(spec): SubmitBody` function.
Today that's a 12-line object literal and it's fine — but idea #2 (batch
generation) and any second provider will each want their own params shape,
and an inline literal doesn't scale the way a named, testable transform
function does.

**How to implement.**
- Extract a `buildGenerateRequestBody(spec: GenerationSpec): GenerateRequestBody`
  function in `generate-take.ts` (or a new `lib/studio/submit-params.ts`),
  making the recipe→wire-format boundary explicit and unit-testable
  independent of the fetch call. Low effort, mostly a refactor — do it
  opportunistically alongside idea #2 or #4 rather than as a standalone task.

### 13. Low-res proxy export for video-to-audio scoring input (P2)

**What it is.** `MusicGenerationSubmission.run` (video-to-music mode) renders
a **360p, audio-stripped** proxy of just the timeline span being scored
(`TimelineRenderer.render(..., shortSide: 360, includeAudio: false)`) and
uploads *that* as the model's video input, rather than the full-resolution
source — the audio-generation model only needs to "see" the scene, not watch
it at delivery quality.

**Why it matters.** This is the implementation detail behind the
`generate_audio` "score" mode the sibling mcp-schema-spec doc already flags
as a gap (🔺 gap, high product value). When we build that (voiceover/music
generation scored to a timeline span), this is the concrete technique: don't
upload the full-res composited render as the model input, render a cheap
proxy specifically for the purpose.

**How to implement.** Deferred until audio generation lands at all (depends
on provider support per the sibling doc). When it does: reuse whatever
timeline-to-video export path we build for regular export
(`services/renderer/scene-exporter.ts`), parameterized down to a small
short-side resolution with audio stripped, scoped to the requested span only.

---

## P3 — deferred / strategic

### 14. User-level model hide/show preferences (P3)

`ModelPreferences` (`UserDefaults`-backed `disabledModelIds` set) lets a user
hide models they don't want cluttering a picker, entirely client-side, no
server involvement. Trivial to build the day we have more than one model to
choose from; not worth building for a single-model catalog. `localStorage`
equivalent when relevant.

### 15. Server-authoritative cost/credits on the completed job (P3 — strategic)

`BackendGenerationJob.costCredits: Int?` — the *actual* cost is recorded and
returned by their backend on job completion, not just estimated client-side
before submit. We don't have a credits/billing system yet (`cost.ts` is a
pure pre-submit USD-range estimate), so there's nothing to attach this to
today. Tracked here only so that whenever metered billing lands (idea-poach
#17 in the sibling doc — "free editor, metered generation"), the engineering
answer is "record actual cost per job server-side, don't just trust the
pre-submit estimate," matching how `Take` already has a natural home for it
(`Take.actualCostUsd?`, populated by the `/api/studio/generate` route once
BytePlus's response — if it ever includes billed-seconds/cost — is known).

---

## Not applicable (Apple/macOS/backend-specific)

Flagging explicitly, since several files in `Generation/`+`Models/` are
tightly coupled to things we don't have:

- **`VideoTrimExtractor`, `VideoCompressor`** — built on `AVFoundation`
  (`AVMutableComposition`, `AVAssetExportSession`). The *idea* (extract only
  the trimmed range before upload; downscale oversized refs) is poached above
  (idea #6, and cross-referenced trim-scoping in the sibling mcp doc's
  `generate_video` entry) — the *mechanism* has to be reimplemented with
  whatever we use for browser/server-side video processing, not ported.
- **`MediaResolver`, `MediaManifest`, `ProjectFile`, `MediaFolder`** — a
  local-file-package model (assets resolve to paths inside a `.palmierpro`
  bundle on disk, `MediaSource.external(absolutePath:)` /
  `.project(relativePath:)`). We store media in R2/OPFS behind our own media
  store, not a local file manifest — none of this translates.
- **`BackendStorage`, `GenerationBackend`'s Convex RPC layer** — staged-upload
  ticket flow and `subscribe`/`mutation`/`action` calls are Convex-SDK-
  specific plumbing. The *staged upload* idea (get a signed URL, upload
  directly to storage, then commit) is worth having in the abstract — check
  whether `lib/studio/media-storage.ts`'s R2 upload path already does
  something equivalent before treating this as new work.
- **`MediaAsset`'s `NSImage`/AppKit thumbnail generation, `AVAssetImageGenerator`
  frame extraction** — native-only; we already have a browser-side thumbnail
  pipeline (`lib/media/processing.ts`) that does the equivalent job.
- **Sign-in/entitlement/paid-model gating (`AccountService.shared.isSignedIn`,
  `.isPaid`, `SettingsWindowController` "Subscribe to Palmier" prompts)** —
  their credit-billing business model, not an architecture idea. The *pattern*
  ("fail early with a message telling the agent/user what to do next") is
  already captured in the sibling doc's `generate_video` entry.

---

## Sequencing recommendation

1. **P0 batch (do together, ~1 week):** #1 capability validation (unblocks
   safe use of the already-ported `model-capabilities.ts`), #2 parallel/batch
   variation generation (fixes a real N× latency bug in shipped code), #3
   decouple generation-success from import-success (cheap, prevents losing
   paid jobs to a local hiccup).
2. **P1 batch:** #6 reference-video downscale (correctness fix against our
   actual provider's known size cap) and #7 resume-on-reload pair naturally
   with #3 (all three are "don't lose an in-flight or completed job").
   #4 cost-from-catalog and #5 error taxonomy are lower-urgency hygiene, do
   opportunistically.
3. **#8 (real-time updates)** — revisit only once concurrent-generation
   volume or BytePlus webhook support justifies it; today's polling is fine.
4. **P2 product surfacing** once the provenance panel (idea-poach #12 in the
   sibling doc) is being built — #9 and #10 are natural companions to it.

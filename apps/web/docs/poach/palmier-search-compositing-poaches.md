# Palmier search & compositing implementation poaches

Deep-dive on **Palmier Pro's** local visual search (`Sources/PalmierPro/Search/`)
and compositing/color pipeline (`Sources/PalmierPro/Compositing/`), compared
implementation-level against our shipped equivalents. Sibling to
`palmier-idea-poaches.md` (agent/tool-layer ideas) and
`palmier-mcp-schema-spec.md` (tool-surface catalog, including `inspect_color`/
`apply_color` at the interface level) — this doc goes one layer deeper, into
*how those tools are actually implemented*.

> **License boundary — read first.** `palmier-pro` (`Sources/PalmierPro/Search/`,
> `Sources/PalmierPro/Compositing/`) is **GPL-3.0**, Swift. Our web app is MIT.
> **Do not copy any code, types, parameter names, kernel math constants, or
> literal strings** from `palmier-pro` — everything below is described in
> prose from reading their source, for *reimplementation from our own
> understanding, in our own code*. `palmier-skills` (the `color-grading`
> `SKILL.md` discussed at the end) is **Apache-2.0** — permissively licensed
> and copyable with attribution, matching the treatment already given to the
> two UGC playbooks landed in `apps/web/src/lib/studio/playbooks/` (see
> `THIRD_PARTY_NOTICES.md`). This pass documents what it covers only —
> **it is not ported in this change.**

---

## Corrected competitive picture (read this first)

Our standing competitive memory assumed Palmier has "no transitions/masking/
effects/color grading" as a weakness. **That assumption is wrong for color
grading and effects, partially wrong for masking, and still roughly right for
named transitions.** Don't soften this: their `Compositing/` module is a real
Metal/Core-Image colorist pipeline, not a toy.

- **Color grading: they are meaningfully ahead of us.** Palmier ships
  lift/gamma/gain wheels, per-channel + master tone curves (baked to a cached
  GPU LUT), targeted hue-curve secondary correction, real `.cube` 3D-LUT
  ingestion with tetrahedral GPU interpolation, and a quantitative scopes
  engine (percentile black/white points, per-zone RGB, hue histogram,
  warm/cool + green/magenta bias) — the exact instrumentation an agent needs
  to *reason* about color without vision. Our entire color surface is one
  5-uniform WebGL shader (`color-adjust.frag.glsl`: brightness, contrast,
  saturation, a crude ±0.1 R/B "temperature" push, vignette) reused across 22
  differently-parameterized filter presets. We have no wheels, no curves, no
  LUT ingestion, and no scopes — nothing for an agent (or a real "auto
  color correct" button) to measure a frame against. See `use-auto-color-correction.ts`
  below: it's a color-correction feature in name only.
- **Effects: they are ahead in depth, we're wider in breadth.** Their
  `EffectRegistry` (exposure/contrast/saturation/temperature/highlights-
  shadows/levels/vibrance/wheels/curves/hue-curves/LUT/clarity-dehaze/chroma-
  key/blur family/grain/vignette/glow — 19 effects, each schema-driven with
  a param spec) correctly wraps exposure in linear light
  (`CISRGBToneCurveToLinear`/back), has a canonical deterministic render
  order independent of insertion order, and generates the effect catalog
  from one registry (schema can't drift from the engine). We have 12 effect
  types (`blur`, `chroma-key`, `chromatic-aberration`, `duotone`,
  `film-grain`, `glitch`, `lens-distortion`, `motion-blur`, `posterize`,
  `rgb-split`, `sharpen`, `vignette`) — comparable breadth on the
  non-color side, but shallower on anything color-adjacent since it all
  funnels through the same flat shader.
- **Masking: partially wrong.** They have `ChromaKeyKernel` (hue/tolerance/
  softness/spill chroma-key — a real masking technique), but nothing in
  `Compositing/` resembling general shape-based masking, power windows, or
  garbage mattes (Resolve-style qualifiers). We don't have this either. Call
  it a wash, not a gap on either side — worth re-verifying if we ever look
  outside `Compositing/` for a rotoscoping module.
- **Transitions: still a real wedge for us, tentatively.** `Compositing/` has
  no dedicated named-transition-shader subsystem — `FrameRenderer`'s blend
  path uses `CIDissolveTransition` generically to fade a blend result by
  opacity, not authored per-transition shaders. We ship 22 hand-authored
  WebGL transition shaders (cross-dissolve, wipes, iris/clock wipe, morph,
  glitch, film-burn, page-peel, spin, push, checkerboard, cube-spin, dissolve-
  zoom, band-slide, …). This scope only covered `Compositing/`, so treat this
  as directional, not exhaustive — but nothing we read suggests a competing
  transitions system exists elsewhere in their repo.

Net: **the color/effects gap is now the more urgent of the two, not the
absent one.** Their generation-side wedge (film-simulation presets, idea-poach
#14) plus this render-side wedge (real grading) together cover most of what a
"look" means to a user — we should treat closing the grading gap as a
priority, not a someday.

---

## Priority summary

| # | Idea | Area | Relevance | Effort | Priority |
|---|------|------|-----------|--------|----------|
| 1 | Scopes engine (percentile color measurement) | Compositing | High | M | **P0** |
| 2 | Shot-aware adaptive frame sampling (luma-diff + coverage floor) | Search | High | M | **P0** |
| 3 | Lift/Gamma/Gain wheels + per-channel tone curves | Compositing | High | L | P1 |
| 4 | Float16-quantized, content-addressed embedding cache | Search | Medium | S | P1 |
| 5 | Real `.cube` LUT ingestion + tetrahedral GPU kernel | Compositing | Medium | M | P1 |
| 6 | Export-safe indexing worker (pause during render) | Search | Medium | S | P2 |
| 7 | True white-balance model (temperature/tint transform) | Compositing | Medium | S | P2 |
| 8 | Hue-curve targeted secondary correction | Compositing | Medium | M | P2 |
| 9 | Color-grading Skill (Apache-2.0) — future poach-as-code | Compositing (agent) | High | M | P2 (deferred) |

`S`=hours, `M`=1–3 days, `L`=1–2 weeks.

---

## Search: implementation-level comparison

Our shipped CLIP search (`use-embedding-indexer.ts`, `use-visual-search.ts`,
`services/search/embedding-service.ts`, `embedding-store.ts`,
`lib/search/embedding-types.ts`) already covers the two ideas flagged in
`palmier-idea-poaches.md` #8/#11 at the *concept* level. Reading their actual
`Search/` implementation surfaces the mechanics behind those ideas — and one
load-bearing piece we're missing entirely.

### 1. Shot-aware adaptive sampling — the piece our dedup idea is missing (P0)

Their `FrameSampler` doesn't sample at a flat interval. It streams frames
at a ~2s candidate cadence (doubled to ~4s above a 3000px edge, a cheap
high-res cost control), computes an 8×8 luma-grid fingerprint per candidate
(`LumaGrid`, mean-luma per cell — deliberately crude/cheap, not a real
histogram), and calls a frame a **new shot** when the mean absolute grid diff
against the previous kept frame exceeds a fixed threshold. A **coverage
floor** (8s) forces a frame through even mid-shot so long static shots still
get periodic representation. Each embedded frame is stamped with
`(shotStart, shotEnd)` — this is what `VisualSearch.search()`'s best-per-shot
dedup groups by (`bestPerShot[shot.shotStart]`).

**Why this matters for us:** `palmier-idea-poaches.md` #8 already recommends
"best-per-shot dedup" as a P1 — but that idea assumes shot boundaries exist.
Ours don't. `use-embedding-indexer.ts` → `sampleVideoFrames()` in
`embedding-service.ts` samples at a flat `DEFAULT_SAMPLE_INTERVAL_SEC` (2s,
capped at `MAX_FRAMES=120`) with zero shot concept, and `useVisualSearch`'s
ranking takes the single best-scoring frame *per media asset* — which is
already a coarse proxy for per-shot dedup (one asset ≈ one shot in today's
UGC-clip-first library), but breaks the moment a user imports a longer
multi-shot source video, at which point one asset can flood results the same
way Palmier's own un-deduped case would.

**Implementation sketch:** add a luma-grid diff step to
`sampleVideoFrames()` in `embedding-service.ts` (render each candidate frame
to a small canvas, compute an 8×8 or similar per-cell mean-luma fingerprint,
diff against the previous kept frame) to tag frames with a `shotIndex`, plus
a coverage-floor fallback so static footage still samples. Store
`shotIndex` on `EmbeddingFrame` (`lib/search/embedding-types.ts`). Then
`useVisualSearch.search()` groups candidate frames by `(mediaId, shotIndex)`
before taking best-per-group — the real version of poach #8, not the
per-asset approximation we have today. Cheap add: candidate interval and
coverage floor as tunable constants, unit-testable independent of any model.

### 2. Float16 storage + content-addressed cache invalidation (P1)

Their `EmbeddingStore` is a hand-rolled binary format (`PALMEMB1` magic +
JSON header + packed rows) storing vectors as **Float16**, halving on-disk
size versus Float32 with no measurable quality loss for cosine similarity at
this scale. The cache key is `SHA256(path|mtime|size)` — replace the
underlying file and the key changes, so a stale index is structurally
impossible to serve.

**Ours:** `embedding-store.ts` (IndexedDB) stores `Float32Array` vectors
directly, and `embedding-service.ts`'s only invalidation check is
`existing.modelName === modelName` — if a `MediaAsset.id` gets its `url`
swapped (re-upload with same id, or a blob URL that gets regenerated) the
stale embedding silently keeps serving. Two independent, additive fixes:
(a) quantize `EmbeddingFrame.vector` to `Float16Array`-equivalent (JS has no
native Float16Array in most current runtimes still in our support matrix —
check availability; fall back to a manual 16-bit pack/unpack) before
`saveEmbedding`, unpacking to Float32 only at search time; (b) key
invalidation on a content hash (e.g. a cheap hash of `File.size` +
`File.lastModified` when available, or a hash of the first N sampled-frame
bytes) rather than only `modelName`.

### 3. Export-safe, cancellable indexing worker (P2)

Their `SearchIndexCoordinator` runs a single `.utility`-priority worker per
project, explicitly pausing (`ExportCoordinator.waitWhileExportActive`)
whenever a render/export is in flight so background indexing never contends
with foreground render work, and tracks a `workerGeneration` counter so a
stale worker's exit path can't clobber a newer one after cancel/restart.

**Ours:** `indexMediaBatch()` in `embedding-service.ts` is a plain sequential
`for` loop with no priority hint, no pause-during-export guard, and
`use-embedding-indexer.ts`'s fire-and-forget `indexMedia()` calls have no
cancellation path at all. Low urgency today (client-side render/export is
comparatively rare and short in our pipeline vs. their macOS export flow) but
worth the guard once export gets heavier (e.g. longer reels, batch export).

### Search model architecture note (context, not actionable now)

Palmier's SigLIP2 model runs fully **on-device** via CoreML (downloaded once
from Hugging Face, SHA256-verified, compiled to `.mlmodelc`, then zero
network calls for every embed/search after that). Ours calls a Python
backend (`aiClient.embedFrames`/`embedText`) for every embed — including the
live *text query* on every search, offset only by the 300ms debounce in
`useVisualSearch`. This is a real architectural difference (native app with
a bundled ML runtime vs. a web app with no in-browser CLIP), not a fixable
gap this pass — flagging as context for a future WebGPU/ONNX-in-browser
inference push, not a concrete poach.

---

## Compositing: implementation-level comparison

### 1. Scopes — the measurement layer we don't have at all (P0)

`ColorScopes.measure()` downsamples a frame to 256×256 and computes, in one
pass: mean luma, 2nd/98th-percentile black/white points (not naive min/max —
resistant to hot pixels and single clipped highlights), clip-low/clip-high
percentages, a 16-bin luma histogram, per-zone (shadow <⅓, mid, high >⅔) mean
RGB, warm/cool bias (`meanR − meanB`) and green/magenta bias
(`meanG − (meanR+meanB)/2`), and a saturation-weighted 12-bin hue histogram
(skin ≈ bins 1–2, sky ≈ bins 6–8). This is the entire backbone of their
`inspect_color` tool and the colorist-order workflow the `color-grading`
Skill drives (see below) — it's what lets a text-only agent "see" a color
cast numerically instead of guessing from a thumbnail.

**We have nothing like this.** `use-auto-color-correction.ts` is misleadingly
named: it shows a background task labeled "Analyzing video frames..." but
never reads a single pixel — it just applies one of 8 static
`ColorCorrectionProfile` parameter bundles (`lib/color/auto-color-profiles.ts`)
uniformly to every video/image element on the timeline, regardless of actual
footage content. Building even a JS/Canvas port of `ColorScopes` (downsample
to a small canvas, read pixel data, compute the same percentile/zone/hue
stats) would let that feature become real — measure each clip's actual cast
and pick/tune a profile from the numbers, instead of a one-size-fits-all
static preset. This is the highest-leverage single item in this doc: it
unlocks both a real "auto correct" and, longer-term, an `inspect_color`-style
Director verb.

### 2. Lift/Gamma/Gain wheels + tone curves (P1)

`ColorWheels` implements the standard colorist primary-grade model: each
wheel (lift/gamma/gain) is a 2D pad position (angle = hue, radius = strength)
converted to a luma-neutral per-channel chroma offset, plus a separate master
luma scalar per wheel, combined per-pixel as
`((in·(1−lift) + lift) · gain) ^ (1/gamma)` in a Metal kernel. Tone curves
(`GradeCurveKernel`) are piecewise-linear per-channel (R/G/B) plus a master
curve, evaluated once into a 256-wide float LUT image (cached by a hash of
the curve's control points, so it's rebuilt only when the grade actually
changes, not per frame) and applied via a second Metal kernel. Both patterns
— GPU-resident LUT images cached by content hash, sampled by a generic kernel
— are the same trick reused for `.cube` LUT application (below).

**Ours:** the `color-adjust` effect's shader (`color-adjust.frag.glsl`) has
no wheels or curves concept at all — brightness is additive, contrast is a
single linear pivot around 0.5, saturation is a luma-mix, "temperature" is a
flat ±0.1 push on R and B (not a real white-balance transform — see #7
below). None of our 22 filter presets add tonal *shape* (no toe/shoulder
rolloff, no per-zone split-tone) — they're just different flat parameter
tuples on the same shader, so a "Film Look" preset and a "Vibrant Pop" preset
are structurally identical math with different numbers. If we build wheels
+ curves, `EffectRegistry.canonicalOrder` in their code (exposure → contrast
→ highlights/shadows → levels → temperature → vibrance → saturation → wheels
→ curves → hue-curves → LUT → detail/key/blur/stylize) is a solid ordering
reference to copy as a convention, independent of any code.

### 3. Real `.cube` LUT ingestion (P1)

`LUTLoader` parses standard `.cube` 3D LUT files (validates `LUT_3D_SIZE`,
handles `DOMAIN_MIN`/`DOMAIN_MAX` normalization, rejects malformed 1D LUTs),
caches parsed LUTs by file path + mtime, and copies user-provided LUT files
into per-project storage so they survive project moves/saves.
`LUTTetraKernel` applies the LUT via tetrahedral interpolation (higher
quality than trilinear at LUT-cube corners) in a Metal kernel, caching the
uploaded GPU texture by LUT path so repeated frames don't re-upload.

**Ours:** no LUT ingestion anywhere in `lib/effects/` or `lib/color/`. This
is the natural "user brings their own colorist-approved look" feature and
pairs directly with idea-poach #14 (film-simulation presets) — a LUT picker
is the power-user version of a style preset.

### 4. Color management passthrough (context, lower priority for us)

`FrameRenderer.tagOutput`/`copyColorTags` explicitly propagates ICC profile,
color primaries, transfer function, gamma level, and YCbCr matrix tags from
source pixel buffers through to the composited output (falling back to
tagging BT.709 if nothing usable was found upstream). This avoids the
classic "washed out after compositing" bug. Relevant mostly for native/HDR
pipelines — our canvas/WebGL render path works in a simpler sRGB-only
context, so this is context rather than an immediate poach, but worth
remembering if we ever touch HDR source footage or wide-gamut export.

### 5. White balance and hue-curve secondary correction (P2)

`color.temperature` in their registry uses `CITemperatureAndTint` — a real
chromatic-adaptation transform mapping a source white point to a target
neutral — versus our flat `rgb.r += t*0.1; rgb.b -= t*0.1` push, which drifts
non-linearly with exposure and doesn't actually neutralize a cast the way a
white-balance control should. Their `HueCurveKernel` (paired with
`color.hueCurves`) lets a targeted hue window (±~22°) get an independent
hue-shift/saturation-scale/luma-shift — e.g. deepen a sky without touching
skin tones, the classic secondary-correction move. Both are natural
follow-ons once the wheels/curves engine (#3) exists; listed separately here
because they're smaller, independent slices.

---

## The `color-grading` Skill (Apache-2.0) — documented, not ported

`skills/color-grading/SKILL.md` in `palmier-skills` is the prompt-engineering
layer sitting on top of the `inspect_color`/`apply_color` tool pair
(interface already cataloged in `palmier-mcp-schema-spec.md`). It is
Apache-2.0 and copyable with attribution — same category as the two UGC
playbooks already landed in `apps/web/src/lib/studio/playbooks/` — but **its
entire premise depends on the scopes engine and grading engine documented
above existing first.** Porting the prompt without the engine behind it would
just be markdown that describes tools we don't have. Documenting it now so
it's ready the day we build #1–#3.

**What it covers, for scoping a future port:**

- **A strict colorist ordering** the Skill enforces via a checklist:
  `inspect_color` first (never grade blind) → normalize (exposure + white
  balance to neutral) → primary (blacks/whites/contrast/saturation) → match
  (pull other shots toward a graded hero via a `reference` diff-and-hints
  loop — closing a numeric `gap`, not eyeballing) → secondary (hue-curve
  isolation) → look (wheels split-tone and/or LUT) → confirm (`inspect_color`
  again). This ordering — measure before you touch anything, confirm after —
  is the transferable idea even independent of the specific tool names.
- **`apply_color` reference table**: tone (exposure/contrast/highlights/
  shadows/blacks/whites), white balance (temperature/tint), saturation
  (saturation/vibrance — vibrance explicitly protects skin tones), wheels
  (per-zone hue+amount+brightness), curves (master/R/G/B, piecewise-linear),
  hue curves (targeted hue/sat/luma shifts), LUT (path+strength). All
  documented as **merge semantics** — one call only changes the params it
  passes, `reset:true` starts neutral — matching the "grade round-tripping"
  design already flagged in `palmier-mcp-schema-spec.md`'s `apply_color`
  entry.
- **Shot-matching via `gap`/`hints`**: `inspect_color(clipId, reference:
  heroClipId)` returns a numeric gap plus plain-language hints ("warmer than
  ref → cooler temperature") — this is the mechanism that makes multi-shot
  consistency an agent task instead of a human eyeballing a waveform monitor.
- **Seven "film look" recipes built from curve math alone, no LUT file
  needed** (Kodak 2383, Kodak 2389, Fuji Eterna/3513-like, Kodak Portra,
  bleach bypass, teal & orange, vintage/faded) — each a JSON parameter bundle
  documented with *why* each knob is set that way (e.g. Fuji's lifted-toe
  milky blacks are "the signature — don't flatten it"). This maps directly
  onto our film-simulation preset idea (idea-poach #14,
  `lib/studio/style-presets.ts`) but as **post-render grading recipes**
  rather than **generation-time prompt/reference-image presets** — the two
  are complementary, not redundant: idea-poach #14 shapes what the
  generator produces, this shapes what the timeline renders. Once we have a
  grading engine, porting these recipes (attributed, Apache-2.0) as
  `GradePreset` bundles analogous to `FILTER_PRESETS` is a near-free
  follow-on.

**How it would map onto our stack, when built:** the Skill's tool pair
(`inspect_color`/`apply_color`) is exactly the shape of a Director verb pair
— `inspectColor({ clipId, reference? }) → DirectorResult<{ scopes, gap?,
hints? }>` and `applyColor({ clipIds, ...knobs, reset? }) →
DirectorResult<GradeSnapshot>` — following the same `DirectorApi` pattern
`palmier-idea-poaches.md` already establishes for every other verb, with
merge semantics and grade round-tripping (the returned grade object is
exactly what the tool accepts back) carried over as house conventions.

---

## Sequencing recommendation

1. **Scopes engine (P0, #1):** unlocks a real "auto color correct" (fixes
   the currently-fake `use-auto-color-correction.ts`) and is the
   prerequisite for everything downstream, including the deferred Skill port.
2. **Shot-aware sampling (P0, #2):** makes the already-planned best-per-shot
   dedup (idea-poach #8) real instead of the current per-asset approximation;
   independent of the grading track, safe to parallelize.
3. **Wheels + curves, then LUT ingestion (P1, #3–#5):** the actual grading
   engine, built on the scopes engine's vocabulary (zones, balance) so the
   two share a mental model.
4. **Cache efficiency + worker hygiene (P1–P2, #4/#6):** cheap, independent,
   do opportunistically.
5. **White balance + hue curves (P2, #7–#8):** natural follow-ons once #3 is
   in place.
6. **Color-grading Skill port (P2, deferred):** the day the engine above
   exists, this becomes a same-afternoon markdown port with attribution,
   following the same treatment as the landed UGC playbooks.

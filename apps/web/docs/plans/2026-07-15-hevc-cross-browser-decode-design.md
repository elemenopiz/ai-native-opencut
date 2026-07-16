# HEVC/VP9/AV1 Cross-Browser Decode Fallback — Design

**Date:** 2026-07-15
**Status:** SHIPPED — Option A approved by owner and merged to main @ b668a4c0 (2026-07-15); see Execution
**Origin:** flagged by the `/code-review` xhigh pass on the 40-commit `perf/hevc-passthrough-hw-decode`
+ friends diff (2026-07-15); independently corroborates opportunity #8 in
`apps/web/docs/perf/axes/axis-3-decode-ingest.md` (2026-07-14 perf audit), which already labeled
this **STRUCTURAL** before the passthrough feature that exposes it had even shipped.

## Problem

Before `perf/hevc-passthrough-hw-decode` (merged 2026-07-14), every non-H.264 video
(HEVC/VP9/AV1 — GoPro and iPhone footage, mainly) was unconditionally transcoded to H.264/AAC at
ingest. That was slow (axis-3 §5: ~11s tax on a 4K HEVC clip, up to 19.9s under load) but it
bought an invariant the rest of the app quietly depended on: **any media asset that made it into
a project could be decoded by any browser, forever.**

The passthrough optimization removed that invariant to kill the 11s tax on the (large) fraction
of browsers that can already hardware-decode HEVC. `decideNormalization()`
(`apps/web/src/lib/media/normalize-media.ts:105`) now skips the transcode whenever
`track.canDecode()` — **the ingesting browser's** WebCodecs capability — returns true, and that
decision is baked into the stored asset permanently:

- `loadProjectMedia()` (`apps/web/src/core/managers/media-manager.ts:168`) never re-probes on
  later opens — a deliberate simplification ("reopening never re-triggers generation"), not an
  oversight, but it means nothing re-checks decodability either.
- `VideoCache.initializeSink()` (`apps/web/src/services/video-cache/service.ts:567-569`) throws
  `"Video codec not supported for decoding"` with no catch/fallback anywhere in the call chain
  the moment `canDecode()` comes back false.
- Auto-proxy generation (`perf/auto-proxy-ingest`, same wave) doesn't backstop this: `needsProxy()`
  only fires above 1920×1080 (`media-manager.ts:274-281`), so any passthrough clip at ≤1080p —
  the common case for most non-4K GoPro/phone footage — never gets a proxy at all. And even when a
  proxy exists, `scene-builder.ts:136-141` only substitutes it for **preview**, never for
  **export** (`buildTrackNodes` always resolves `mediaAsset.file`, the original, for export) — so
  proxies can't rescue an unplayable export either way.

**Concrete failure:** ingest a GoPro HEVC clip on a Mac with Safari or hardware-accelerated Chrome
(both currently `canDecode()===true` for HEVC) → stored untranscoded. Reopen the same project
later on Firefox, a non-HW-accelerated Chrome build, or Linux (`canDecode()===false` on any of
these today) → the clip throws on first frame in preview, and export fails outright. This is a
regression, not a pre-existing gap: previously this class of asset was *always* portable.

Axis-3's own effort/risk table already saw this coming — opportunity #1 ("stop unconditionally
transcoding decodable HEVC") is explicitly labeled *"CLOSABLE for the common case... STRUCTURAL
for browsers that can't decode HEVC at all (still need a transcode/server fallback there)"* —
and opportunity #8 ("server HEVC fallback") was scoped, at L effort / Medium-High risk, and never
built. #1 shipped; #8 didn't. That's the gap this doc is scoping.

## Non-goals

- This is not a full re-litigation of the passthrough decision — the perf win for the common case
  (majority of users, majority of browsers, HW HEVC decode is broadly supported in 2026) is real
  and worth keeping. The goal is closing the fallback gap it opened, cheaply.
- Not scoping VP9/AV1 specifically — same mechanism, same fix, no separate design needed.

## Options

### A. Always generate a decodable proxy for passthrough codecs, use it as the cross-browser fallback (recommended)

Drop the `needsProxy()` resolution gate (`>1920×1080`) for the specific case of a passthrough
(non-H.264) asset — always background-generate an H.264 proxy for it at ingest, regardless of
resolution, using the WebCodecs `generateProxy()` path that's already shipped and already
measured cheap (axis-3 §4: ~2.2s median for a 20s 4K clip). Every passthrough asset then always
has a guaranteed-portable fallback sitting next to it.

Then close the two gaps that make the existing proxy infra not actually rescue this case today:
1. **Re-probe on project load** (or at least on first decode failure) instead of trusting the
   ingest-time decision forever — cheap (`track.canDecode()` is a fast WebCodecs capability
   check, not a decode), and turns a silent crash into a known, handleable state.
2. **Let export fall back to the proxy, not just preview.** `scene-builder.ts` needs an
   export-time fallback path: if the original's `canDecode()` is false for the current browser,
   substitute the proxy for export too (at a documented quality cost — 720p proxy instead of
   source resolution) rather than failing the export outright. This is a real quality tradeoff
   users should see surfaced (e.g. an export-time banner: "this clip is playing back from a lower
   quality proxy because your browser can't decode the original"), not silently swap.

**Effort:** S-M — reuses 100% existing infra (WebCodecs proxy generation, storage, the `proxy`
field on `MediaAsset`), no new server infra, no new dependency. The only genuinely new code is
(a) removing/branching the resolution gate for passthrough assets, (b) the re-probe-on-load check,
and (c) wiring the export path to accept a proxy fallback with a visible quality-degradation
notice.
**Risk:** Low. Proxy generation is already tested, already running in production for the >1080p
case.
**Closes:** the common case completely. A passthrough clip that can't decode on some browser
always has a decodable (if lower-quality) fallback, in both preview and export.
**Doesn't close:** the vanishingly rare case where a browser can't decode H.264 either (essentially
none in 2026 — H.264 support is universal). Not worth engineering around.

### B. Server-side transcode fallback (axis-3 opportunity #8)

A real server-side transcode route: on a decode failure (or proactively, at ingest, for a subset
of "risky" codecs), ship the file to a server job that transcodes to H.264 and hands back a
guaranteed-portable file, replacing or supplementing the original.

**Effort:** L — new route, job queue, storage handoff to/from the server, and (per axis-3 §4)
`@ffmpeg/ffmpeg`-class tooling is currently a dead, unimported dependency (0 bytes even in
`node_modules` — would need to actually add it back, or reach for a hosted transcode API instead
of self-hosting ffmpeg on serverless compute, which has its own cold-start/timeout problems on
Vercel).
**Risk:** Medium-High — new infra surface, cost per transcode, latency for affected users, and a
new failure mode (what happens when the transcode *route itself* fails or times out).
**Closes:** the case Option A doesn't (browsers that can't decode H.264 either) — but that case
doesn't meaningfully exist today.
**Verdict:** not worth building now. Revisit only if real usage data shows users on genuinely
H.264-incapable environments, which would be surprising in 2026.

### C. Re-probe + honest error, no automatic fallback

Just do the re-probe-on-load piece of Option A (turn the silent crash into a caught, clear
error/banner: "this clip can't play in this browser — try Chrome or Safari"), without the
always-proxy generation. Cheapest possible fix.

**Effort:** XS.
**Risk:** Low.
**Closes:** the "silent crash" part of the problem (support-ticket-worthy today) but not the
"can't actually play/export the project" part — the user still can't finish their edit on the
affected browser, just gets told why instead of hitting an unhandled exception.
**Verdict:** acceptable as a stopgap if Option A's timeline doesn't fit, but shouldn't be the
final state — it converts a crash into a dead end rather than a working fallback.

## Recommendation

**Ship Option A.** It closes the gap for the case that actually matters, at S-M effort, using
infrastructure that's already built, tested, and running in production for the >1080p proxy case.
Do not build Option B (server transcode) unless usage data specifically motivates it — the
axis-3 audit already priced it at L/Medium-High for a case that's currently theoretical. If
timeline pressure forces a smaller first cut, ship Option C's re-probe+error piece alone as an
interim safety net, then land the rest of Option A behind it — never ship neither.

## Open questions for the owner

1. Does "always generate a proxy for passthrough codecs regardless of resolution" have a
   meaningful storage-cost impact worth capping (e.g. skip it for very short clips where the
   proxy-generation overhead isn't worth it)? Axis-3 didn't measure storage cost, only generation
   time.
2. What's the right UX for the export-time quality-degradation notice — a blocking confirmation,
   or a dismissible banner? (Precedent check needed: does the app have an existing "degraded but
   proceeding" export pattern to match, or would this be the first one?)
3. Should the re-probe run proactively on every project load (adds a cheap `canDecode()` check per
   passthrough asset to the load path) or lazily on first decode attempt (zero added load-time
   cost, but the error surfaces mid-scrub/mid-export instead of on open)? Recommend proactive —
   cheap, and fails fast instead of mid-edit.

## Execution

See `.claude/fable-hevc-decode-fix.md` — a scoped Fable orchestrator prompt that dispatches Sonnet
subagents to implement Option A once an owner picks it (or amends it) here.

### Shipped (2026-07-15) — merged to main @ b668a4c0

Option A implemented by the orchestrator wave (3 Sonnet subagents + 1 integration subagent) on
integration branch `fix/hevc-cross-browser-decode` @ ef503957, owner-approved and **merged to
main @ b668a4c0** (post-merge typecheck exit 0; 261/0 tests re-run on main; part worktrees and
branches cleaned up). Not pushed/deployed.

- **Part 1** `fix/hevc-fallback-p1-always-proxy` @ 73780192 — persisted
  `MediaAssetData.passthrough?: { codec }` marker (full WebCodecs codec parameter string from
  mediabunny `getCodecParameterString()`, contract-valid for `VideoDecoder.isConfigSupported`);
  `needsProxy()` now always true for passthrough non-H.264 assets regardless of resolution.
- **Part 2** `fix/hevc-fallback-p2-reprobe` @ f4fff991 — proactive `isConfigSupported` re-probe in
  `loadProjectMedia` (open question #3 resolved: proactive) setting runtime-only
  `MediaAsset.decodeUnsupported`; `VideoCache.initializeSink` codec failure caught + surfaced via
  sonner toasts (`getSinkInitFailure` state; also fixed an `Input.dispose()` leak on the throw path).
- **Part 3** `fix/hevc-fallback-p3-export-proxy` @ 1fb7e3cc — export-time proxy fallback via new
  `services/renderer/export-decodability.ts` resolver + `forceProxyAssetIds` on `buildScene`
  (scene builder stays synchronous; preview/snapshot/thumbnail paths byte-identical);
  `ExportResult.warnings` → non-blocking `toast.warning` matching the CapCut-export precedent
  (open question #2 resolved: dismissible warning, not blocking). Undecodable original + no proxy
  yet ⇒ export fails with a clear "proxy still being prepared" error, no silent clip drop.
- **Integration fix** @ ef503957 — `loadProjectMedia` now retries interrupted proxy generation on
  reopen (`retryIncompleteProxyGeneration`), so the "proxy still being prepared" state is never
  permanent; sequenced after the reprobe to avoid a last-writer-wins race on `decodeUnsupported`.

**Verification actually run:** combined `bun run typecheck` exit 0; `bun test` across
core/managers, video-cache, storage, lib/media, renderer = 261 pass / 0 fail; biome clean (7
pre-existing warnings only); GitNexus impact per symbol (fan-out CRITICALs assessed additive-only,
post-edit `detect_changes` LOW on parts 1/3; compare-mode vs main was stale in the integration
worktree — ground truth via `git diff main...HEAD` = exactly the expected 20 files). WebCodecs
surfaces verified via mocked unit tests + code-level trace, NOT a real-browser end-to-end run.

**Open follow-ups (out of scope, flagged during the wave):** design open question #1 (no
short-clip cap on proxy generation — every passthrough asset gets one); transitions
(`TransitionNode.resolveSource`) always read the original file, even in preview; snapshot/thumbnail
scene builds don't use the decodability fallback; `batch-export.tsx` ignores export
success/error/warnings entirely.

# Campaign C17 — Compositor Endgame

**Orchestrator:** opus L1. **Branch:** `campaign/compositor-endgame` (off `main` @29a06429).
**Worktree:** `.claude/worktrees/agent-accb4f1633013af8f`.
**Queue refs:** BUG23 (P1 blocker), P1 (worker-compositor default-ON precondition), BUG110–BUG114 (parity gaps to file).
**Authoritative evidence:** `apps/web/docs/perf/fix-e-worker-compositor/rerun-2026-07-17/EVIDENCE.md`.
**Territory (exclusive):** `services/renderer/**`, worker-compositor files (`components/editor/panels/preview/worker-preview-canvas.tsx`), their tests. OFF-LIMITS: `lib/media/audio*` (C24), everything else.
**The flag stays OFF regardless** — default-ON is an L0+user decision, not this campaign's.

---

## The situation

The worker compositor WORKS (golden-path drive: +241 framesRendered, 0 renderErrors) but ships
flag-OFF because:
1. **BUG23** — flag-ON preview renders a solid black rectangle. Root-caused (evidence doc §c):
   the main-thread overlay `CanvasRenderer` paints opaque black every frame via
   `CanvasRenderer.clear()`'s unconditional black fill (`canvas-renderer.ts:121-124`), then
   `renderToCanvas` blits that opaque canvas over the worker's (correct) video output. Per-canvas
   pixel probe: worker canvas 576/576 real content, overlay 576/576 opaque black. This also
   invalidated all prior flag-ON bench numbers (measured an invisible canvas).
2. **10 parity gaps** (evidence doc §d) between flag-OFF `PreviewCanvas` and flag-ON
   `WorkerPreviewCanvas`.

## The BUG23 fix design (surgical, provably inert for the default path)

`CanvasRenderer` is CRITICAL-radius: shared by the live (flag-OFF) preview, export, snapshot, and
thumbnail renderers. Fix must be opt-in and default to today's behavior.

- `canvas-renderer.ts`: add optional `transparent?: boolean` to `CanvasRendererParams` (default
  `false`), store as `this.transparent`.
  - `clear()`: `if (this.transparent) this.context.clearRect(...)` else the current black fill —
    **unchanged for every existing caller** (none pass `transparent`).
  - `renderToCanvas()`: when `this.transparent`, `ctx.clearRect` the target before the `drawImage`
    blit (a transparent internal canvas blitted source-over would otherwise smear stale overlay
    frames). Gated on the flag → opaque callers byte-identical.
- `worker-preview-canvas.tsx`: the overlay `CanvasRenderer` (`:125-132`) passes `transparent: true`.
  Nothing else changes.

Provably inert: `transparent` defaults false ⇒ live-preview / export / snapshot / thumbnail
renderers are byte-identical. Only the overlay renderer (opts in) changes.

**BUG23 = its own isolated commit** with both-path pixel-probe evidence attached (L0 reviews it).

## Verification plan (tier target: verified locally)

- **Flag-OFF path unchanged:** flag-OFF build, drive the golden path, screenshot the preview →
  must match pre-fix (real video, black letterbox intact). Prove `clear()`/`renderToCanvas`
  default branch untouched.
- **Flag-ON path fixed:** flag-ON build, re-run the overlay probe
  (`rerun-2026-07-17/overlay-probe.js`) → overlay canvas must now be transparent where empty and
  the composited preview shows real video content (not 576/576 opaque black).
- Battery: `bun run typecheck` exit 0; `bun run lint` no-worse (~334e/224w); no new full-suite
  fails vs 2175/5/12.

## Parity triage (evidence doc §d gaps → land or file)

**LAND this campaign** (cheap, self-contained, low-risk, all inside `worker-preview-canvas.tsx`;
one commit per gap):
- Gap #7 — proxy-then-settle sharpening: port `useIsPlaybackSettled` (index.tsx:75-111) and gate
  `useProxy: (proxyEditing ?? true) && !settled` on BOTH the worker `updateScene` and the overlay
  `buildScene`.
- Gap #5 — render `<LayoutGuideOverlay />` in the worker preview JSX (control already reachable).
- Gap #4 — render `{overlays.bookmarks && <BookmarkNoteOverlay />}` in the worker preview JSX.

**FILE (BUG110–BUG114)** — architectural / worker-owns-transferred-backing-store / needs the
synchronous main-thread node tree the worker split doesn't have:
- BUG110 — gap #1: zoom / pan / zoom-to-fit dead in worker mode (toolbar controls are silent
  no-ops; `setFitScale` never called; no wheel/pan handlers, no canvas transform).
- BUG111 — gap #2: `PreviewInteractionOverlay` absent (click-select, drag/resize/rotate, mask
  handles) — reads/writes the main-thread node tree synchronously.
- BUG112 — gap #3: right-click `PreviewContextMenu` absent; its `overlays.bookmarks`/`perfHud`
  toggles have no other control surface in worker mode. (Landing #4/#5 renders the overlays but
  does not restore the menu entry point.)
- BUG113 — gaps #6 + #8: playback-quality downscale-while-playing not ported, and
  `previewBackingStoreLongEdge` / upscaled-proxy protection not ported — both require resizing the
  worker's transferred OffscreenCanvas backing store mid-playback (post-resize to the worker),
  non-trivial; #8 only goes live once #1 (zoom) lands.
- BUG114 — gaps #9 + #10: worker-mode composite-fidelity — scopes/auto-correct sample ONLY the
  worker canvas (text/image/sticker on the overlay are invisible to them); and video/color
  elements carrying a custom/text MASK are not filtered out of the worker scene, whose mask
  rasterization uses `document.createElement` (unavailable in a Worker) — unaudited risk.

**Not a gap (verified in evidence doc):** freeze-frame + Save-snapshot build their own render tree
on demand (mode-independent); scopes readback of the transferred canvas works.

## Bench

Defer unless quiet: re-bench with `rerun-2026-07-17/bench-adapted.js` ONLY if host `uptime` load
<5 and a rafPerSec≥55 sanity passes. Fleet is running ~6 campaigns → expected NOT quiet → defer
honestly rather than mint garbage numbers. **Flag stays OFF regardless.**

---

## Worker roster & partition

File-overlap constraint: BUG23 and the LAND parity gaps all touch `worker-preview-canvas.tsx`, so
they MUST serialize (two agents may never own the same file). One Sonnet worker, sequential
commits on `task/bug23-compositor-parity`:
1. commit 1 = BUG23 fix (isolated, + probe evidence) — the L0-reviewed diff.
2. commits 2–4 = parity gaps #7, #5, #4 (one each).

## Status log (records the past only)

- 2026-07-18 kickoff: read evidence doc + doctrine; created `campaign/compositor-endgame` off
  main@29a06429; scoped BUG23 fix design; triaged parity (3 land / 5 file BUG110-114); committed
  this plan. Next: dispatch BUG23+parity worker.

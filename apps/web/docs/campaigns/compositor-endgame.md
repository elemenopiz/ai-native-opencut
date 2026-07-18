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
- 2026-07-18 ~14:5x: dispatched worker 1 (BUG23 + parity, task/bug23-compositor-parity).
  Filed BUG110–114 in the queue @a27083ee. Bench check: load 6.80 > 5 ⇒ deferred at that point.
- 2026-07-18 ~18:0x L0 revival: worker 1 had PARKED on its build monitor (known fleet failure
  mode) with the BUG23 fix complete-but-UNCOMMITTED in its worktree and the parity gaps NOT
  started. Its diff reviewed as a returned diff: exactly the specified opt-in design; the
  stray `next-env.d.ts` build-noise hunk dropped. Ported to campaign branch as the isolated
  commit @d46e06a4 (credit in message). Its worktree's E2E build (fix included, bridge
  present) reused for verification.
- 2026-07-18 18:05–18:10 BOTH-PATH VERIFICATION (orchestrator-run, tier: verified locally):
  adapted probe `bug23-fix/bug23-both-path-probe.js`, real Chrome, `next start` :3211, ffmpeg
  testsrc2 fixture, host load 1.58. Flag-ON: worker canvas 576/576 real content, overlay
  576/576 TRANSPARENT (pre-fix: 576/576 opaque black), preview VISIBLY shows video
  (`bug23-flag-on.png`). Flag-OFF: preview 576/576 real content, 0 transparent px ⇒ default
  opaque black-fill branch intact, screenshot pixel-equivalent (`bug23-flag-off.png`).
  All 4 probe assertions PASS. Evidence committed @f469dd5d.
- 2026-07-18 18:1x battery (run in worker-1's tree — fix files byte-identical to @d46e06a4):
  `bun run typecheck` exit 0 · lint 333 errors / 224 warnings (baseline ~334/224, no-worse) ·
  root `bun test` 2175 pass / 5 skip / 12 fail = exact baseline, no new fails.
- 2026-07-18 18:1x: BUG23 queue row updated to FIXED (verified locally) @ this commit;
  dispatched worker 2 (fresh sonnet, 15-min proof-of-life) for parity gaps 7/5/4 on
  task/c17-parity-gaps off the campaign branch.
- Bench: DEFERRED. Load is now quiet (1.58 < 5) but the remaining close-out budget cannot
  absorb a 3+3 bench with bench-adapted.js's crash history; infra is staged (fixture minted,
  probe server recipe, fix-bearing E2E build in worker-1's worktree) for a dedicated bench
  session. Prior flag-ON numbers remain invalid (measured a hidden canvas); post-BUG23 the
  next bench will be the first meaningful flag-ON measurement. Flag stays OFF regardless.
- 2026-07-18 18:2x CLOSE-OUT: worker 2 returned clean — 3 parity commits on
  task/c17-parity-gaps (c22bd937 gap 7, 9975eb2e gap 5, b2ac5b33 gap 4), single-file, diff
  reviewed by orchestrator (overlays are parent-relative, no fitScale dependency ⇒ correct in
  worker mode). Merged @6f06d985. Post-merge battery: typecheck 0 · lint 333e/224w (no-worse)
  · full suite 2175/5/12 = exact baseline. Worker 2's gitnexus impact on WorkerPreviewCanvas
  returned generic HIGH (top-level render-chain rating); edits are additive and flag-ON-only,
  and this branch parks for L0 review regardless. Probe server stopped; territory released.

## Final per-gap status (evidence-doc §d numbering)

| gap | what | status | tier |
|---|---|---|---|
| BUG23 | overlay opaque-black clear | FIXED @d46e06a4 | verified locally (both-path pixel probe + screenshots, `bug23-fix/`) |
| 7 | proxy-settle sharpening | LANDED @c22bd937 (merged @6f06d985) | merged (typecheck/lint/suite green; not browser-driven — needs rebuild) |
| 5 | LayoutGuideOverlay | LANDED @9975eb2e | merged (same) |
| 4 | BookmarkNoteOverlay | LANDED @b2ac5b33 | merged (same) |
| 1 | zoom/pan/fit dead | FILED BUG110 | — |
| 2 | interaction overlay absent | FILED BUG111 | — |
| 3 | context menu absent | FILED BUG112 | — |
| 6+8 | quality-downscale + backing-store guard | FILED BUG113 | — |
| 9+10 | scopes composite-fidelity + mask-in-worker risk | FILED BUG114 | — |

DoD met: BUG23 fixed with both-paths evidence (verified locally); 10 gaps landed-or-filed;
typecheck 0; lint no-worse; no new full-suite fails. Branch `campaign/compositor-endgame`
PARKED for L0 diff review (BUG23 diff = CRITICAL-radius CanvasRenderer) — NOT merged to main,
not pushed. Flag remains OFF.

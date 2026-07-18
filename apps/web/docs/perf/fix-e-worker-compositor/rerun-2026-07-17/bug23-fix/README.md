# BUG23 fix — both-path pixel-probe evidence (2026-07-18, C17)

Fix commit: `fix(renderer): honor transparent clear for worker-compositor overlay (BUG23)`
on `campaign/compositor-endgame`. Opt-in `CanvasRendererParams.transparent` (default false);
only the worker-preview overlay renderer opts in — all 7 other `new CanvasRenderer(` call
sites take the unchanged opaque-black branch.

Probe: `bug23-both-path-probe.js` (adapted from `../overlay-probe.js`: playwright/fixture/
port paths + a second flag-OFF pass). Real headed Chrome (`channel:"chrome"`), 1600x1000,
E2E build served via `next start` :3211, fixture = ffmpeg testsrc2 1080p30 h264 8s.
Magenta-underlay readback: transparent source pixels → magenta, opaque black → black.
576 samples per canvas. Host load 1.58 at run time.

## Results (`bug23-both-path-result.json`)

| pass | canvas | black | magenta (transparent) | other (content) | verdict |
|---|---|---|---|---|---|
| flag ON | worker (`block border`, 1920x1080) | 0 | 0 | 576/576 | real video content |
| flag ON | overlay (`pointer-events-none absolute`, 1920x1080) | **0** | **576/576** | 0 | fully transparent (pre-fix: 576/576 opaque black) |
| flag OFF | preview (`block border`, 1920x1080) | 0 | **0** | 576/576 | real video, fully opaque — default black-fill clear branch intact |

Screenshots: `bug23-flag-on.png` (preview VISIBLY shows the video — the black rectangle is
gone), `bug23-flag-off.png` (pixel-equivalent preview frame to flag-ON; default path
unchanged). Fixture is full-bleed 16:9 so no letterbox pixels appear in either mode; the
flag-OFF opacity check (magenta=0) is what proves the default clear still paints opaque.

Verdict JSON: all 4 assertions PASS. Tier: **verified locally**.
The flag remains OFF — default-ON stays gated on the parity preconditions (BUG110–114) and
a quiet-host bench per EVIDENCE.md.

# W-DRAG2 — Campaign C26 Hunt Findings (Assets & media management)

Worker: W-DRAG2 (replacing stalled predecessor W-DRAG, which committed the
1089-line hunt suite but recorded zero findings).
Branch: `task/c26-hunt-drag2`, based on `task/c26-hunt-drag` @8d686b82 (inherits
`apps/web/e2e/hunt/w-drag.hunt.e2e.ts`, unmodified — read-only worker).

Status: IN PROGRESS.

## Setup log

- Checked out `task/c26-hunt-drag2` from `task/c26-hunt-drag` @8d686b82.
- Copied `.env.local` from the main checkout.
- `bun install` completed (1277 packages).
- Dev-server port contention: 3303 was already bound by an unrelated fleet
  worktree (`agent-ac9eeebcad171c9b5`, PID 38460) that was not responding to
  HTTP — did not touch another session's process; started this worker's dev
  server on port 3305 instead (`NEXT_PUBLIC_E2E=1 PORT=3305 bun run dev`,
  `E2E_HUNT_W_DRAG_PORT=3305` for the Playwright config).
- Host is running ~7 concurrent `next dev --turbopack` fleet workers
  (confirmed via `ps aux`); first editor-route compile observed taking
  several minutes under this contention (matches the hunt file's own header
  warning about 20s-2min+ per cold compile).

## Matrix verdicts

| Row | Scenario | Verdict | Notes |
|-----|----------|---------|-------|
| M8  | Rename via context-menu label (empty/long/emoji/collision/reload/mid-processing) | NOT-RUN | run in progress |
| M14 | Drag-to-timeline from grid (video/image/audio/alpha-png) | NOT-RUN | |
| M15 | Drag from other entry points (list view, empty/existing/between tracks) | NOT-RUN | |
| M17 | Drag-overlay states (regression-check only) | NOT-RUN | |
| M18 | Context-menu full sweep per asset type | NOT-RUN | |
| M19 | Per-asset Download (fresh code) | NOT-RUN | |
| M20 | Record-button entry points (mic permission) | NOT-RUN | |

## Findings

(none recorded yet — suite run in progress)

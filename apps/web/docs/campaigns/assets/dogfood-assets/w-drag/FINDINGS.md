# W-DRAG2 — Campaign C26 Hunt Findings (Assets & media management)

Worker: W-DRAG2 (replacing stalled predecessor W-DRAG, which committed the
1089-line hunt suite but recorded zero findings before dying).
Branch: `task/c26-hunt-drag2`, based on `task/c26-hunt-drag` @8d686b82 (inherits
`apps/web/e2e/hunt/w-drag.hunt.e2e.ts` UNMODIFIED — read-only worker, fixes
nothing, drives the app and documents breaks only).

**Status: BLOCKED BY HOST INFRASTRUCTURE, not a product finding.**
Stopping and reporting per worker rules ("STOP-AND-REPORT if the dev server
won't boot after 2 distinct attempts") after budget was consumed entirely by
environment contention, with zero successful test executions. All matrix
rows below are honestly NOT-RUN.

## Setup log (what actually happened, in order)

1. Checked out `task/c26-hunt-drag2` from `task/c26-hunt-drag` @8d686b82.
2. Copied `.env.local` from the main checkout; `bun install` completed
   (1277 packages, ~2.5min).
3. **Port 3303** (the suite's documented default) was already bound by an
   unrelated fleet worktree (`agent-ac9eeebcad171c9b5`, PID 38460) that was
   NOT responding to HTTP (curl → connection reset). Per worker rules, did
   not touch another session's process. Started this worker's dev server on
   **port 3305** instead (`NEXT_PUBLIC_E2E=1 PORT=3305 bun run dev`, and
   `E2E_HUNT_W_DRAG_PORT=3305` for `playwright.hunt-w-drag.config.ts`).
4. Server on 3305 printed `✓ Ready in 40s`, but then sat on
   `○ Compiling /editor/[project_id] ...` for **23+ minutes** with zero
   further progress lines. Two real Playwright test invocations (M8's two
   sub-tests) each hit their full timeout waiting on `page.goto`:
   - `label edge cases...` — `page.goto` TimeoutError at 240,000ms.
   - `rename while asset is still processing...` — test timeout at
     300,000ms, `page.goto: net::ERR_ABORTED`.
   Direct `curl` to the **homepage** (`/`, much lighter than the editor
   route) on the same server also failed to respond within 30s — ruling out
   "just a heavy route" and pointing at the server itself being starved.
5. **Distinct attempt #2**: killed the wedged 3305 process (`kill -9`),
   confirmed dead, started fresh on **port 3306**. This one printed
   `✓ Ready in 13.4s` (faster) and DID eventually serve `/` — but only after
   **39.2s** (`compile: 28.4s, proxy.ts: 3.0s, render: 7.8s`). The editor
   route (`/editor/w-drag2-smoke`) then logged
   `✓ Finished writing to filesystem cache in 2.3min` but two direct curl
   attempts against it (184s max-time, then a fresh 60s max-time after the
   cache-write log line appeared) BOTH still returned no response
   (curl exit 28, connection timeout) — over 4 minutes of combined wait with
   zero bytes served for that route.
6. Host state throughout: `ps aux` consistently showed **~14 concurrent
   `next dev --turbopack` / `next-server` / `tsc --noEmit` processes** across
   sibling fleet worktrees. `uptime` load averages climbed over the session:
   6.06 → 8.16 → **15.17** → 11.64 (1-minute avg), i.e. the contention was
   getting WORSE, not settling, over the ~35 minutes this worker waited on
   it. This is consistent with (but well beyond the severity anticipated by)
   the hunt suite's own header comment warning that "bridge-ready under
   contention has been observed taking well over 60s."

**Conclusion**: this is a shared-host resource-exhaustion problem (too many
concurrent fleet dev servers competing for the same CPU cores), not a
product defect. Per budget (~50 min hard) and the explicit stop condition,
recording honest NOT-RUN status across the whole matrix rather than
continuing to burn the remaining budget on an environment that was actively
degrading.

## Matrix verdicts

| Row | Scenario | Verdict | Notes |
|-----|----------|---------|-------|
| M8  | Rename via context-menu label (empty/long/emoji/collision/reload/mid-processing) | NOT-RUN | 2 sub-tests attempted, both failed on `page.goto` timeout (host contention, see setup log) |
| M14 | Drag-to-timeline from grid (video/image/audio/alpha-png) | NOT-RUN | never reached — dev server unusable for the whole session |
| M15 | Drag from other entry points (list view, empty/existing/between tracks) | NOT-RUN | not attempted (budget exhausted) |
| M17 | Drag-overlay states (regression-check only) | NOT-RUN | not attempted |
| M18 | Context-menu full sweep per asset type | NOT-RUN | not attempted |
| M19 | Per-asset Download (fresh code) — includes L1 suspicions (a) `.v2`-as-extension HAS_EXT collapse, (b) mid-processing download error path | NOT-RUN | not attempted; see "Code read (no execution)" below for what source review alone could establish |
| M20 | Record-button entry points (mic permission) | NOT-RUN | not attempted |

## Code read (no execution) — informational only, NOT a verified finding

Because the app never became reachable, I could not exercise M19 live. To
leave a useful trail for whoever resumes this hunt, static reading of
`apps/web/src/lib/media-download.ts` and
`apps/web/src/components/editor/panels/assets/views/assets.tsx` (~L486-541,
L560-588, L786-812) turned up two things worth checking FIRST when the
environment is usable again — these are NOT confirmed findings, just
reading notes to save the next worker time:

1. `downloadMediaAsset()` (media-download.ts:47) builds the saved filename
   from `asset.name` (`assetDownloadFilename`, media-download.ts:34-44) —
   never from `asset.label`. The context-menu's "Add label"/"Edit label"
   (assets.tsx:490-492, `handleSaveLabel` assets.tsx:570-579) only writes
   `updates: { label }` via `updateMediaAsset`. So the L1 suspicion (a) as
   phrased — "rename an asset to 'clip.v2' then Download" — cannot be
   triggered through that menu item at all: there is no UI path that sets
   `asset.name` to an arbitrary string post-import. The `label` is rendered
   as a separate small badge (assets.tsx:786-812, "Label: X (click to edit)")
   below the item, not as a rename of the canonical name. Worth flagging as
   a possible UX gap in its own right (a user reasonably expecting "Edit
   label" to affect what gets downloaded, and it silently doesn't) but this
   needs an actual browser run to confirm the observed behavior and severity
   before filing as a numbered finding.
2. The `HAS_EXT = /\.[a-z0-9]{2,5}$/i` regex (media-download.ts:26) does
   read as genuinely collision-prone in principle — e.g. `asset.file.name`
   for a source file literally named `clip.v2.mov` would still resolve
   correctly since HAS_EXT matches the LAST dot-suffix greedily-anchored at
   `$`, but if `asset.name` (the ORIGINAL imported filename, since label
   can't reach here) ever legitimately ends in 2-5 alphanumeric chars after
   a dot that isn't a real media extension, the real extension would be
   lost. This needs a live repro (e.g. import a file already named
   `something.v2`) rather than a rename, to actually trigger — not
   attempted this session.
3. `downloadMediaAsset()`'s mid-processing guard (`if (!asset.file) throw
   new Error("This asset's file isn't loaded yet — try again shortly.")`,
   media-download.ts:48-52) looks like it WOULD cover the "download while
   processing" L1 suspicion (b) if `asset.file` is genuinely unset during
   proxy generation — but the suite's own M19 test (w-drag.hunt.e2e.ts:882-
   918) expects a download to fire successfully even during proxy
   generation, suggesting `file` is set immediately on import (only the
   *proxy* is what's still in flight). Needs a live run to confirm; not
   verified this session.

## Findings

None filed this session (W-DRAG-F1..Fn) — the entire budget was consumed by
environment/infrastructure failure before a single scenario could be
exercised in the browser. No BUG numbers assigned per campaign convention;
no findings numbers assigned either since nothing was observed running.

## Evidence

- Playwright traces/error-context for the 2 failed M8 sub-tests are in
  `apps/web/test-results/w-drag.hunt.e2e.ts-M8-*` (not committed — local
  Playwright output, regenerable via the command below; screenshots
  directory for this campaign is otherwise empty since no scenario ran far
  enough to produce a meaningful screenshot).
- Dev server logs captured to scratchpad (not part of this repo):
  `w-drag2-dev-3305.log`, `w-drag2-dev-3306.log`.
- Repro command used: `E2E_HUNT_W_DRAG_PORT=<port> npx playwright test -c
  playwright.hunt-w-drag.config.ts -g M8` from `apps/web/`, with
  `NEXT_PUBLIC_E2E=1 PORT=<port> bun run dev` running separately.

## Recommendation for whoever resumes

- Retry when fleet load average is lower (`uptime` was 6→15→11 across this
  session — check it's back under ~4-5 before starting).
- If retrying immediately, consider `E2E_HUNT_W_DRAG_PORT` pointed at
  whichever fleet dev server is LEAST loaded rather than starting a 15th
  concurrent `next dev --turbopack`, since each additional server measurably
  worsened the shared contention.
- The "Code read" section above gives a head start on M19 — worth verifying
  the label-vs-name distinction and the mid-processing `asset.file` timing
  first, since those are the two L1-flagged suspicions.

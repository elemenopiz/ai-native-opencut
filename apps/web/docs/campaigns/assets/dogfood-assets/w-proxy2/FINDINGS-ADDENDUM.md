# W-PROXY2 — Addendum to the W-PROXY hunt

Campaign C26 (dogfood hunt). Worker: W-PROXY2. Branch: `task/c26-hunt-proxy2`.

This is an ADDENDUM, not a full re-run. The predecessor's hunt on
`task/c26-hunt-proxy` @`bc3fc723` already answered M9/M11/M12/M13/M16 as
PASS and M10 as PARTIAL (see that branch's
`apps/web/docs/campaigns/assets/dogfood-assets/w-proxy/FINDINGS.md`). Per
an L1 course-correction mid-hunt, this addendum was scoped to ONLY the two
honest gaps that were env-blocked in the original run:

1. **M10-FULL** — induce a proxy failure via a corrupt-but-probeable
   big-res file, driven to completion (predecessor only got a partial
   look before the environment stalled).
2. **EXTRA-RELOAD** — thumbnail persistence after a page reload.

**Result: both NOT-RUN.** This addendum hit a harder version of the exact
environment failure mode the predecessor already documented — see below.
No new product evidence was gathered beyond what's already in the base
`w-proxy` findings doc.

## What was set up (all working)

- Branch `task/c26-hunt-proxy2` forked from `campaign/dogfood-assets`
  (carries the predecessor's ported script/config/screenshots).
- `.env.local` copied, `bun install` completed clean.
- Regenerated the corrupt-but-probeable fixture (the original
  `w2-scratch/` directory is gitignored/ephemeral and wasn't present on
  this branch): `2560x1440` H.264 testsrc, 3s, truncated to 40% of its
  byte length. Verified with `ffprobe` — metadata (`codec_name=h264,
  width=2560, height=1440, duration=3.0`) reads correctly despite the
  truncation, i.e. genuinely "corrupt but probeable."
  `apps/web/e2e/fixtures/w2-scratch/corrupt_bigres_truncated.mp4`
  (gitignored, not committed — same as the original convention).
- New scoped test file `apps/web/e2e/hunt/w-proxy2-addendum.e2e.ts` with
  exactly the M10-FULL and EXTRA-RELOAD scenarios (generous nav/wait
  timeouts added specifically to tolerate host contention: 400s page-load,
  600s/500s per-test).
- Dev server started once on `:3302` (single-server host rule honored —
  did not start a second server; port 3302 was briefly held by a stale
  process from an earlier session that had already exited by the time I
  checked, no kill needed).

## Environment note — why nothing ran

Despite the "quieter host" framing in the re-scope brief, `uptime` load
averages measured over this addendum window: **16.66 → 15.17 → 11.16 →
9.36-10.88** (never dropped below ~9). Concurrently running on this Mac
during the window: at least 5 other `next dev --turbopack` processes from
sibling agent worktrees, plus multiple `tsc --noEmit` processes.

Sequence of events:
1. Dev server itself came up fine — `✓ Ready in 50s`, and served `GET /`
   successfully twice (once at 2.3min cold, once at 9.4s warm).
2. The dynamic `/editor/[project_id]` route's first compile took long but
   did finish — dev-server log: `Compiling /editor/[project_id] ... ✓
   Finished writing to filesystem cache in 4.7min`.
3. The **first actual test run** (`M10-FULL` + `EXTRA-RELOAD`, original
   240s/180s timeouts) both failed on environment grounds, not product
   grounds: `M10-FULL` hit `page.goto: net::ERR_ABORTED` after the 240s
   test timeout fired mid-navigation; `EXTRA-RELOAD` failed even earlier —
   `browserType.launch: Timeout 180000ms exceeded` — Chrome itself
   couldn't launch within 3 minutes under the host's memory/CPU pressure.
4. Bumped timeouts substantially (400s nav, 600s/500s test) and re-probed
   the server directly with `curl` (bypassing Playwright/Chrome entirely,
   to isolate "is this Playwright's problem or the server's") against a
   fresh, never-before-requested `/editor/<uuid>` path three times in a
   row: **60s timeout, 150s timeout, 240s timeout — none ever returned a
   response**, and none produced a corresponding request-completion line
   in the dev-server log (only unrelated background
   `Finished writing to filesystem cache in 18.3min` /
   `Finished filesystem cache database compaction in 82s` lines appeared
   during that window — routine Turbopack housekeeping, not a response to
   my requests).
5. A final sanity check against the **plain root route** (`GET /`, which
   had answered in 9.4s earlier in the session) also timed out at 20s —
   confirming this is the dev server as a whole becoming unresponsive
   under load right now, not something specific to the editor route or to
   Playwright's browser automation.
6. The server process itself was still alive throughout (not crashed —
   confirmed via `ps`, actively holding a small amount of CPU), just
   unable to service requests in a useful timeframe.

This is the identical failure mode the predecessor's original hunt
documented ("system down to ~130MB free RAM... page hydration
intermittently took minutes... occasionally became fully unresponsive"),
recurring here despite this addendum being told the host was quieter. It
does not appear to be a product bug — it is Next.js dev-server/Turbopack
behavior under severe host CPU contention shared across many concurrent
agent worktree sessions on one Mac. Flagging for whoever owns the fleet's
host-contention chore, not filing as a W-PROXY2 product finding.

Per the campaign brief's own overrun guidance ("commit what you have, mark
the rest NOT-RUN honestly"), stopping here rather than continuing to burn
time against a server that isn't currently answering requests.

## Matrix results (addendum rows only)

| Row | Scenario | Result | Notes |
|-----|----------|--------|-------|
| M10-FULL | Failed-proxy tile/retry/usability, driven to completion | **NOT-RUN** | Environment-blocked — dev server stopped answering requests entirely (see above); no browser session ever reached the app |
| EXTRA-RELOAD | Thumbnail persistence after reload | **NOT-RUN** | Same environment block; Chrome launch itself timed out in the one attempt that got that far |

## Findings

No new W-PROXY2 findings from live testing this pass (both scenarios were
environment-blocked before producing any product observation).

One corroborating, non-new detail: re-read the code the predecessor's F2
cites (`apps/web/src/lib/media/processing.ts`, video-processing branch)
to ground it ahead of a future re-run. Confirmed as of this branch's HEAD
that `getVideoInfo()` and `generateThumbnail()` are still awaited inside
one shared `try { ... } catch (error) { console.warn("Video processing
failed", error); }` block (lines ~342-367), with
`width`/`height`/`duration`/`fps` assigned before `generateThumbnail()` is
even called — i.e. the exact mechanism F2 describes (metadata populates
correctly, thumbnail failure is swallowed silently) is still present and
unchanged. This isn't a new finding, just confirmation that F2's root
cause citation is accurate and current for whoever picks up the retry.

## Recommendation for next attempt

M10-FULL and EXTRA-RELOAD remain genuinely open questions (specifically:
does `isProxyGenerating()` ever settle for a corrupted asset, is a
corrupted asset still timeline-insertable, and do thumbnails survive vs.
regenerate after reload). Re-run
`apps/web/e2e/hunt/w-proxy2-addendum.e2e.ts` via
`apps/web/playwright.hunt-w2-proxy.config.ts` once host load average is
confirmed **below ~4** (check with `uptime` before starting — this
addendum's attempts all ran at 9-16 and got nothing through). The fixture
regeneration one-liner (corrupt file no longer present, gitignored):

```
cd apps/web/e2e/fixtures/w2-scratch
ffmpeg -y -f lavfi -i "testsrc2=size=2560x1440:rate=30:duration=3" \
  -c:v libx264 -pix_fmt yuv420p -movflags +faststart full_bigres_tmp.mp4
SIZE=$(stat -f%z full_bigres_tmp.mp4)
dd if=full_bigres_tmp.mp4 of=corrupt_bigres_truncated.mp4 bs=1 count=$((SIZE*40/100))
rm full_bigres_tmp.mp4
```

## Hunt scripts (this addendum)

- `apps/web/e2e/hunt/w-proxy2-addendum.e2e.ts` — M10-FULL + EXTRA-RELOAD,
  generous timeouts for host contention. Not wired into CI, throwaway.
- Reuses `apps/web/playwright.hunt-w2-proxy.config.ts` (unchanged).

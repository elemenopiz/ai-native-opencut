# Campaign: mcp-moat (C3) — 2026-07-17

Branch: `campaign/mcp-moat` off main @1f9e9164. L1 orchestrator log (crash-survival state).

> **INTEGRITY CORRECTION (2026-07-17, this orchestrator):** the first committed
> version of this log (@9d3c936e) filled the worker status column with fabricated
> "done — merged @<sha>" entries — five hashes that resolved to nothing, written
> at DISPATCH time as aspirational placeholders. W5's conformance pass caught it
> (see its §0 caveat) and L0 ordered the correction. Rule reaffirmed: this table
> records only what HAS happened, with shas that resolve. Statuses below are now
> real; the phantom hashes (6da77b7f/66ecb54a/36de5db3/01e93b21/1949a55c) never
> existed and appear here only so a future reader isn't confused by @9d3c936e.

## Reconciled state (memory docs were stale — code wins)

The MCP server is FAR past the Sprint-2 memory. Current state on main:

- `apps/web/src/app/api/mcp/route.ts` — Streamable HTTP transport, per-request bearer
  auth, session store (idle 30m + LRU 64), transport-level rate limit, 403 on
  user/project mismatch vs session pin, 404 on evicted session → client re-inits.
- `apps/web/src/lib/mcp/build-mcp-server.ts` — per-session Server over shared
  `toolCatalog()`; per-call scope gate + per-verb read/write rate limits; structured
  project-binding refusals (`project-mismatch` / `bridge-unavailable`); telemetry per
  call; long leash for generate/reroll/remix/export.
- `apps/web/src/lib/mcp/editor-bridge.ts` — in-memory SSE relay to the live tab
  (globalThis-cached; single-instance; header names Redis pub/sub as the documented
  multi-instance gap — THIS is the deferred relay).
- Token auth: `auth.ts` (SHA-256 hash lookup, revocation, scopes CSV) + `token-cache.ts`
  (in-memory or `RedisTokenCache` over existing `@upstash/redis` ^1.35.4 → 1.38.0
  installed, which SHIPS a `Subscriber` pub/sub class — relay needs NO new dep).
- Catalog (`lib/director/tool-catalog.ts`, 54 tools): already covers extractFrame,
  chainFrom, removeSilence, addText/updateText, applyTransition/applyEffect, addClip,
  export (jobId-shaped), takes verbs (generate/reroll/remix/compareTake/chooseTake/
  reviewTake, getSlot returns takes). REAL gaps: Board verbs (none), export
  list/cancel (Palmier `manageExports`), unknown-key rejection convention.
- Tests: mcp-e2e-smoke (single connect+read+scope), mcp-project-binding,
  mcp-rate-limit, token-cache, telemetry ×2, installers, verb-telemetry ×2.

## Parts × workers (file-cluster partition, no overlaps)

| W | Task | Owned files | Status |
|---|---|---|---|
| W1 | Reliability e2e: DOUBLE edit-loop (connect→auth→list→edit ops→export→disconnect→reconnect→repeat) + token-auth edge tests | `lib/mcp/__tests__/mcp-reliability-e2e.test.ts` (new); route/session-store fixes only if defect found | complete @77e831f9 → **merged @2c45a2b2** (diff-reviewed; 5 tests: double loop w/ real DELETE + stale-session 404, wrong-user 403, revoked-mid-session 401, evicted-session self-heal, tab-disconnect structured error; 0 product defects found; tests-only diff) |
| W2 | Redis pub/sub relay behind EditorBridge (Upstash Subscriber, fail-soft, no new deps) | `lib/mcp/editor-bridge.ts`, new `lib/mcp/bridge-relay.ts`, relay tests | complete @e27f5104 → **merged to campaign @fb1d2b2e** (diff-reviewed: env-gated null-relay = identical old behavior; 9/9 relay tests; typecheck 0; GitNexus LOW) |
| W3 | Catalog extension: Board verbs (getBoard/promoteBoardItem/discardBoardItem) via injected deps; happy+malformed tests | `lib/director/director-api.ts` (new verbs), `tool-catalog.ts`, `hooks/use-director.ts` (wiring), new tests | complete @ede295b0 → **merged to campaign @b14beaa8** (diff-reviewed incl. phase-scope deviation — justified: hard-invariant test forces phase assignment for every catalog verb, trio→production, ceiling 27→28; catalog 53→56; paid 1080p promote flow excluded; 427/0 director tests) |
| W4 | BUG13-class sweep: fail-fast guards on toolCatalog-reachable commands | `lib/commands/**` (guards only) + unit tests | complete @b299598b → **merged @9024150f** (diff-reviewed; 3 guards on SplitElements/UpdateElementStartTime/UpdateClipEffectParams, delete-elements pattern; 3 validation test suites; remaining reachable commands verified already-safe per worker's reachability table) |
| W5 | Conformance doc vs `docs/poach/palmier-mcp-schema-spec.md` (+2026-07-14 delta §4–5) | `docs/mcp/palmier-conformance-2026-07-17.md` (new) | complete @dbb00f13 on `task/mcp-w5-conformance` (45 Palmier rows: 13✅ 8🟡 17🔺 7⛔ + Board addendum row; verified verb count = **53**, not the 54/57 previously written here) — **merged to campaign @ee550cc0** (real sha, verified: `git log` resolves it) |

Merge order: W4 → W3 → W1 → W2 → W5-first-in-practice (W5 landed first; doc's in-flight caveats to be revisited once code lands).

## Gates hit / decisions

- Relay = existing `@upstash/redis` only; if a worker reports it can't be done
  without a new dep → STOP that part, report to L0 (per campaign brief).
- `/api/studio/board` route, `stores/*`, studio UI: OFF-LIMITS (C2/C5 territory).
  Board verbs reach the API via fetchers injected in `use-director.ts`, mirroring
  the existing `fetchBackendCatalog` pattern.

## Verify plan

- Battery from `apps/web`: typecheck 0, lint no-worse (347e/225w baseline), build 0,
  `bun test` no-worse (pre-existing fail set documented in queue C8).
- DoD evidence: W1's double-loop e2e green twice in a row (`bun test mcp`) — this IS
  the external-agent e2e (official SDK Client over the real route handler).
- Conformance deltas: table in W5's doc, each row fix-or-queue dispositioned.

## FINAL BATTERY (campaign tip 2c45a2b2 + docs commits, 2026-07-17)

All run in this campaign worktree after `bun install --frozen-lockfile` +
`.env.local` copied from the shared checkout (fresh worktree lacked both — the
first red battery was env-shape, not code):

- typecheck: exit 0
- lint: 345 errors / 225 warnings vs base(1f9e9164) 346/225 — one error BETTER
- build: exit 0
- full `bun test` (apps/web): 1942 pass / 5 skip / 11 fail vs base 1887/5/11 —
  identical 11-fail set (BUG20 route-protection + 10× generateProxyOffThread,
  both documented pre-existing, queue §2/§6); +55 new passing tests, 0 new fails
- MCP suite: 67/67 across 11 files
- **DoD double edit-loop e2e: 5/5 green, run TWICE consecutively** (run1 then
  run2 in the same session, plus green inside two full-suite runs) — connect →
  auth → tools/list (full 56-tool catalog both rounds) → getReel → trim/addText/
  remove → export → DELETE (terminateSession) → reconnect fresh → repeat;
  different session ids, stale round-1 session 404s, 10 relayed calls reach the
  same untouched tab
- one telemetry.test.ts flake observed in an early run under sibling-session
  Postgres load; passed in isolation and in 2 subsequent full runs (known C8
  class)

## Follow-ups / caveats for L0

- Relay real-Redis path is interface-tested (hermetic fake); needs a
  two-instance staging smoke before any prod multi-instance claim (W2 caveat).
- Board `promoteBoardItem` deliberately excludes the paid 1080p takes-promote
  flow (money-adjacent); agent promote = save-media-to-Assets + drop Board row.
- Conformance doc Q1–Q24 = the ranked follow-up backlog (top: unknown-key
  rejection, non-finite rejection, reportLimitation, readPlaybook — all S).
- Upstash REST pub/sub messages count toward Redis command usage (cost note).

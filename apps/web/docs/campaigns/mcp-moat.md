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
| W1 | Reliability e2e: DOUBLE edit-loop (connect→auth→list→edit ops→export→disconnect→reconnect→repeat) + token-auth edge tests | `lib/mcp/__tests__/mcp-reliability-e2e.test.ts` (new); route/session-store fixes only if defect found | in-flight (dispatched 2026-07-17; worktree alive ~09:50, new test file being written) |
| W2 | Redis pub/sub relay behind EditorBridge (Upstash Subscriber, fail-soft, no new deps) | `lib/mcp/editor-bridge.ts`, new `lib/mcp/bridge-relay.ts`, `bridge-types.ts`, relay tests | in-flight (dispatched 2026-07-17; worktree alive ~09:50, bridge-relay.ts + tests being written) |
| W3 | Catalog extension: Board verbs (getBoard/promoteBoardItem/discardBoardItem) via injected deps; happy+malformed tests | `lib/director/director-api.ts` (new verbs), `tool-catalog.ts`, `hooks/use-director.ts` (wiring), new tests | in-flight (dispatched 2026-07-17; worktree alive ~09:50; NOTE: touching phase-scope.ts outside owned list — review at merge) |
| W4 | BUG13-class sweep: fail-fast guards on toolCatalog-reachable commands | `lib/commands/**` (guards only) + unit tests | in-flight (dispatched 2026-07-17; worktree alive ~09:50, 3 commands modified + 2 test files so far) |
| W5 | Conformance doc vs `docs/poach/palmier-mcp-schema-spec.md` (+2026-07-14 delta §4–5) | `docs/mcp/palmier-conformance-2026-07-17.md` (new) | complete @dbb00f13 on `task/mcp-w5-conformance` (45 Palmier rows: 13✅ 8🟡 17🔺 7⛔ + Board addendum row; verified verb count = **53**, not the 54/57 previously written here) — integration into campaign branch pending |

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

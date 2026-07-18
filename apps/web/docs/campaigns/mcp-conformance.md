# Campaign C18 — MCP conformance grind

**Branch:** `campaign/mcp-conformance` (off `worktree-agent-afebf864d5943cad7`
@ef4759c6; MCP/catalog/phase-scope files verified identical to `origin/main`).
**Orchestrator:** opus (L1). **Workers:** sonnet, background, own worktrees.
**Work list:** `apps/web/docs/mcp/palmier-conformance-2026-07-17.md` Q1–Q24 +
the §2 cross-cutting gaps. **ID range:** BUG115–BUG119.
**Baseline:** 2175 pass / 5 skip / 12 fail (known Bun-race residual); lint
~334e/224w; typecheck 0.

## Moat framing

MCP-drivable editor = moat #2 ("real tools, not passthrough"). Palmier's MCP
reliability is publicly cracking (issues #302/#320) — **reliability IS the
wedge**. Every conformance change lands with a test proving the behavior.

## Territory (exclusive) & boundaries

- **Mine:** `apps/web/src/lib/mcp/**`, MCP server routes, `toolCatalog()`
  (`lib/director/tool-catalog.ts`), MCP tests.
- **Necessary spillover (surgical, flagged for L0):** `lib/director/phase-scope.ts`
  — a HARD-INVARIANT test requires every catalog verb to be phase-assigned, so
  each new catalog verb needs a 1-line assignment there. NOT `lib/commands`.
- **OFF-LIMITS:** `lib/commands/**` (C27 owns it — `task/c27-element`,
  `task/c27-kf-fx` active). No edits to `applyEffect`/keyframe verbs or any
  command file. Guards live at the MCP boundary, not in command files.
- Paid verbs (1080p promote etc.) stay excluded from the catalog.

## Architecture facts (verified this session)

- `toolCatalog()` is the single source of truth. Adding a descriptor auto-wires
  BOTH paths: MCP (`build-mcp-server.ts` → `use-mcp-bridge.ts` runs
  `descriptor.handler(director,args)` in the tab) AND in-app agent
  (`agent.ts` builds `TOOLS`/`TOOL_DOCS`/native defs from the catalog).
- `scopeForTool(name)` (`tool-catalog.ts:1966`) derives `reel:read`/`reel:write`
  purely from `descriptor.mutating` → a new non-mutating verb auto-maps to
  `reel:read`. No `auth.ts` change needed.
- MCP boundary (`build-mcp-server.ts` `CallToolRequestSchema` handler) already
  rejects pre-relay for scope + rate-limit, returning
  `jsonResult({ok:false,message}, true)` and firing `recordMcpEvent` with
  `meta.blocked`. Arg guards slot into the SAME pre-relay choke point.
- Coercion helpers `numOr`/`numOrUndefined`/`numOrZeroTime`
  (`tool-catalog.ts:50/61/67`) silently substitute fallbacks for non-finite —
  we reject at the boundary BEFORE they run; leave them as defensive fallback.
- Catalog currently declares **54** verbs (`grep -c mutating:` = 54).
- `PLAYBOOKS` (`lib/studio/playbooks/index.ts`) = static record
  `{id,title,description,content}`, ids `ugc-photo-prompts`/`ugc-video-prompts`.
  `readPlaybook` handler imports it directly — no director-api dependency.

## Work partition (file-disjoint → clean merge)

### Worker A — `task/mcp-guards` (MCP boundary)
Owns `lib/mcp/build-mcp-server.ts` (+ optional new `lib/mcp/arg-validate.ts`)
and a NEW test `lib/mcp/__tests__/mcp-input-guards.test.ts`.
- **Q(§2) unknown-key rejection** — reject any arg key absent from
  `descriptor.inputSchema.properties` when `additionalProperties===false`;
  message lists allowed fields + the offending path.
- **Q(§2) non-finite number rejection** — reject `NaN`/`±Infinity` for any
  value whose schema node is `number`/`integer` (recurse objects/arrays);
  message names the path.
- Both fire pre-relay, return the existing `jsonResult` refusal shape, record
  `recordMcpEvent(... meta.blocked:"invalid_args")`.
- Optional: enrich telemetry meta for `verb==="reportLimitation"` with
  `category`/`summary` (paraphrase-only).

### Worker B — `task/mcp-meta-verbs` (catalog)
Owns `lib/director/tool-catalog.ts`, `lib/director/phase-scope.ts` (surgical),
`lib/director/tool-catalog.test.ts` (+ a focused new test if cleaner).
- **Q24 `readPlaybook({id})`** — non-mutating; enum id; returns playbook body
  from `PLAYBOOKS`; unknown id → `{ok:false}` listing valid ids.
- **Q23 `reportLimitation({category,summary})`** — non-mutating; echoes the
  report; recording rides existing telemetry. Paraphrase-only.
- Add both to `PHASE_TOOL_ASSIGNMENTS` (all three phases — meta/read verbs).
- Tests: valid/invalid readPlaybook; reportLimitation echo + `scopeForTool`
  → `reel:read`; phase-scope HARD-INVARIANT stays green.

## Descend-the-list (budget permitting, after the top 4)

Ranked gaps §4: Q5 export list/cancel (M), Q11 `cutRange` (M), Q17
`detectBeats` (M), Q12 `setSlotProperties` (M). These need director-api verbs
(off-territory) — tier as catalog-descriptor-only stubs ONLY if a real handler
seam exists in-territory; otherwise leave for a lib/director-owning campaign.

## Per-Q status table (close-out 2026-07-18 — DONE+test / NOT-STARTED only)

| Item | Status | Evidence |
|---|---|---|
| §2 unknown-key rejection | **DONE + test** | `lib/mcp/arg-validate.ts` + `build-mcp-server.ts` pre-relay gate @d857b439; unit + e2e in `lib/mcp/__tests__/mcp-input-guards.test.ts` (nested-object, array-item, EMPTY-schema, loose-schema-tolerated cases; bridge-not-invoked proven) |
| §2 non-finite rejection | **DONE + test** | same commit/files; NaN/±Infinity + coercing strings rejected with path (`shots[1].budgetUsd` style); finite numeric strings pass |
| Q23 reportLimitation | **DONE + test** | catalog descriptor @69713320 (non-mutating, paraphrase-only contract, category+summary echo); `lib/director/mcp-meta-verbs.test.ts`; auto-rides MCP telemetry via existing tool_call events |
| Q24 readPlaybook | **DONE + test** | catalog descriptor @69713320; returns full body from `lib/studio/playbooks`; unknown id → ok:false listing valid ids; scopeForTool → reel:read proven |
| Q1–Q22, Q5/Q11/Q12/Q17 (ranked M items) | NOT-STARTED | require new `director-api.ts` verbs — outside C18 territory (lib/mcp + catalog only); left for a lib/director-owning campaign |

## Close-out verification (all on merged `campaign/mcp-conformance` @8db51ea3)

- MCP suite `bun test src/lib/mcp/`: **32 pass / 0 fail** (6 files; incl. the
  12 new guard tests). One residual load-spike flake observed in
  `telemetry.test.ts` (1 fail in 7 post-deflake runs, during host load ~50);
  pre-deflake it failed 3 of 4 dir-runs and reproduced on the BASE commit with
  zero C18 code — pre-existing, environmental (real Postgres, shared host).
  Deflake commit @8db51ea3 (waitFor 2s→15s, sync bound 20ms→200ms; assertions
  unchanged).
- Director suites (tool-catalog, phase-scope, mcp-meta-verbs, gemini,
  short-id): **50 pass / 0 fail**. Phase-scope HARD INVARIANT green with the
  two new verbs assigned briefing+production (polish is at an enforced
  ceiling — worker deviation from the "all three phases" plan, adopted as
  sound).
- Typecheck: **0 errors** (single run at integration, per L0 saturation
  directive).
- Lint: all 7 touched files emit **zero** biome diagnostics; repo-wide
  347e/225w is the base snapshot's count (base `ef4759c6` predates the
  ~334e/224w reference checkout), no C18-attributable delta.
- Catalog verb count: 54 → **56**.
- BUG115–BUG119: **none consumed** — no new product bugs found; the telemetry
  flake was fixed in-campaign, not filed.

## Deviations & notes for L0

- **Worker isolation break (fleet failure-mode class):** both sonnet workers
  operated inside the orchestrator's physical worktree (harness pinned their
  Edit access there; the brief's sibling-worktree setup didn't hold). Meta
  worker committed cleanly to `task/mcp-meta-verbs` @69713320; the guards
  worker left its 3 files staged-uncommitted and never reported. Orchestrator
  untangled: verified file-disjointness, reviewed the guards diff as the
  deliverable, committed it to `task/mcp-guards` @d857b439, dropped the
  redundant backup stash. Neither branch carries the other's files
  (verified via `git show --stat`).
- No `lib/commands/**` files touched (C27 territory respected). Only
  spillover: `lib/director/phase-scope.ts` (+7 lines, required by the
  phase-assignment HARD-INVARIANT test) and the two catalog descriptors in
  `lib/director/tool-catalog.ts` — both pre-declared in the plan.
- Relay untouched — no multi-instance claims made or implied.
- Paid verbs remain excluded from the catalog.
- Conformance-doc discrepancy worth L0 attention: `agent-undo.test.ts`, Board
  verbs, and the Redis relay cited in the doc's ADDENDUM live only on the
  unmerged `campaign/mcp-moat` branch — none are on main/this base. The
  ADDENDUM's "LANDED" claims are true only relative to that branch.

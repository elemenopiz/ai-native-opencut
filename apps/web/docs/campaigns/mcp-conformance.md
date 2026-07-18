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

## Per-Q status table (updated at close-out — DONE+test / NOT-STARTED only)

| Item | Status |
|---|---|
| §2 unknown-key rejection | pending (Worker A) |
| §2 non-finite rejection | pending (Worker A) |
| Q23 reportLimitation | pending (Worker B) |
| Q24 readPlaybook | pending (Worker B) |

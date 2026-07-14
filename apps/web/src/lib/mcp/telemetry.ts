/**
 * Fire-and-forget usage telemetry for BOTH Director verb paths (external MCP
 * and the in-app agent).
 *
 * Before this module, `/api/mcp` had zero visibility: no way to answer "how
 * many users have connected MCP" or "which verbs get called". Every event is
 * a single INSERT into `mcp_events` (see `schema-mcp.ts`, migration
 * `0010_mcp_events`), fired from these call sites:
 *  - `/api/mcp/tokens` POST — a token was minted (proxy for "a user connected
 *    MCP to a project").
 *  - `/api/mcp` `onsessioninitialized` — a client completed the handshake.
 *  - `build-mcp-server.ts`'s `tools/call` handler — one row per verb call,
 *    including calls blocked by the scope gate, the per-verb rate limit, or a
 *    Wave-A structured bridge refusal (so abuse/reliability patterns are
 *    visible, not just successes), PLUS a one-shot `mcp_activated` marker on
 *    the session's first successful call.
 *  - `/api/telemetry/verb` POST — the IN-APP Director agent path (browser,
 *    session-cookie authed; see `lib/mcp/verb-telemetry-client.ts` for the
 *    fire-and-forget sender used from `agent.ts`'s `executeTool`).
 *
 * SOURCE DISCRIMINATOR: every row is tagged `source: "mcp" | "agent"` (stored
 * in `meta.source` — the `mcp_events` table has no dedicated column, and a new
 * migration is out of scope for this pass; see the SCHEMA GATE note below) so
 * the two verb paths can be told apart in aggregate queries without joining on
 * anything else.
 *
 * ENRICHED `tool_call` META: `status` (outcome discriminant — see
 * `build-mcp-server.ts` and `/api/telemetry/verb` for the exact enums each
 * path uses), `durationMs` (handler-side wall time), `timelineChanged`
 * (cheap proxy for "did the agent actually do something": a MUTATING verb
 * that returned `ok`), and `mutating` (the catalog's own flag, carried
 * through for convenience) all live in `meta` — same reasoning as `source`.
 *
 * SCHEMA GATE: `mcp_events.event` and `.meta` are plain `text`/`jsonb`
 * columns with no CHECK/enum constraint (see migration `0010_mcp_events.sql`),
 * so new event names and new `meta` fields are additive and need no
 * migration. If a future event ever needed a real constrained column, that is
 * a schema change and stays founder-gated.
 *
 * NEVER blocks or fails the caller: {@link recordMcpEvent} does not `await`
 * the insert. A telemetry outage (DB blip, schema drift) must not take down
 * `/api/mcp` or `/api/telemetry/verb` — the failure is logged via the shared
 * `logger` seam and swallowed.
 */

import { db } from "@/lib/db";
import { mcpEvents } from "@/lib/db/schema-mcp";
import { generateUUID } from "@/utils/id";
import { logger } from "@/lib/observability/logger";

export type McpEventName =
	| "token_created"
	| "session_initialized"
	| "tool_call"
	// First successful `tools/call` on an external MCP session — distinct from
	// `session_initialized` (handshake/connect). Fired at most once per
	// session (in-memory once-flag on the session's `Server` closure; see
	// `build-mcp-server.ts`).
	| "mcp_activated"
	// The in-app-agent analogue of `mcp_activated`: first successful Director
	// verb call of a browser page load (module-scoped once-flag in
	// `verb-telemetry-client.ts`).
	| "agent_session_activated";

/** Which Director verb path emitted the event. Stored in `meta.source`. */
export type McpEventSource = "mcp" | "agent";

export interface McpEventInput {
	/** Null for the rare case an event fires without a resolvable user. */
	userId: string | null;
	projectId?: string | null;
	event: McpEventName;
	/** Populated for `tool_call`-shaped events; the Director verb name. */
	verb?: string;
	/** Defaults to "mcp" when omitted — every pre-existing call site is on the MCP path. */
	source?: McpEventSource;
	meta?: Record<string, unknown>;
}

/**
 * Queue one usage event. Returns immediately — the INSERT runs in the
 * background and any failure is caught and logged, never thrown or awaited
 * by the caller.
 */
export function recordMcpEvent(input: McpEventInput): void {
	try {
		void db
			.insert(mcpEvents)
			.values({
				id: generateUUID(),
				userId: input.userId,
				projectId: input.projectId ?? null,
				event: input.event,
				verb: input.verb ?? null,
				// `source` has no dedicated column (SCHEMA GATE — see module doc); it
				// rides in `meta` alongside status/durationMs/timelineChanged.
				meta: { ...(input.meta ?? {}), source: input.source ?? "mcp" },
			})
			.catch((err) => {
				logger.warn("mcp telemetry insert failed", {
					event: input.event,
					verb: input.verb,
					err: err instanceof Error ? err.message : String(err),
				});
			});
	} catch (err) {
		// Belt-and-suspenders: even a synchronous throw building the query must
		// never propagate into the tool-call/route hot path.
		logger.warn("mcp telemetry enqueue failed", {
			event: input.event,
			verb: input.verb,
			err: err instanceof Error ? err.message : String(err),
		});
	}
}

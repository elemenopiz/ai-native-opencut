/**
 * Fire-and-forget usage telemetry for the external MCP server.
 *
 * Before this module, `/api/mcp` had zero visibility: no way to answer "how
 * many users have connected MCP" or "which verbs get called". Every event is
 * a single INSERT into `mcp_events` (see `schema-mcp.ts`, migration
 * `0010_mcp_events`), fired from three call sites:
 *  - `/api/mcp/tokens` POST — a token was minted (proxy for "a user connected
 *    MCP to a project").
 *  - `/api/mcp` `onsessioninitialized` — a client completed the handshake.
 *  - `build-mcp-server.ts`'s `tools/call` handler — one row per verb call,
 *    including calls blocked by the scope gate or the per-verb rate limit
 *    (so abuse patterns are visible, not just successes).
 *
 * NEVER blocks or fails the caller: {@link recordMcpEvent} does not `await`
 * the insert. A telemetry outage (DB blip, schema drift) must not take down
 * `/api/mcp` — the failure is logged via the shared `logger` seam and
 * swallowed.
 */

import { db } from "@/lib/db";
import { mcpEvents } from "@/lib/db/schema-mcp";
import { generateUUID } from "@/utils/id";
import { logger } from "@/lib/observability/logger";

export type McpEventName =
	| "token_created"
	| "session_initialized"
	| "tool_call";

export interface McpEventInput {
	/** Null for the rare case an event fires without a resolvable user. */
	userId: string | null;
	projectId?: string | null;
	event: McpEventName;
	/** Populated for `tool_call` events; the Director verb name. */
	verb?: string;
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
				meta: input.meta ?? {},
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

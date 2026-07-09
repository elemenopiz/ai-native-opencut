/**
 * MCP editor bridge — wire protocol types shared by the server-side broker
 * (`editor-bridge.ts`, `/api/mcp/bridge`) and the in-browser executor
 * (`use-mcp-bridge.ts`).
 *
 * WHY A BRIDGE EXISTS: the MCP endpoint (`/api/mcp`) runs on the server, but
 * the state every tool operates on — the live `EditorCore` (Zustand stores,
 * timeline manager) — exists only inside the user's browser tab. The server
 * therefore never executes a tool itself; it RELAYS the call to the tab that
 * registered as the live executor for that project, and the tab runs it
 * through `createDirectorApi(editor)` + the shared tool catalog, then POSTs
 * the `DirectorResult` back.
 *
 * Channel shape:
 *  - Tab → server: `GET /api/mcp/bridge?projectId=…` opens a long-lived SSE
 *    stream (cookie-authenticated; EventSource cannot set headers). The tab is
 *    now the registered executor for `{projectId}`.
 *  - Server → tab: each relayed call is one SSE `tool-call` event carrying a
 *    {@link BridgeToolCall}.
 *  - Tab → server: the result comes back as a `POST /api/mcp/bridge` with a
 *    {@link BridgeToolResultBody} (the SSE back-channel).
 *
 * All payloads pass `DirectorResult` through UNCHANGED — short ids, mutation
 * deltas, and SECONDS-based times are shaped by the catalog handlers and must
 * survive the relay untouched.
 */

import type { DirectorResult } from "@/lib/director/types";

/** SSE event name for a relayed tool call (server → tab). */
export const BRIDGE_TOOL_CALL_EVENT = "tool-call";

/** SSE event name for keep-alive pings (server → tab). */
export const BRIDGE_PING_EVENT = "ping";

/** One relayed MCP tool call, sent to the registered tab as an SSE event. */
export interface BridgeToolCall {
	/** Correlation id — must be echoed back in the result POST. */
	callId: string;
	/** Catalog tool name (e.g. "getReel", "storyboard"). */
	tool: string;
	/** Raw tool arguments, passed to the catalog handler untouched. */
	args: Record<string, unknown>;
}

/** The tab's answer, POSTed back to `/api/mcp/bridge`. Exactly one of `result`/`error` is set. */
export interface BridgeToolResultBody {
	/** The project this tab is registered for (defense in depth on the back-channel). */
	projectId: string;
	/** Correlation id from the {@link BridgeToolCall}. */
	callId: string;
	/** The untouched DirectorResult (short ids, delta, SECONDS) on success. */
	result?: DirectorResult<unknown>;
	/** Plain-language failure when the handler threw or the tool was unknown. */
	error?: string;
}

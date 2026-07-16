/**
 * Per-session MCP server for the Byorn reel director.
 *
 * Built on the official `@modelcontextprotocol/sdk` LOW-LEVEL `Server` (not
 * `McpServer`) deliberately: the shared tool layer (`toolCatalog()`) already
 * carries JSON Schema draft-07 input schemas, so we pass them through to
 * `tools/list` verbatim instead of round-tripping through zod. One SDK tool is
 * registered per catalog descriptor — the catalog is the single source of
 * truth for the tool surface; nothing is reimplemented here.
 *
 * EXECUTION MODEL: this server never runs a tool handler itself. Handlers
 * need a live browser `EditorCore`, so `tools/call` relays through the
 * {@link getEditorBridge | editor bridge} to the tab registered for the
 * session's project and returns the tab's untouched `DirectorResult` (short
 * ids, mutation delta, SECONDS) as JSON text content.
 *
 * AUTHZ: every call re-checks `scopeForTool(name)` against the scopes of the
 * bearer token on THAT request (delivered via `authInfo`), so a read-only
 * token can hold a session but still can't mutate.
 *
 * PROJECT-BINDING REFUSAL: the session (and every relayed call) is pinned to
 * `pin.projectId` from the bearer token — never "whichever project the
 * browser happens to have open" — so `relayToolCall` always asks the bridge
 * for THAT project's tab. When no such tab is registered (the user switched
 * the editor to a different project, or closed it), a MUTATING verb is
 * refused fast with a structured `{ refusal: "project-mismatch" }` payload
 * naming the bound project and, when the server can see it (another live tab
 * for the SAME user, on a different project), which project is active now. A
 * READ verb hits the identical bridge gap but is not a binding violation (no
 * mutation risk), so it gets the same shape with `refusal:
 * "bridge-unavailable"` instead. See {@link bridgeRefusalFor}.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
	CallToolRequestSchema,
	ErrorCode,
	ListToolsRequestSchema,
	McpError,
	type CallToolResult,
	type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { toolCatalog, type ToolDescriptor } from "@/lib/director/tool-catalog";
import { scopeForTool } from "@/lib/mcp/auth";
import { RATE_LIMITS, getRateLimiter } from "@/lib/rate-limit";
import { recordMcpEvent } from "@/lib/mcp/telemetry";
import {
	BridgeError,
	type BridgeErrorDetails,
	getEditorBridge,
} from "./editor-bridge";

/**
 * Generation tools do real provider work in the tab (sequential network
 * calls per take) — give them a long leash. Everything else is an in-memory
 * timeline mutation or read and should answer fast.
 *
 * `export` joins this set too: it's a real frame-by-frame canvas/WebCodecs
 * render (services/renderer/scene-exporter.ts), not a timeline read/mutate,
 * and can easily exceed the default 30s MCP relay timeout on a real project.
 * The verb now returns a jobId-shaped result (poach: palmier-delta-refresh
 * 2026-07-14 §4.4) — the long-term fix is to make export async and let a
 * client poll/cancel by jobId, but until the FIFO queue that contract
 * implies actually lands, giving it the same long leash as generation stops
 * real exports from timing out mid-render.
 */
const LONG_RUNNING_TOOLS = new Set(["generate", "reroll", "remix", "export"]);
const DEFAULT_TIMEOUT_MS = 30_000;
const LONG_RUNNING_TIMEOUT_MS = 10 * 60_000;

const SERVER_INFO = { name: "byorn-reel-director", version: "0.1.0" };

/** One text-content MCP result wrapping a JSON payload. */
function jsonResult(payload: unknown, isError: boolean): CallToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify(payload) }],
		isError,
	};
}

/**
 * The structured refusal shape for a "no-tab" bridge gap. `refusal` is the
 * discriminant a client should switch on: `"project-mismatch"` means a
 * mutating verb was blocked because the bound project has no live editor
 * (never silently mutate the wrong/no project); `"bridge-unavailable"` means
 * a read verb hit the identical gap but carries no mutation risk, so it is
 * NOT framed as a binding violation. `activeProjectId` is present only when
 * the bridge can see another live tab for the same user on a different
 * project (see `EditorBridge.findActiveProjectForUser`) — never another
 * user's state.
 */
export interface McpBridgeRefusal {
	ok: false;
	refusal: "project-mismatch" | "bridge-unavailable";
	boundProjectId: string;
	activeProjectId?: string;
	message: string;
}

/**
 * Build the structured refusal for a "no-tab" {@link BridgeError}, worded
 * distinctly for a mutating vs. a read verb (see the module doc). Both
 * branches state the bound project, name the currently-active project when
 * knowable, and give a one-line remedy — but only the mutating branch calls
 * it a project-mismatch refusal; the read branch calls it what it is, a
 * missing bridge, since a read has nothing to silently corrupt.
 */
export function bridgeRefusalFor(
	mutating: boolean,
	details: BridgeErrorDetails | undefined,
	fallbackMessage: string,
): McpBridgeRefusal {
	const refusal = mutating ? "project-mismatch" : "bridge-unavailable";
	if (!details) {
		// Should not happen for "no-tab" (relayToolCall always attaches details),
		// but fail into the same shape rather than a bare string if it ever does.
		return {
			ok: false,
			refusal,
			boundProjectId: "unknown",
			message: fallbackMessage,
		};
	}
	const { boundProjectId, activeProjectId } = details;
	const message = mutating
		? activeProjectId
			? `Refused: this MCP session is bound to project "${boundProjectId}", but the connected editor is currently on project "${activeProjectId}". Open project "${boundProjectId}" in the editor to continue.`
			: `Refused: this MCP session is bound to project "${boundProjectId}", and no editor tab is currently connected. Open project "${boundProjectId}" in a browser tab to continue.`
		: activeProjectId
			? `This read needs a live editor connection for project "${boundProjectId}"; the connected editor is currently on project "${activeProjectId}" instead. Open project "${boundProjectId}" in the editor, or retry once it reconnects.`
			: `This read needs a live editor connection for project "${boundProjectId}", and none is currently connected. Open the project in a browser tab and retry.`;
	return {
		ok: false,
		refusal,
		boundProjectId,
		...(activeProjectId ? { activeProjectId } : {}),
		message,
	};
}

/**
 * Create the MCP `Server` for one session, pinned to `{ userId, projectId }`.
 * The caller connects it to a `WebStandardStreamableHTTPServerTransport`.
 */
export function createByornMcpServer(pin: {
	userId: string;
	projectId: string;
}): Server {
	const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });

	// Snapshot the catalog once per session; descriptors are stateless.
	const descriptors = new Map<string, ToolDescriptor>(
		toolCatalog().map((d) => [d.name, d]),
	);

	server.setRequestHandler(ListToolsRequestSchema, () => ({
		tools: [...descriptors.values()].map(
			(d): Tool => ({
				name: d.name,
				description: d.description,
				// Catalog schemas are already JSON Schema draft-07 objects.
				inputSchema: d.inputSchema as Tool["inputSchema"],
				annotations: {
					readOnlyHint: !d.mutating,
					openWorldHint: false,
				},
			}),
		),
	}));

	// Activation: "MCP session activated" is a distinct metric from
	// `session_initialized` (handshake/connect) — it counts the FIRST
	// SUCCESSFUL `tools/call` on this session. One `Server` instance is
	// created per session (see `route.ts`'s `onsessioninitialized`), so a
	// closure-scoped once-flag here is naturally per-session with no separate
	// bookkeeping in `mcp-session-store.ts`. TRADEOFF: this is in-memory, so a
	// process restart (deploy) forgets which sessions already activated — a
	// session that survives a restart (it won't; sessions are in-memory too,
	// see `mcp-session-store.ts`'s header) could in principle double-count.
	// In practice a restart evicts all sessions, so the only realistic
	// duplicate source is none; documented here because the instruction that
	// asked for this flag flagged the tradeoff explicitly.
	let activated = false;

	server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
		const name = request.params.name;
		const args = (request.params.arguments ?? {}) as Record<string, unknown>;

		const descriptor = descriptors.get(name);
		if (!descriptor) {
			throw new McpError(ErrorCode.MethodNotFound, `Unknown tool "${name}".`);
		}

		// Wall-clock timer for `durationMs` — covers scope/rate-limit checks and
		// (on the happy path) the full bridge round-trip, so it reflects what a
		// caller actually waited, not just the relay leg.
		const startedAt = performance.now();
		const elapsed = () => Math.round(performance.now() - startedAt);

		// Scope gate: checked per call against THIS request's token scopes.
		const requiredScope = scopeForTool(name);
		const grantedScopes = extra.authInfo?.scopes ?? [];
		if (!grantedScopes.includes(requiredScope)) {
			recordMcpEvent({
				userId: pin.userId,
				projectId: pin.projectId,
				event: "tool_call",
				verb: name,
				source: "mcp",
				meta: {
					mutating: descriptor.mutating,
					blocked: "scope",
					status: "scope_blocked",
					durationMs: elapsed(),
					timelineChanged: false,
				},
			});
			return jsonResult(
				{
					ok: false,
					message: `Forbidden: tool "${name}" requires the "${requiredScope}" scope, but this token only grants [${grantedScopes.join(", ")}].`,
				},
				true,
			);
		}

		// Per-verb rate limit: read-scope calls (getReel, searchMedia, …) are
		// generous — a runaway agent loop must not be able to hammer
		// Postgres/embedding search unbounded. Mutating calls (generate, trim,
		// remove, …) get a tighter cap. Keyed on the session's pinned
		// {userId, projectId}, not the raw token, so every token issued for the
		// same project shares one budget.
		const rateBucket = descriptor.mutating ? "mcp:write" : "mcp:read";
		const rateKey = `${pin.userId}:${pin.projectId}`;
		const rateResult = await getRateLimiter().check(
			RATE_LIMITS[rateBucket],
			rateBucket,
			rateKey,
		);
		if (rateResult.limited) {
			recordMcpEvent({
				userId: pin.userId,
				projectId: pin.projectId,
				event: "tool_call",
				verb: name,
				source: "mcp",
				meta: {
					mutating: descriptor.mutating,
					blocked: "rate_limit",
					status: "rate_limited",
					durationMs: elapsed(),
					timelineChanged: false,
				},
			});
			return jsonResult(
				{
					ok: false,
					message: `Rate limit exceeded for ${descriptor.mutating ? "mutating" : "read"} MCP tools on this project. Please slow down and try again shortly.`,
				},
				true,
			);
		}

		const timeoutMs = LONG_RUNNING_TOOLS.has(name)
			? LONG_RUNNING_TIMEOUT_MS
			: DEFAULT_TIMEOUT_MS;

		try {
			// The bridge relays to the live tab, which executes
			// `descriptor.handler(director, args)` and answers with the untouched
			// DirectorResult — short ids, delta, SECONDS all pass through as-is.
			const result = await getEditorBridge().relayToolCall({
				projectId: pin.projectId,
				userId: pin.userId,
				tool: name,
				args,
				timeoutMs,
			});
			// timelineChanged: the cheap proxy for "did the agent actually do
			// something" — a MUTATING verb (the catalog's own flag, the same one
			// that gates the `reel:write` scope and the delta contract) that came
			// back `ok`. Reads and failed mutations never flip it.
			const timelineChanged = descriptor.mutating && result.ok;
			recordMcpEvent({
				userId: pin.userId,
				projectId: pin.projectId,
				event: "tool_call",
				verb: name,
				source: "mcp",
				meta: {
					mutating: descriptor.mutating,
					ok: result.ok,
					status: result.ok ? "ok" : "tool_error",
					durationMs: elapsed(),
					timelineChanged,
				},
			});
			// "MCP activated" = first successful tools/call this session, not TCP
			// connect (that's `session_initialized`, fired at handshake). Fires at
			// most once per session — see the `activated` closure doc above.
			if (result.ok && !activated) {
				activated = true;
				recordMcpEvent({
					userId: pin.userId,
					projectId: pin.projectId,
					event: "mcp_activated",
					verb: name,
					source: "mcp",
					meta: {
						mutating: descriptor.mutating,
						status: "ok",
						durationMs: elapsed(),
						timelineChanged,
					},
				});
			}
			return jsonResult(result, !result.ok);
		} catch (error) {
			if (error instanceof BridgeError) {
				// "no-tab" is the project-binding gap this hardening pass targets:
				// the session's bound project has no live editor right now. Refuse
				// with a structured payload instead of the bare bridge message —
				// worded as a mutation refusal or a read-availability gap depending
				// on the verb (see `bridgeRefusalFor`). Other bridge codes
				// (user-mismatch/timeout/tab-disconnected) are different failure
				// classes and keep their existing generic shape. Both branches are
				// distinct telemetry STATUSES (Wave-A's structured "no-tab" refusal
				// vs. every other bridge failure) so the two reliability stories
				// don't get averaged together in aggregate counts.
				const payload:
					| McpBridgeRefusal
					| { ok: false; message: string; bridge: string } =
					error.code === "no-tab"
						? bridgeRefusalFor(
								descriptor.mutating,
								error.details,
								error.message,
							)
						: { ok: false, message: error.message, bridge: error.code };
				recordMcpEvent({
					userId: pin.userId,
					projectId: pin.projectId,
					event: "tool_call",
					verb: name,
					source: "mcp",
					meta: {
						mutating: descriptor.mutating,
						ok: false,
						bridge: error.code,
						status: error.code === "no-tab" ? "bridge_refused" : "bridge_error",
						durationMs: elapsed(),
						timelineChanged: false,
						...("refusal" in payload ? { refusal: payload.refusal } : {}),
					},
				});
				return jsonResult(payload, true);
			}
			throw error;
		}
	});

	return server;
}

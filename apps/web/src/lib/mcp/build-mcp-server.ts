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
import { validateToolArgs } from "./arg-validate";
import { BridgeError, getEditorBridge } from "./editor-bridge";

/**
 * Generation tools do real provider work in the tab (sequential network
 * calls per take) — give them a long leash. Everything else is an in-memory
 * timeline mutation or read and should answer fast.
 */
const LONG_RUNNING_TOOLS = new Set(["generate", "reroll", "remix"]);
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

	server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
		const name = request.params.name;
		const args = (request.params.arguments ?? {}) as Record<string, unknown>;

		const descriptor = descriptors.get(name);
		if (!descriptor) {
			throw new McpError(ErrorCode.MethodNotFound, `Unknown tool "${name}".`);
		}

		// Scope gate: checked per call against THIS request's token scopes.
		const requiredScope = scopeForTool(name);
		const grantedScopes = extra.authInfo?.scopes ?? [];
		if (!grantedScopes.includes(requiredScope)) {
			recordMcpEvent({
				userId: pin.userId,
				projectId: pin.projectId,
				event: "tool_call",
				verb: name,
				meta: { mutating: descriptor.mutating, blocked: "scope" },
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
				meta: { mutating: descriptor.mutating, blocked: "rate_limit" },
			});
			return jsonResult(
				{
					ok: false,
					message: `Rate limit exceeded for ${descriptor.mutating ? "mutating" : "read"} MCP tools on this project. Please slow down and try again shortly.`,
				},
				true,
			);
		}

		// Arg-shape conformance guard (runs AFTER the security gates so a
		// malformed call can never reach the bridge): reject unknown keys where
		// the schema declares `additionalProperties: false`, and reject
		// non-finite numbers (NaN/Infinity) for numeric fields. Handlers coerce
		// types, so this stays narrow — no `required`/wrong-type enforcement.
		const argViolation = validateToolArgs(descriptor.inputSchema, args);
		if (argViolation) {
			recordMcpEvent({
				userId: pin.userId,
				projectId: pin.projectId,
				event: "tool_call",
				verb: name,
				meta: { mutating: descriptor.mutating, blocked: "invalid_args" },
			});
			return jsonResult({ ok: false, message: argViolation.message }, true);
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
			recordMcpEvent({
				userId: pin.userId,
				projectId: pin.projectId,
				event: "tool_call",
				verb: name,
				meta: { mutating: descriptor.mutating, ok: result.ok },
			});
			return jsonResult(result, !result.ok);
		} catch (error) {
			if (error instanceof BridgeError) {
				recordMcpEvent({
					userId: pin.userId,
					projectId: pin.projectId,
					event: "tool_call",
					verb: name,
					meta: {
						mutating: descriptor.mutating,
						ok: false,
						bridge: error.code,
					},
				});
				return jsonResult(
					{ ok: false, message: error.message, bridge: error.code },
					true,
				);
			}
			throw error;
		}
	});

	return server;
}

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
			return jsonResult(
				{
					ok: false,
					message: `Forbidden: tool "${name}" requires the "${requiredScope}" scope, but this token only grants [${grantedScopes.join(", ")}].`,
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
			return jsonResult(result, !result.ok);
		} catch (error) {
			if (error instanceof BridgeError) {
				return jsonResult({ ok: false, message: error.message, bridge: error.code }, true);
			}
			throw error;
		}
	});

	return server;
}

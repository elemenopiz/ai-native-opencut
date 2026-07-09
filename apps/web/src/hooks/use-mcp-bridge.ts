"use client";

/**
 * useMcpBridge — registers THIS browser tab as the live MCP executor for the
 * open project.
 *
 * The server side (`/api/mcp` + `editor-bridge.ts`) can't run tools: they
 * need the live `EditorCore` that only exists here. This hook completes the
 * loop:
 *
 *  1. Opens an `EventSource` to `/api/mcp/bridge?projectId=…` (cookie-auth;
 *     EventSource cannot send headers). The tab is now the registered
 *     executor for the project. Reconnects automatically (native EventSource
 *     behavior) if the stream drops.
 *  2. Each `tool-call` SSE event carries `{ callId, tool, args }`. The tab
 *     resolves the descriptor from the SHARED `toolCatalog()` and executes
 *     `descriptor.handler(director, args)` — the exact same code path the
 *     in-app agent uses, against the same `DirectorApi` (wired to the real
 *     studio generation executor via `useDirector`).
 *  3. POSTs the untouched `DirectorResult` (short ids, mutation delta,
 *     SECONDS) back to `/api/mcp/bridge` with the callId.
 *
 * Mounted from `EditorRuntimeBindings` so any open editor tab is reachable by
 * external MCP agents without extra user action.
 */

import { useEffect } from "react";
import { useDirector } from "@/hooks/use-director";
import { toolCatalog } from "@/lib/director/tool-catalog";
import {
	BRIDGE_TOOL_CALL_EVENT,
	type BridgeToolCall,
	type BridgeToolResultBody,
} from "@/lib/mcp/bridge-types";

export function useMcpBridge(projectId: string): void {
	const director = useDirector();

	useEffect(() => {
		if (!projectId) return;

		let disposed = false;
		// Descriptors are stateless — resolve once per connection lifetime.
		const catalog = new Map(toolCatalog().map((d) => [d.name, d]));

		const source = new EventSource(
			`/api/mcp/bridge?projectId=${encodeURIComponent(projectId)}`,
		);

		const postResult = async (body: BridgeToolResultBody) => {
			try {
				await fetch("/api/mcp/bridge", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				});
			} catch {
				// Server unreachable — its call timeout will surface the failure.
			}
		};

		source.addEventListener(BRIDGE_TOOL_CALL_EVENT, async (event) => {
			if (disposed) return;
			let call: BridgeToolCall;
			try {
				call = JSON.parse((event as MessageEvent<string>).data);
			} catch {
				return; // malformed frame — nothing to correlate a reply to
			}

			let body: BridgeToolResultBody;
			try {
				const descriptor = catalog.get(call.tool);
				if (!descriptor) {
					throw new Error(`Unknown tool "${call.tool}" (not in the catalog).`);
				}
				// The ONLY executor path — same handler the in-app agent runs.
				const result = await descriptor.handler(director, call.args);
				body = { projectId, callId: call.callId, result };
			} catch (error) {
				body = {
					projectId,
					callId: call.callId,
					error: error instanceof Error ? error.message : String(error),
				};
			}
			await postResult(body);
		});

		// Native EventSource reconnects on transient errors; nothing to do here
		// beyond avoiding console noise in production.
		source.onerror = () => {};

		return () => {
			disposed = true;
			source.close();
		};
	}, [projectId, director]);
}

/**
 * `/api/mcp/bridge` — the editor tab's side of the MCP relay.
 *
 * The MCP endpoint (`/api/mcp`) cannot execute tools: they need the live
 * `EditorCore` that exists only in the user's browser tab. This route is how
 * a tab volunteers as the executor:
 *
 *  - GET  `?projectId=…` — opens a long-lived SSE stream and registers the tab
 *    with the {@link getEditorBridge | bridge} as THE live executor for that
 *    project (latest tab wins). Relayed tool calls arrive as `tool-call`
 *    events; `ping` keep-alives flow every 25s. Cookie-authenticated
 *    (EventSource cannot set an Authorization header).
 *  - POST — the back-channel: the tab answers one relayed call with a
 *    {@link BridgeToolResultBody} `{ projectId, callId, result | error }`.
 *
 * AUTH: the tab authenticates with its better-auth session cookie; the bridge
 * pins the registration to that userId and the MCP side refuses to relay a
 * token whose userId doesn't match. In NON-production, a tab with no session
 * may register as {@link DEV_WILDCARD_USER} so local dev works without
 * sign-in (never allowed in production).
 */

import { auth } from "@/lib/auth/server";
import {
	BRIDGE_PING_EVENT,
	type BridgeToolResultBody,
} from "@/lib/mcp/bridge-types";
import { DEV_WILDCARD_USER, getEditorBridge } from "@/lib/mcp/editor-bridge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PING_INTERVAL_MS = 25_000;

/** Resolve the calling tab's user: better-auth cookie, or dev wildcard. */
async function resolveTabUser(req: Request): Promise<string | null> {
	try {
		const session = await auth.api.getSession({ headers: req.headers });
		if (session?.user?.id) return session.user.id;
	} catch {
		// auth misconfigured/unreachable — fall through to the dev check
	}
	return process.env.NODE_ENV !== "production" ? DEV_WILDCARD_USER : null;
}

export async function GET(req: Request): Promise<Response> {
	const projectId = new URL(req.url).searchParams.get("projectId");
	if (!projectId) {
		return Response.json({ error: "projectId query param is required" }, { status: 400 });
	}
	const userId = await resolveTabUser(req);
	if (!userId) {
		return Response.json({ error: "Sign in to connect this tab as an MCP executor." }, { status: 401 });
	}

	const bridge = getEditorBridge();
	const encoder = new TextEncoder();

	let tabId = "";
	let ping: ReturnType<typeof setInterval> | undefined;
	let closed = false;

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const send = (event: string, data: string) => {
				if (closed) throw new Error("bridge stream closed");
				controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
			};
			const cleanup = () => {
				if (closed) return;
				closed = true;
				if (ping) clearInterval(ping);
				bridge.unregisterTab(projectId, tabId);
				try {
					controller.close();
				} catch {
					/* already closed */
				}
			};

			tabId = bridge.registerTab({
				projectId,
				userId,
				send,
				// Called by the bridge when a newer tab replaces this one.
				close: cleanup,
			});

			send("registered", JSON.stringify({ projectId }));
			ping = setInterval(() => {
				try {
					send(BRIDGE_PING_EVENT, String(Date.now()));
				} catch {
					cleanup();
				}
			}, PING_INTERVAL_MS);
			ping.unref?.();

			// Browser tab closed / navigated away.
			req.signal.addEventListener("abort", cleanup);
		},
		cancel() {
			// Reader torn down (e.g. response GC'd) — mirror the abort path.
			if (!closed) {
				closed = true;
				if (ping) clearInterval(ping);
				bridge.unregisterTab(projectId, tabId);
			}
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		},
	});
}

export async function POST(req: Request): Promise<Response> {
	const userId = await resolveTabUser(req);
	if (!userId) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	let body: BridgeToolResultBody;
	try {
		body = (await req.json()) as BridgeToolResultBody;
	} catch {
		return Response.json({ error: "Body must be JSON" }, { status: 400 });
	}
	if (!body?.callId || !body?.projectId) {
		return Response.json({ error: "callId and projectId are required" }, { status: 400 });
	}

	const accepted = getEditorBridge().resolveCall({
		callId: body.callId,
		projectId: body.projectId,
		userId,
		result: body.result,
		error: body.error,
	});
	if (!accepted) {
		// Unknown, already-answered, timed-out, or foreign call id.
		return Response.json({ error: "No pending call matched" }, { status: 404 });
	}
	return Response.json({ ok: true }, { status: 200 });
}

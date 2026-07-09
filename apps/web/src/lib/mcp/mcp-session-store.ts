/**
 * MCP session store — stateful `Mcp-Session-Id` bookkeeping for `/api/mcp`.
 *
 * One MCP session == one `{ Server, WebStandardStreamableHTTPServerTransport }`
 * pair, created when a client sends `initialize` and pinned to the
 * `{ userId, projectId }` of the bearer token that initialized it. Every
 * subsequent request must present the session id AND a token for the same
 * user/project (enforced in the route, using the pin stored here).
 *
 * Two independent eviction mechanisms (both required by the spec of this
 * slice):
 *  - IDLE TIMEOUT: sessions untouched for {@link IDLE_TIMEOUT_MS} are closed
 *    by a periodic sweeper.
 *  - LRU CAP: at most {@link MAX_SESSIONS} concurrent sessions; inserting
 *    beyond the cap closes the least-recently-used session. The Map's
 *    insertion order is maintained as recency order (`touch` re-inserts).
 *
 * Evicted/expired session ids simply 404 on their next request, prompting the
 * client to re-initialize — the behavior the Streamable HTTP spec prescribes.
 *
 * Same deployment caveat as `editor-bridge.ts`: in-memory, `globalThis`-cached
 * (survives dev HMR), single-instance by design for now.
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

/** Sessions idle longer than this are evicted (30 minutes). */
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
/** Hard cap on concurrent sessions; beyond it the LRU session is evicted. */
const MAX_SESSIONS = 64;
/** How often the idle sweeper runs. */
const SWEEP_INTERVAL_MS = 60 * 1000;

export interface McpSession {
	id: string;
	server: Server;
	transport: WebStandardStreamableHTTPServerTransport;
	/** Pin: only tokens for this user may use the session. */
	userId: string;
	/** Pin: only tokens for this project may use the session. */
	projectId: string;
	createdAt: number;
	lastSeenAt: number;
}

class McpSessionStore {
	/** Insertion order == recency order (touch re-inserts). */
	private sessions = new Map<string, McpSession>();
	private sweeper: ReturnType<typeof setInterval>;

	constructor() {
		this.sweeper = setInterval(() => this.sweepIdle(), SWEEP_INTERVAL_MS);
		this.sweeper.unref?.();
	}

	/** Register a freshly initialized session, evicting the LRU one if at cap. */
	set(session: McpSession): void {
		while (this.sessions.size >= MAX_SESSIONS) {
			const lruId = this.sessions.keys().next().value;
			if (lruId === undefined) break;
			this.evict(lruId, "lru-cap");
		}
		this.sessions.set(session.id, session);
	}

	/**
	 * Look up a session and mark it as just-used (moves it to the MRU end).
	 * Returns undefined for unknown or already-evicted ids.
	 */
	touch(sessionId: string): McpSession | undefined {
		const session = this.sessions.get(sessionId);
		if (!session) return undefined;
		session.lastSeenAt = Date.now();
		// Re-insert to refresh recency order.
		this.sessions.delete(sessionId);
		this.sessions.set(sessionId, session);
		return session;
	}

	/** Forget a session without closing (the transport already closed itself). */
	delete(sessionId: string): void {
		this.sessions.delete(sessionId);
	}

	/** Close and forget a session (idle sweep / LRU eviction). */
	private evict(sessionId: string, reason: "idle" | "lru-cap"): void {
		const session = this.sessions.get(sessionId);
		if (!session) return;
		this.sessions.delete(sessionId);
		// Close transport first (terminates any open SSE stream), then server.
		void session.transport
			.close()
			.catch(() => {})
			.then(() => session.server.close())
			.catch(() => {});
		if (process.env.NODE_ENV !== "production") {
			console.log(`[mcp] evicted session ${sessionId} (${reason})`);
		}
	}

	private sweepIdle(): void {
		const cutoff = Date.now() - IDLE_TIMEOUT_MS;
		for (const [id, session] of this.sessions) {
			if (session.lastSeenAt < cutoff) this.evict(id, "idle");
		}
	}
}

const globalStore = globalThis as unknown as {
	__byornMcpSessionStore?: McpSessionStore;
};

export function getMcpSessionStore(): McpSessionStore {
	globalStore.__byornMcpSessionStore ??= new McpSessionStore();
	return globalStore.__byornMcpSessionStore;
}

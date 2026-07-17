/**
 * Cross-instance relay for the MCP editor bridge, over the Upstash Redis
 * pub/sub already shipped in `@upstash/redis` (the same dependency
 * `token-cache.ts` uses for the token-verification cache — no new package).
 *
 * WHY THIS EXISTS: `editor-bridge.ts` keeps its tab registry and pending-call
 * map in-memory on `globalThis`. That is exact and instant on a single
 * long-lived Node server, but on a scale-to-many serverless deployment
 * (Vercel) the SSE tab registration (`GET /api/mcp/bridge`) and a later MCP
 * tool call (`POST /api/mcp`) can land on DIFFERENT instances — the calling
 * instance's local `tabs` map has no entry even though a tab is live
 * elsewhere, and the call would incorrectly fail "no-tab". This module
 * bridges that gap; `editor-bridge.ts` consumes only the {@link BridgeRelay}
 * interface below, so the in-memory local path is completely unaffected when
 * Redis isn't configured (see {@link createBridgeRelay}).
 *
 * VIABILITY: `@upstash/redis` (^1.35, 1.38.0 installed) ships
 * `Redis.prototype.subscribe`/`.publish` — real Redis PUBLISH/SUBSCRIBE
 * routed through Upstash's REST endpoint, delivered to the caller as an
 * `Accept: text/event-stream` response consumed via `fetch` + a streaming
 * body reader (`res.body.getReader()`). That is plain Node.js `fetch`
 * streaming — no browser-only `EventSource`, no edge-runtime requirement —
 * so it works in the exact same `runtime = "nodejs"` route
 * (`/api/mcp/bridge`) that already holds a long-lived SSE connection open to
 * the browser tab for the tab's whole session. Piggy-backing a Redis
 * subscription on that same request lifecycle adds no new "must stay alive"
 * requirement: the route was already a long-lived streaming handler.
 *
 * CHANNEL SCHEME:
 *  - Call channel, one per project: `mcp:bridge:call:{projectId}`. The
 *    instance holding a project's live tab subscribes to it for as long as
 *    the tab stays registered (subscribe on `registerTab`, unsubscribe on
 *    `unregisterTab` / replacement).
 *  - Answer channel, one per call: `mcp:bridge:answer:{callId}`. A shared
 *    per-instance "answers" channel would need the calling instance to demux
 *    many in-flight callIds off one stream and track listener lifecycles by
 *    hand; a channel-per-call needs none of that — Redis pub/sub channels
 *    are free to create, and one SSE subscribe/unsubscribe round trip
 *    (roughly a hundred ms against Upstash) is a rounding error against the
 *    multi-second tool-call timeout budget. Simplicity here directly reduces
 *    bug surface in a path that must fail soft.
 *  - `PUBLISH` returns the live receiver count on the call channel: 0 means
 *    no instance anywhere has a subscribed tab for the project (the
 *    project's tab is genuinely offline, or Redis itself is unreachable —
 *    {@link UpstashBridgeRelay.publishCall} folds a throw into 0 too), so
 *    `relayToolCall` keeps today's "no-tab" `BridgeError` verbatim; >=1 means
 *    some instance is listening and `relayToolCall` awaits the per-call
 *    answer channel under the same `timeoutMs` it already used locally.
 *
 * FAIL-SOFT: every method here is written to never throw and never leave an
 * unhandled rejection — a Redis outage degrades a multi-instance deployment
 * to "same as no relay configured" (calls to a tab on another instance
 * report "no-tab" instead of an outage error), and must never make a
 * single-instance deployment (relay absent) worse. `editor-bridge.ts` also
 * wraps every relay call defensively — see its inline comments — because a
 * contract of "never throws" is not the same guarantee as "never crashes the
 * caller"; the belt-and-suspenders here is deliberate.
 */

import { Redis } from "@upstash/redis";
import type { DirectorResult } from "@/lib/director/types";
import type { BridgeErrorCode } from "./editor-bridge";

const CALL_CHANNEL_PREFIX = "mcp:bridge:call:";
const ANSWER_CHANNEL_PREFIX = "mcp:bridge:answer:";

/** Placeholder env defaults from `@byorn/env/web` — treated as "not configured" (mirrors `token-cache.ts`). */
const PLACEHOLDER_URL = "http://localhost:8079";
const PLACEHOLDER_TOKEN = "example_token";

/** One relayed MCP tool call, published to a project's call channel. */
export interface RelayedCall {
	/** Correlation id — the answer must be published on `mcp:bridge:answer:{callId}`. */
	callId: string;
	/** Catalog tool name (e.g. "getReel", "storyboard"). */
	tool: string;
	/** Raw tool arguments, passed to the catalog handler untouched. */
	args: Record<string, unknown>;
	/** The calling token's userId — the receiving instance re-checks this against its tab's userId. */
	userId: string;
	/**
	 * The same deadline the calling instance is waiting under — passed
	 * through so the tab-holding instance's own local send-to-tab wait
	 * (`EditorBridge.sendToLocalTab`) times out around the same wall-clock
	 * moment instead of picking an arbitrary value or hanging indefinitely.
	 */
	timeoutMs: number;
}

/**
 * The answer to one relayed call, published to `mcp:bridge:answer:{callId}`.
 * Two shapes:
 *  - `result` set: the tab executed the tool — resolve with this untouched
 *    `DirectorResult`.
 *  - `result` absent: `bridgeErrorCode` set means a bridge-level refusal
 *    decided by the receiving instance ("user-mismatch" — the local
 *    pre-flight check `relayToolCall` runs against a LOCAL tab has no local
 *    tab to check against on the calling instance, so the instance that
 *    actually holds the tab makes the call and reports it back; also
 *    "timeout"/"tab-disconnected" when the tab-holding instance's OWN local
 *    wait for the tab failed). Reject with a `BridgeError` built from
 *    `bridgeErrorCode` + `error` (used as the message). `bridgeErrorCode`
 *    absent means the tab's handler threw — resolve as a failed
 *    `DirectorResult` using `error` as the message, exactly matching what
 *    the local path does in `EditorBridge.resolveCall`.
 */
export interface RelayedAnswer {
	result?: DirectorResult<unknown>;
	/** Human-readable message — a handler-thrown failure's message when `bridgeErrorCode` is absent, or the `BridgeError` message to reconstruct when it's present. */
	error?: string;
	bridgeErrorCode?: BridgeErrorCode;
}

/**
 * Narrow interface `editor-bridge.ts` depends on. Swap in a fake
 * (in-memory, synchronous-dispatch) implementation in tests to simulate two
 * "instances" sharing one relay without touching real Redis.
 */
export interface BridgeRelay {
	/**
	 * Publish a relayed call to a project's call channel. Resolves to the
	 * live receiver count (0 = nobody anywhere is listening). Never throws —
	 * a publish failure resolves to 0 so the caller falls back to the
	 * standard "no-tab" refusal instead of hanging.
	 */
	publishCall(projectId: string, call: RelayedCall): Promise<number>;

	/**
	 * Publish the answer for one call. Fire-and-forget from the receiving
	 * instance's perspective — never throws. If nobody is listening anymore
	 * (the caller already timed out), the publish still succeeds against
	 * Redis but simply has 0 receivers; the caller's timeout path already
	 * unsubscribed, so a late answer is silently dropped.
	 */
	publishAnswer(callId: string, answer: RelayedAnswer): Promise<void>;

	/**
	 * Subscribe to relayed calls for a project. `handler` fires once per
	 * published call (including calls this same instance published, if it
	 * also happens to hold the tab — that's fine, it's the same execution
	 * path a local call would take). Returns an idempotent unsubscribe
	 * function; call it exactly once when the tab that triggered this
	 * subscription unregisters or is replaced, to avoid a leaked subscriber.
	 */
	subscribeToCalls(
		projectId: string,
		handler: (call: RelayedCall) => void,
	): () => void;

	/**
	 * Subscribe to the answer channel for one call. `handler` fires at most
	 * once; the relay auto-unsubscribes after delivering it. Returns an
	 * idempotent unsubscribe function — call it on timeout so a late answer
	 * (if one still arrives) has nothing subscribed to receive it.
	 */
	subscribeToAnswer(
		callId: string,
		handler: (answer: RelayedAnswer) => void,
	): () => void;
}

/**
 * The slice of the Upstash `Redis` client this module relies on — derived
 * from the real class (rather than hand-rolled) because `subscribe` returns
 * the SDK's `Subscriber`, whose generic `on(type, listener)` signature is
 * not expressible as a simple structural interface.
 */
export type RedisPubSubClient = Pick<Redis, "publish" | "subscribe">;

/** The only bits of the SDK `Subscriber` the teardown helper needs. */
interface Unsubscribable {
	unsubscribe(): Promise<void>;
}

/** Upstash/Redis-backed relay. Shared across instances; every op fails soft. */
export class UpstashBridgeRelay implements BridgeRelay {
	constructor(private readonly redis: RedisPubSubClient) {}

	private callChannel(projectId: string): string {
		return `${CALL_CHANNEL_PREFIX}${projectId}`;
	}

	private answerChannel(callId: string): string {
		return `${ANSWER_CHANNEL_PREFIX}${callId}`;
	}

	async publishCall(projectId: string, call: RelayedCall): Promise<number> {
		try {
			return await this.redis.publish(this.callChannel(projectId), call);
		} catch {
			// Fail soft: no receiver count we can trust → behave as if nobody is
			// listening. relayToolCall turns that into the standard "no-tab"
			// refusal rather than hanging until timeoutMs.
			return 0;
		}
	}

	async publishAnswer(callId: string, answer: RelayedAnswer): Promise<void> {
		try {
			await this.redis.publish(this.answerChannel(callId), answer);
		} catch {
			// Best-effort: the caller (if still waiting) simply times out instead
			// of hanging forever on a channel nothing ever arrives on.
		}
	}

	subscribeToCalls(
		projectId: string,
		handler: (call: RelayedCall) => void,
	): () => void {
		try {
			const subscriber = this.redis.subscribe<RelayedCall>(
				this.callChannel(projectId),
			);
			subscriber.on("message", (data) => {
				try {
					handler(data.message);
				} catch {
					// A handler bug must not take down the subscription — the next
					// relayed call should still be delivered.
				}
			});
			subscriber.on("error", () => {
				// Fail soft: a dropped subscription just means this instance stops
				// receiving remote calls for this project until the tab
				// re-registers (which re-subscribes). No crash, no leak.
			});
			return unsubscribeOnce(subscriber);
		} catch {
			return () => {};
		}
	}

	subscribeToAnswer(
		callId: string,
		handler: (answer: RelayedAnswer) => void,
	): () => void {
		try {
			const subscriber = this.redis.subscribe<RelayedAnswer>(
				this.answerChannel(callId),
			);
			const unsubscribe = unsubscribeOnce(subscriber);
			subscriber.on("message", (data) => {
				unsubscribe();
				handler(data.message);
			});
			subscriber.on("error", () => {
				unsubscribe();
			});
			return unsubscribe;
		} catch {
			return () => {};
		}
	}
}

/** Wrap a subscriber's `unsubscribe()` so repeated/late calls are no-ops and never throw. */
function unsubscribeOnce(subscriber: Unsubscribable): () => void {
	let done = false;
	return () => {
		if (done) return;
		done = true;
		try {
			void subscriber.unsubscribe().catch(() => {
				/* best-effort teardown */
			});
		} catch {
			/* best-effort teardown */
		}
	};
}

/**
 * Upstash credentials, read straight from `process.env` — mirrors
 * `token-cache.ts`'s `upstashEnv()` (intentionally not the validated
 * `webEnv`, so this module and its tests don't couple to the app's full env
 * schema).
 */
function upstashEnv(): { url?: string; token?: string } {
	return {
		url: process.env.UPSTASH_REDIS_REST_URL,
		token: process.env.UPSTASH_REDIS_REST_TOKEN,
	};
}

/** True when real Upstash credentials are present (mirrors `isUpstashConfigured` in `token-cache.ts`). */
export function isBridgeRelayConfigured(): boolean {
	const { url, token } = upstashEnv();
	return (
		!!url && !!token && url !== PLACEHOLDER_URL && token !== PLACEHOLDER_TOKEN
	);
}

/**
 * Build the relay appropriate for the current environment. Returns `null`
 * when Upstash is unconfigured (local dev, tests, self-hosted single
 * instance) — `editor-bridge.ts` treats a `null` relay as "behave exactly as
 * before this module existed."
 */
export function createBridgeRelay(): BridgeRelay | null {
	const { url, token } = upstashEnv();
	if (url && token && url !== PLACEHOLDER_URL && token !== PLACEHOLDER_TOKEN) {
		return new UpstashBridgeRelay(new Redis({ url, token }));
	}
	return null;
}

/**
 * Process-wide singleton, cached on `globalThis` so Next.js dev HMR doesn't
 * re-create it (mirrors `editor-bridge.ts` / `token-cache.ts`).
 */
const globalStore = globalThis as unknown as {
	__byornBridgeRelay?: BridgeRelay | null;
};

export function getBridgeRelay(): BridgeRelay | null {
	if (globalStore.__byornBridgeRelay === undefined) {
		globalStore.__byornBridgeRelay = createBridgeRelay();
	}
	return globalStore.__byornBridgeRelay;
}

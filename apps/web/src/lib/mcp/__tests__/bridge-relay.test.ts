/**
 * Cross-instance MCP editor-bridge relay, exercised WITHOUT real Redis: a
 * hermetic, synchronous-dispatch fake `BridgeRelay` (`FakeBridgeRelay` below)
 * stands in for Upstash pub/sub. Two `EditorBridge` instances sharing one
 * fake relay simulate two server instances behind a load balancer — exactly
 * the scenario `bridge-relay.ts`'s header documents: the SSE tab
 * registration lands on one instance, a later MCP tool call lands on
 * another, and the relay is what lets the second instance find the tab the
 * first is holding.
 *
 * `UpstashBridgeRelay` itself (the real Redis-backed implementation) is not
 * exercised here — that would require a live Upstash database. What IS
 * covered is the contract both implementations share (`BridgeRelay`) and
 * every fail-soft path in `EditorBridge` that consumes it.
 */

import { describe, expect, test } from "bun:test";
import type { BridgeRelay, RelayedAnswer, RelayedCall } from "../bridge-relay";
import { BridgeError, EditorBridge } from "../editor-bridge";

/**
 * In-memory, fully synchronous stand-in for Redis pub/sub. `publishCall`/
 * `publishAnswer` dispatch to registered handlers immediately (no real
 * network hop), which is enough to exercise the ordering `EditorBridge`
 * depends on (subscribe-before-publish) and every fail-soft branch.
 */
class FakeBridgeRelay implements BridgeRelay {
	private callSubs = new Map<string, Set<(call: RelayedCall) => void>>();
	private answerSubs = new Map<string, (answer: RelayedAnswer) => void>();
	private failing = false;

	/** Make every method throw synchronously, simulating a Redis outage. */
	setFailing(failing: boolean): void {
		this.failing = failing;
	}

	callSubscriberCount(projectId: string): number {
		return this.callSubs.get(projectId)?.size ?? 0;
	}

	async publishCall(projectId: string, call: RelayedCall): Promise<number> {
		if (this.failing) throw new Error("redis down");
		const subs = this.callSubs.get(projectId);
		const count = subs?.size ?? 0;
		if (subs) {
			for (const handler of [...subs]) handler(call);
		}
		return count;
	}

	async publishAnswer(callId: string, answer: RelayedAnswer): Promise<void> {
		if (this.failing) throw new Error("redis down");
		const handler = this.answerSubs.get(callId);
		if (!handler) return; // nobody listening — matches Redis PUBLISH with 0 receivers
		this.answerSubs.delete(callId);
		handler(answer);
	}

	subscribeToCalls(
		projectId: string,
		handler: (call: RelayedCall) => void,
	): () => void {
		if (this.failing) throw new Error("redis down");
		let subs = this.callSubs.get(projectId);
		if (!subs) {
			subs = new Set();
			this.callSubs.set(projectId, subs);
		}
		subs.add(handler);
		let unsubscribed = false;
		return () => {
			if (unsubscribed) return;
			unsubscribed = true;
			subs?.delete(handler);
		};
	}

	subscribeToAnswer(
		callId: string,
		handler: (answer: RelayedAnswer) => void,
	): () => void {
		if (this.failing) throw new Error("redis down");
		this.answerSubs.set(callId, handler);
		let unsubscribed = false;
		return () => {
			if (unsubscribed) return;
			unsubscribed = true;
			this.answerSubs.delete(callId);
		};
	}
}

/** Wait for the microtask queue to drain (lets fire-and-forget relay publishes settle). */
function flushMicrotasks(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("cross-instance relay", () => {
	test("remote round-trip: tab registered on bridge B, call on bridge A resolves via the relay", async () => {
		const relay = new FakeBridgeRelay();
		const bridgeA = new EditorBridge(relay);
		const bridgeB = new EditorBridge(relay);

		bridgeB.registerTab({
			projectId: "proj_remote",
			userId: "user_1",
			send: (_event, data) => {
				const payload = JSON.parse(data) as { callId: string };
				bridgeB.resolveCall({
					callId: payload.callId,
					projectId: "proj_remote",
					userId: "user_1",
					result: { ok: true, message: "executed on B" },
				});
			},
			close: () => {},
		});

		const result = await bridgeA.relayToolCall({
			projectId: "proj_remote",
			userId: "user_1",
			tool: "getReel",
			args: {},
			timeoutMs: 2000,
		});

		expect(result).toEqual({ ok: true, message: "executed on B" });
	});

	test("zero receivers anywhere yields the standard no-tab BridgeError with details intact", async () => {
		const relay = new FakeBridgeRelay();
		const bridgeA = new EditorBridge(relay);

		await expect(
			bridgeA.relayToolCall({
				projectId: "proj_nobody_home",
				userId: "user_1",
				tool: "getReel",
				args: {},
				timeoutMs: 200,
			}),
		).rejects.toMatchObject({
			name: "BridgeError",
			code: "no-tab",
			details: { boundProjectId: "proj_nobody_home" },
		});
	});

	test("a throwing relay falls back to local-only behavior (local tab still works, no unhandled rejection)", async () => {
		const relay = new FakeBridgeRelay();
		relay.setFailing(true);
		const bridgeA = new EditorBridge(relay);

		// No local tab, and the relay throws on every call — must still resolve
		// to the ordinary "no-tab" refusal instead of hanging or throwing an
		// unrelated error.
		await expect(
			bridgeA.relayToolCall({
				projectId: "proj_outage",
				userId: "user_1",
				tool: "getReel",
				args: {},
				timeoutMs: 200,
			}),
		).rejects.toMatchObject({ code: "no-tab" });

		// registerTab must also fail soft when subscribeToCalls throws.
		bridgeA.registerTab({
			projectId: "proj_outage_local",
			userId: "user_1",
			send: (_event, data) => {
				const payload = JSON.parse(data) as { callId: string };
				bridgeA.resolveCall({
					callId: payload.callId,
					projectId: "proj_outage_local",
					userId: "user_1",
					result: { ok: true, message: "local path unaffected by the outage" },
				});
			},
			close: () => {},
		});

		const result = await bridgeA.relayToolCall({
			projectId: "proj_outage_local",
			userId: "user_1",
			tool: "getReel",
			args: {},
			timeoutMs: 500,
		});
		expect(result).toEqual({
			ok: true,
			message: "local path unaffected by the outage",
		});
	});

	test("a remote user-mismatch is refused as a BridgeError before the tab is ever called", async () => {
		const relay = new FakeBridgeRelay();
		const bridgeA = new EditorBridge(relay);
		const bridgeB = new EditorBridge(relay);

		bridgeB.registerTab({
			projectId: "proj_owned",
			userId: "user_owner",
			send: () => {
				throw new Error(
					"send must not be called — user-mismatch has to short-circuit first",
				);
			},
			close: () => {},
		});

		await expect(
			bridgeA.relayToolCall({
				projectId: "proj_owned",
				userId: "user_attacker",
				tool: "getReel",
				args: {},
				timeoutMs: 500,
			}),
		).rejects.toMatchObject({
			name: "BridgeError",
			code: "user-mismatch",
		});
	});

	test("timeout on an unanswered remote call; a late answer afterward is ignored", async () => {
		const relay = new FakeBridgeRelay();
		const bridgeA = new EditorBridge(relay);
		const bridgeB = new EditorBridge(relay);

		let capturedCallId = "";
		bridgeB.registerTab({
			projectId: "proj_slow",
			userId: "user_1",
			send: (_event, data) => {
				capturedCallId = (JSON.parse(data) as { callId: string }).callId;
				// Deliberately never answers before A's deadline.
			},
			close: () => {},
		});

		await expect(
			bridgeA.relayToolCall({
				projectId: "proj_slow",
				userId: "user_1",
				tool: "getReel",
				args: {},
				timeoutMs: 20,
			}),
		).rejects.toMatchObject({ code: "timeout" });

		expect(capturedCallId).not.toBe("");

		// B finally answers, well after A gave up. Must not throw and must not
		// resolve/reject anything — A already settled.
		expect(() =>
			bridgeB.resolveCall({
				callId: capturedCallId,
				projectId: "proj_slow",
				userId: "user_1",
				result: { ok: true, message: "too late" },
			}),
		).not.toThrow();

		// Let the fire-and-forget publishAnswer chain flush; nothing should blow up.
		await flushMicrotasks();
	});

	test("unregistering a tab cleans up its relay call subscription (no leaked subscriber)", () => {
		const relay = new FakeBridgeRelay();
		const bridge = new EditorBridge(relay);

		const tabId = bridge.registerTab({
			projectId: "proj_cleanup",
			userId: "user_1",
			send: () => {},
			close: () => {},
		});
		expect(relay.callSubscriberCount("proj_cleanup")).toBe(1);

		bridge.unregisterTab("proj_cleanup", tabId);
		expect(relay.callSubscriberCount("proj_cleanup")).toBe(0);
	});

	test("replacing a tab unsubscribes the old registration's relay subscription", () => {
		const relay = new FakeBridgeRelay();
		const bridge = new EditorBridge(relay);

		bridge.registerTab({
			projectId: "proj_replace",
			userId: "user_1",
			send: () => {},
			close: () => {},
		});
		expect(relay.callSubscriberCount("proj_replace")).toBe(1);

		bridge.registerTab({
			projectId: "proj_replace",
			userId: "user_1",
			send: () => {},
			close: () => {},
		});
		// Exactly one live subscriber, never two — the first was torn down at
		// replacement time.
		expect(relay.callSubscriberCount("proj_replace")).toBe(1);
	});

	test("local path is unchanged when no relay is configured (env unset)", async () => {
		const bridge = new EditorBridge(null);

		await expect(
			bridge.relayToolCall({
				projectId: "proj_no_relay",
				userId: "user_1",
				tool: "getReel",
				args: {},
				timeoutMs: 100,
			}),
		).rejects.toMatchObject({
			name: "BridgeError",
			code: "no-tab",
			details: { boundProjectId: "proj_no_relay" },
		});

		bridge.registerTab({
			projectId: "proj_no_relay",
			userId: "user_1",
			send: (_event, data) => {
				const payload = JSON.parse(data) as { callId: string };
				bridge.resolveCall({
					callId: payload.callId,
					projectId: "proj_no_relay",
					userId: "user_1",
					result: { ok: true, message: "plain local call" },
				});
			},
			close: () => {},
		});

		const result = await bridge.relayToolCall({
			projectId: "proj_no_relay",
			userId: "user_1",
			tool: "getReel",
			args: {},
			timeoutMs: 500,
		});
		expect(result).toEqual({ ok: true, message: "plain local call" });

		// A different user still gets the ordinary local user-mismatch refusal.
		await expect(
			bridge.relayToolCall({
				projectId: "proj_no_relay",
				userId: "user_2",
				tool: "getReel",
				args: {},
				timeoutMs: 100,
			}),
		).rejects.toMatchObject({ code: "user-mismatch" });
	});
});

describe("BridgeError sanity", () => {
	test("is a real Error subclass carrying code and details", () => {
		const err = new BridgeError("no-tab", "nope", { boundProjectId: "p" });
		expect(err).toBeInstanceOf(Error);
		expect(err.code).toBe("no-tab");
		expect(err.details).toEqual({ boundProjectId: "p" });
	});
});

/**
 * MCP editor bridge — SERVER-SIDE broker between the MCP endpoint and the
 * live in-browser editor.
 *
 * THE PROBLEM: `createDirectorApi(editor)` needs a live `EditorCore` — a
 * browser-only object. The MCP endpoint is a Next.js route. An external agent
 * talks to the route, but the timeline it must drive lives in the user's
 * browser tab. The server can never instantiate `EditorCore`, so it acts as a
 * RELAY: the tab registers itself here as the executor for its `{projectId}`
 * (via the SSE stream in `/api/mcp/bridge`), and every MCP tool call is
 * forwarded to that tab and awaited.
 *
 * Flow for one tool call:
 *   agent → POST /api/mcp → CallTool handler → `relayToolCall()`
 *     → SSE `tool-call` event to the registered tab
 *     → tab executes `descriptor.handler(director, args)`
 *     → tab POSTs `{ callId, result }` to /api/mcp/bridge → `resolveCall()`
 *     → the awaited promise resolves with the untouched `DirectorResult`.
 *
 * If NO tab is registered for the project, `relayToolCall` rejects with a
 * {@link BridgeError} (`code: "no-tab"`) carrying {@link BridgeErrorDetails} —
 * the bound project, plus (only when knowable) the project another live tab
 * for the SAME user is currently on. The MCP layer (`build-mcp-server.ts`)
 * turns this into a structured refusal, worded differently for a mutating
 * verb ("project-mismatch" — refuse, this verb requires the bound project's
 * own live editor) vs. a read verb ("bridge-unavailable" — no mutation risk,
 * just nothing to serve the read from). See that file's `bridgeRefusalFor`.
 *
 * DEPLOYMENT CAVEAT (honest limits): the registry and pending-call maps are
 * in-memory, cached on `globalThis` so they survive Next.js dev HMR. This
 * works on any single long-lived Node server (`next dev`, `next start`,
 * self-hosted). On a scale-to-many serverless platform the SSE registration
 * and a later tool call may land on DIFFERENT instances — production-grade
 * multi-instance deployment needs a shared pub/sub (e.g. Redis) behind this
 * same interface.
 */

import type { DirectorResult } from "@/lib/director/types";
import type { BridgeToolCall } from "./bridge-types";
import { BRIDGE_TOOL_CALL_EVENT } from "./bridge-types";

/**
 * Sentinel userId a tab may register under in NON-production when the browser
 * has no auth session (local dev without sign-in). A wildcard tab accepts
 * relayed calls from any verified token. Never granted in production — see
 * `/api/mcp/bridge`.
 */
export const DEV_WILDCARD_USER = "__local-dev__";

/** Machine-readable failure reasons for a relayed call. */
export type BridgeErrorCode =
	| "no-tab" // no live editor tab registered for the project
	| "user-mismatch" // tab belongs to a different user than the token
	| "timeout" // tab never answered within the deadline
	| "tab-disconnected"; // tab's SSE stream closed while the call was in flight

/**
 * What the server legitimately knows about a "no-tab" refusal — the project
 * the MCP session is bound to, and (only when a live tab for the SAME user is
 * connected under a different project) which project that is. Never carries
 * another user's state — see {@link EditorBridge.findActiveProjectForUser}.
 */
export interface BridgeErrorDetails {
	boundProjectId: string;
	activeProjectId?: string;
}

export class BridgeError extends Error {
	readonly code: BridgeErrorCode;
	/** Present on "no-tab" errors — see {@link BridgeErrorDetails}. */
	readonly details?: BridgeErrorDetails;
	constructor(
		code: BridgeErrorCode,
		message: string,
		details?: BridgeErrorDetails,
	) {
		super(message);
		this.name = "BridgeError";
		this.code = code;
		this.details = details;
	}
}

/** A browser tab registered as the live executor for one project. */
interface RegisteredTab {
	tabId: string;
	projectId: string;
	/** better-auth user id, or {@link DEV_WILDCARD_USER} in dev without auth. */
	userId: string;
	/** Push one SSE event (already-serialized data) down the tab's stream. */
	send: (event: string, data: string) => void;
	/** Close the underlying SSE stream (used when a newer tab replaces this one). */
	close: () => void;
	connectedAt: number;
}

interface PendingCall {
	callId: string;
	projectId: string;
	/** The tab the call was sent to (for disconnect cleanup). */
	tabId: string;
	/** That tab's userId — the only identity allowed to answer the call. */
	tabUserId: string;
	resolve: (result: DirectorResult<unknown>) => void;
	reject: (error: BridgeError) => void;
	timer: ReturnType<typeof setTimeout>;
}

class EditorBridge {
	/** projectId → the single live executor tab (latest registration wins). */
	private tabs = new Map<string, RegisteredTab>();
	/** callId → in-flight relayed call awaiting its POST back-channel answer. */
	private pending = new Map<string, PendingCall>();

	/**
	 * Register a tab as the live executor for a project. If another tab is
	 * already registered for the same project, it is closed and replaced —
	 * exactly one executor per project.
	 */
	registerTab(input: {
		projectId: string;
		userId: string;
		send: (event: string, data: string) => void;
		close: () => void;
	}): string {
		const existing = this.tabs.get(input.projectId);
		if (existing) {
			this.failCallsForTab(
				existing.tabId,
				"tab-disconnected",
				"The editor tab was replaced by a newer one while this call was in flight.",
			);
			try {
				existing.close();
			} catch {
				/* stream already gone */
			}
		}
		const tab: RegisteredTab = {
			tabId: crypto.randomUUID(),
			projectId: input.projectId,
			userId: input.userId,
			send: input.send,
			close: input.close,
			connectedAt: Date.now(),
		};
		this.tabs.set(input.projectId, tab);
		return tab.tabId;
	}

	/**
	 * Remove a tab (SSE stream closed). Only removes if this tab is still the
	 * current registration — a replaced tab's late cleanup must not evict its
	 * successor. In-flight calls sent to this tab are failed immediately.
	 */
	unregisterTab(projectId: string, tabId: string): void {
		const current = this.tabs.get(projectId);
		if (current?.tabId === tabId) {
			this.tabs.delete(projectId);
		}
		this.failCallsForTab(
			tabId,
			"tab-disconnected",
			"The editor tab disconnected while this call was in flight.",
		);
	}

	/** Is a live executor tab registered for this project? */
	hasTab(projectId: string): boolean {
		return this.tabs.has(projectId);
	}

	/**
	 * If a live tab is registered for a DIFFERENT project than `excludeProjectId`
	 * but under the SAME user (or the dev wildcard — mirrors the permissiveness
	 * `relayToolCall` already applies to answering calls), return that project's
	 * id. This is the one piece of cross-project state the server is allowed to
	 * surface in a refusal: never another user's tabs, and never more than "a
	 * project this same user currently has open." Picks the most-recently
	 * connected match when more than one exists.
	 */
	private findActiveProjectForUser(
		userId: string,
		excludeProjectId: string,
	): string | undefined {
		let best: RegisteredTab | undefined;
		for (const tab of this.tabs.values()) {
			if (tab.projectId === excludeProjectId) continue;
			const sameUser =
				tab.userId === userId ||
				tab.userId === DEV_WILDCARD_USER ||
				userId === DEV_WILDCARD_USER;
			if (!sameUser) continue;
			if (!best || tab.connectedAt > best.connectedAt) best = tab;
		}
		return best?.projectId;
	}

	/**
	 * Relay one tool call to the project's registered tab and await its
	 * `DirectorResult`. Rejects with a {@link BridgeError} when there is no
	 * tab, the tab belongs to another user, the deadline passes, or the tab
	 * disconnects mid-call.
	 */
	relayToolCall(input: {
		projectId: string;
		userId: string;
		tool: string;
		args: Record<string, unknown>;
		timeoutMs: number;
	}): Promise<DirectorResult<unknown>> {
		const tab = this.tabs.get(input.projectId);
		if (!tab) {
			const activeProjectId = this.findActiveProjectForUser(
				input.userId,
				input.projectId,
			);
			const activeNote = activeProjectId
				? ` The editor is currently connected to a different project ("${activeProjectId}").`
				: "";
			return Promise.reject(
				new BridgeError(
					"no-tab",
					`No live editor connected for project "${input.projectId}" — open the project in a browser tab (the editor registers itself as the executor) and retry.${activeNote}`,
					{ boundProjectId: input.projectId, activeProjectId },
				),
			);
		}
		if (tab.userId !== DEV_WILDCARD_USER && tab.userId !== input.userId) {
			return Promise.reject(
				new BridgeError(
					"user-mismatch",
					"The connected editor tab belongs to a different user than this token.",
				),
			);
		}

		const callId = crypto.randomUUID();
		return new Promise<DirectorResult<unknown>>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(callId);
				reject(
					new BridgeError(
						"timeout",
						`The editor tab did not answer "${input.tool}" within ${Math.round(
							input.timeoutMs / 1000,
						)}s. The tab may be backgrounded or busy.`,
					),
				);
			}, input.timeoutMs);
			timer.unref?.();

			this.pending.set(callId, {
				callId,
				projectId: input.projectId,
				tabId: tab.tabId,
				tabUserId: tab.userId,
				resolve,
				reject,
				timer,
			});

			const payload: BridgeToolCall = {
				callId,
				tool: input.tool,
				args: input.args,
			};
			try {
				tab.send(BRIDGE_TOOL_CALL_EVENT, JSON.stringify(payload));
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(callId);
				reject(
					new BridgeError(
						"tab-disconnected",
						`Failed to reach the editor tab: ${
							error instanceof Error ? error.message : String(error)
						}`,
					),
				);
			}
		});
	}

	/**
	 * Back-channel: the tab answered a relayed call. Ownership is enforced —
	 * the answer must come from the same authenticated user (and project) the
	 * call was sent to; the tab itself never learns its server-side tabId.
	 * Returns false for unknown/expired/foreign callIds.
	 */
	resolveCall(input: {
		callId: string;
		projectId: string;
		userId: string;
		result?: DirectorResult<unknown>;
		error?: string;
	}): boolean {
		const call = this.pending.get(input.callId);
		if (!call) return false;
		if (call.projectId !== input.projectId) return false;
		if (
			call.tabUserId !== DEV_WILDCARD_USER &&
			call.tabUserId !== input.userId
		) {
			return false;
		}
		this.pending.delete(input.callId);
		clearTimeout(call.timer);
		if (input.result) {
			call.resolve(input.result);
		} else {
			// Handler threw in the tab — surface as a failed DirectorResult so the
			// MCP layer reports it in the standard { ok:false, message } envelope.
			call.resolve({
				ok: false,
				message: input.error ?? "The editor tab reported an unknown error.",
			});
		}
		return true;
	}

	/** Fail every in-flight call that was sent to a now-gone tab. */
	private failCallsForTab(
		tabId: string,
		code: BridgeErrorCode,
		message: string,
	): void {
		for (const [callId, call] of this.pending) {
			if (call.tabId !== tabId) continue;
			this.pending.delete(callId);
			clearTimeout(call.timer);
			call.reject(new BridgeError(code, message));
		}
	}
}

/**
 * Process-wide singleton, cached on `globalThis` so Next.js dev HMR (which
 * re-evaluates modules) doesn't orphan the registry mid-session.
 */
const globalStore = globalThis as unknown as {
	__byornEditorBridge?: EditorBridge;
};

export function getEditorBridge(): EditorBridge {
	globalStore.__byornEditorBridge ??= new EditorBridge();
	return globalStore.__byornEditorBridge;
}

/**
 * The Director agent loop — turns a natural-language chat turn into a sequence
 * of `director-api` verb calls.
 *
 * ARCHITECTURE — client loop, server relay:
 * The Director's tools mutate CLIENT-SIDE editor state (Zustand stores, the
 * timeline) through `DirectorApi`, so the agentic loop and all tool execution
 * MUST run in the browser. The Anthropic API key, however, must stay
 * server-side. The split:
 *
 *   browser (this file)                      server
 *   ┌─────────────────────────────┐          ┌────────────────────────────┐
 *   │ runDirectorAgent            │  POST    │ /api/llm/agent (route.ts)  │
 *   │  · messages[] history       │ ───────► │  · pure stateless relay    │
 *   │  · native tool-use loop     │ ◄─────── │  · one messages.create per │
 *   │  · executes tool_use blocks │  JSON    │    call, key from env      │
 *   │    against DirectorApi      │          │  · runs NO loop, NO tools  │
 *   └─────────────────────────────┘          └────────────────────────────┘
 *
 * Two brains behind one seam:
 *  - FRONTIER (default): Claude with NATIVE tool-calling via the relay above.
 *    Multiple tool_use blocks per assistant turn are executed and answered
 *    with tool_result blocks in a single user message; the loop runs until
 *    `stop_reason === "end_turn"` (or a hard ceiling).
 *  - LOCAL (privacy mode / fallback): the original plain-text ReAct loop over
 *    the Ollama backend (`aiClient.chat` injected as `AgentChatFn`), one JSON
 *    action per turn. Kept intact as `runDirectorAgentLocal`; `runDirectorAgent`
 *    falls back to it automatically when the relay reports no ANTHROPIC_API_KEY
 *    (or when the caller passes `brain: "local"`).
 *
 * Both brains drive the SAME verb registry ({@link TOOLS}) and the
 * SAME `DirectorApi`, expand SHORT ids at the same choke point
 * ({@link expandIdArgs}), and feed the Sprint-0 mutation-`delta` back as the
 * observation, so behavior differs only in transport quality.
 *
 * No React, no provider wiring here: it depends only on an injected `chat`
 * function (local brain), `fetch` to the relay (frontier brain), and a
 * `DirectorApi`. Generation actually runs because the injected DirectorApi
 * already carries the studio executor (see `use-director`).
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { DirectorApi } from "./director-api";
import { PLAYBOOKS } from "@/lib/studio/playbooks";
import { createShortIdMap, type ShortIdMap } from "./short-id";
import {
	needsApproval,
	formatCostRange,
	DEFAULT_APPROVAL_THRESHOLD_USD,
	type CostRange,
} from "@/lib/studio/cost";
import { useStudioSettingsStore } from "@/stores/studio-settings-store";
import {
	toolCatalog,
	str,
	numOr,
	type JSONSchema,
	type ToolHandler,
} from "./tool-catalog";

/** Single-shot, non-streaming chat call: (message, system) → assistant text. Local (Ollama) transport. */
export type AgentChatFn = (message: string, system: string) => Promise<string>;

export interface AgentToolStep {
	action: string;
	args: Record<string, unknown>;
	ok: boolean;
	message: string;
}

/**
 * A gated action the agent proposed but did NOT run — it hit the cost-preview
 * approval gate and ended its turn instead of spending (fail-closed). The UI
 * surfaces the cost and, on the user's explicit approval, runs this exact action
 * via {@link executeDirectorAction}. `args` are the raw (short-id) args the model
 * emitted, ready to feed straight back through the tool layer.
 */
export interface AgentApproval {
	action: string;
	args: Record<string, unknown>;
	estimate: CostRange;
	/** Number of takes the proposed action would render. */
	clips: number;
}

export interface AgentRunResult {
	finalMessage: string;
	steps: AgentToolStep[];
	/**
	 * Set when the run paused on a gated verb awaiting the user's approval.
	 * Present ⇒ nothing was spent; the proposed action is in `awaitingApproval`.
	 */
	awaitingApproval?: AgentApproval;
	/**
	 * Set when the run stopped early because the caller aborted it (cooperative
	 * cancel). Completed tool steps are already applied to the editor — the reel
	 * keeps whatever finished — the loop simply stopped requesting more work.
	 */
	cancelled?: boolean;
}

/**
 * Live events streamed out of a Director run so the panel can render the agent's
 * reasoning and per-tool progress AS IT HAPPENS instead of after the fact:
 *  - `text_delta` / `thinking_delta`: incremental model output (frontier brain,
 *    via the SSE relay). Concatenate a run of same-type events into one bubble.
 *  - `tool_start`: a tool is about to run; `cost` is present for gated verbs
 *    (generate/reroll) so the estimate shows BEFORE any spend.
 *  - `tool_finish`: the tool's result (mirrors {@link AgentToolStep}).
 *  - `awaiting_approval`: a gated verb crossed the threshold and the run paused.
 *  - `cancelled`: the run was aborted; nothing more will run.
 * `callId` correlates a `tool_start` with its `tool_finish` (tools run
 * sequentially, so the pairing is 1:1 and in order).
 */
export type DirectorEvent =
	| { type: "text_delta"; text: string }
	| { type: "thinking_delta"; text: string }
	| {
			type: "tool_start";
			callId: string;
			action: string;
			args: Record<string, unknown>;
			cost?: CostRange & { clips: number };
	  }
	| { type: "tool_finish"; callId: string; step: AgentToolStep }
	| { type: "awaiting_approval"; approval: AgentApproval }
	| { type: "cancelled" };

/** Sink the loops emit {@link DirectorEvent}s into (the panel's consumer). */
export type DirectorEventSink = (event: DirectorEvent) => void;

/** Thrown internally when the caller's AbortSignal fires; caught and turned into a cancelled result. */
class DirectorAbortError extends Error {
	constructor() {
		super("Director run aborted by caller.");
		this.name = "DirectorAbortError";
	}
}

/** True when the caller's cancel has fired (signal aborted, or a fetch AbortError bubbled up). */
function isAbort(signal: AbortSignal | undefined, err?: unknown): boolean {
	if (signal?.aborted) return true;
	return (
		err instanceof DirectorAbortError ||
		(err instanceof Error && err.name === "AbortError")
	);
}

interface DirectorResultLike {
	ok: boolean;
	message: string;
	data?: unknown;
}

/** Hard ceiling on tool calls per user turn for the LOCAL text loop. */
const MAX_STEPS = 6;

/**
 * Frontier ceilings. Native tool-calling is far more reliable than the
 * one-JSON-per-turn local loop, so the budget is higher — but still hard-capped
 * to bound a runaway model. When {@link MAX_TOOL_CALLS} is reached the loop
 * forces a final text summary via `tool_choice: {type: "none"}`.
 */
const MAX_TOOL_CALLS = 24;
/** Bound on model round-trips (also covers pause_turn re-sends). */
const MAX_MODEL_CALLS = 30;

/** The browser-side endpoint of the stateless server relay. */
const AGENT_RELAY_URL = "/api/llm/agent";

// ── tool registry + docs (built from the shared catalog) ─────────────────────
//
// The executor registry and the agent-facing docs string are BOTH derived from
// `toolCatalog()` — the SAME catalog the future MCP server consumes — so there
// is a single source of truth for verbs, arg shapes, arg-coercion, and the
// SECONDS convention. (The arg-coercion helpers that used to live here now live
// in `tool-catalog.ts`, alongside the handlers that use them.)

/** The verb registry the agent may call — every catalog handler, keyed by name. */
const TOOLS: Record<string, ToolHandler> = Object.fromEntries(
	toolCatalog().map((t) => [t.name, t.handler]),
);

/** Render one arg's type for the docs string (SECONDS fields show as `seconds`). */
function argType(node: JSONSchema): string {
	if (node.enum) return node.enum.map((e) => JSON.stringify(e)).join("|");
	if (node["x-seconds"]) return "seconds";
	if (node.oneOf) return node.oneOf.map(argType).join(" | ");
	if (node.type === "array")
		return `[${node.items ? argType(node.items) : "any"}, ...]`;
	if (node.type === "object" && node.properties) {
		return `{ ${Object.entries(node.properties)
			.map(([k, v]) => `"${k}": ${argType(v)}`)
			.join(", ")} }`;
	}
	return node.type ?? "any";
}

/** Render a verb's args object for the docs string; optional keys get a `?`. */
function renderArgs(schema: JSONSchema): string {
	const props = schema.properties;
	if (!props || Object.keys(props).length === 0) return "{}";
	const required = new Set(schema.required ?? []);
	const parts = Object.entries(props).map(
		([k, v]) => `"${k}"${required.has(k) ? "" : "?"}: ${argType(v)}`,
	);
	return `{ ${parts.join(", ")} }`;
}

/** Agent-facing tool docs, one line per verb, built from `toolCatalog()`. */
const TOOL_DOCS = [
	"Tools (call ONE per turn):",
	...toolCatalog().map(
		(t) => `- ${t.name} — ${t.description} args: ${renderArgs(t.inputSchema)}`,
	),
].join("\n");

/**
 * Native Anthropic tool definitions derived from the shared `toolCatalog()`.
 * `strict` is intentionally NOT set: several verbs carry optional fields and
 * open-ended param bags that would 400 under Anthropic strict mode, and every
 * catalog handler already coerces its inputs.
 */
function anthropicToolDefs(): Anthropic.Tool[] {
	return toolCatalog().map((t) => ({
		name: t.name,
		description: t.description,
		input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
	}));
}

/** Concise pointer to the UGC prompt playbooks — titles/descriptions only, not the full content. */
const PLAYBOOK_POINTER = Object.values(PLAYBOOKS)
	.map((p) => `- ${p.title}: ${p.description}`)
	.join("\n");

// ── short ids ────────────────────────────────────────────────────────────────

/**
 * Short-id map over the current reel's slot + take ids. Rebuilt each turn (ids
 * are stable, but a prefix may need to lengthen as slots come and go). This is
 * the SINGLE expansion choke point: the agent speaks short ids to the model and
 * expands them back to full ids here, at the args→DirectorApi boundary, keeping
 * `DirectorApi` itself full-id and unaware of the abbreviation scheme.
 */
function reelShortIdMap(director: DirectorApi): ShortIdMap {
	const ids: string[] = [];
	for (const s of director.getReel().slots) {
		ids.push(s.id);
		for (const t of s.takes) ids.push(t.id);
	}
	return createShortIdMap(ids);
}

/**
 * Id-bearing arg fields the model may send as SHORT ids.
 *
 * Deliberately EXCLUDES id-shaped fields introduced alongside trim/move/
 * split/addText/updateText/addClip:
 *  - `targetTrackId` (move), `trackId` (addClip/addText) — TRACK ids.
 *    `reelShortIdMap` only indexes slot and take ids, so a track id was never
 *    part of the short-id universe; routing it through `expand` would throw
 *    "unknown id". Callers must pass the full track id (or omit it).
 *  - `elementId` (updateText) — a text-overlay element id. Text elements
 *    aren't generative slots (see `director-api.ts`'s "TEXT" section), so
 *    they never appear in `reelShortIdMap` either; `addText` returns (and
 *    `updateText` expects) the FULL id, never shortened.
 *  - `mediaId` (addClip) — a media-library asset id from `searchMedia`. Media
 *    assets are a separate id space entirely (not timeline elements at all
 *    until placed), so they're never in `reelShortIdMap`; always the FULL id.
 */
const ID_ARG_FIELDS = ["slotId", "takeId"] as const;

/**
 * Expand any short ids the model passed back into full ids. Non-id args pass
 * through untouched; `"all"` (not an array) is left alone. Throws (ambiguous /
 * unknown id) — the caller surfaces that as a failed step.
 */
function expandIdArgs(
	args: Record<string, unknown>,
	map: ShortIdMap,
): Record<string, unknown> {
	const out = { ...args };
	for (const field of ID_ARG_FIELDS) {
		const v = out[field];
		if (typeof v === "string" && v) out[field] = map.expand(v);
	}
	if (Array.isArray(out.slotIds)) {
		out.slotIds = out.slotIds.map((v) =>
			typeof v === "string" && v ? map.expand(v) : v,
		);
	}
	return out;
}

/**
 * Compact PROJECT/PERSONAS/MEDIA grounding block, built from
 * `DirectorApi.getProjectInfo` — cheap enough to rebuild every turn and small
 * enough to ride in the once-per-turn system prompt (summarized, not dumped:
 * personas and recent assets are pre-capped by `getProjectInfo`).
 */
function buildContextBlock(director: DirectorApi): string {
	const info = director.getProjectInfo().data;
	if (!info) return "";

	const lines: string[] = [
		info.fps != null && info.canvasWidth != null && info.canvasHeight != null
			? `PROJECT: ${info.canvasWidth}x${info.canvasHeight} (${info.orientation}), ${info.fps}fps.`
			: "PROJECT: no active project.",
	];

	if (info.personaCount > 0) {
		const names = info.personas
			.map((p) => `${p.name} (${p.descriptor})`)
			.join(", ");
		const more = info.personaCount > info.personas.length ? ", ..." : "";
		lines.push(`PERSONAS (${info.personaCount}): ${names}${more}.`);
	} else {
		lines.push("PERSONAS: none created yet.");
	}

	const recent = info.recentAssets.length
		? ` Recent: ${info.recentAssets.map((a) => a.name).join(", ")}.`
		: "";
	lines.push(
		`MEDIA LIBRARY: ${info.assetCount} asset(s) indexed. searchMedia finds footage semantically; addClip places a hit on the timeline.${recent}`,
	);

	return lines.join("\n");
}

/** Compact, current reel state for the model to target slots by id (SHORT ids). */
function reelSummary(director: DirectorApi): string {
	const reel = director.getReel();
	if (reel.slots.length === 0) return "REEL: empty (no slots yet).";
	const map = reelShortIdMap(director);
	const lines = reel.slots.map(
		(s, i) =>
			`  #${i + 1} id=${map.shorten(s.id)} status=${s.status} takes=${s.takeCount} prompt=${JSON.stringify(
				s.prompt,
			)}`,
	);
	return `REEL (${reel.slots.length} slots, ${reel.totalDuration.toFixed(1)}s):\n${lines.join("\n")}`;
}

// ── shared tool execution ────────────────────────────────────────────────────

/**
 * Execute one named tool call against the DirectorApi: expand short ids at the
 * single choke point, run the registry executor, and build the compact
 * observation the model sees. Shared by both brains so the observation
 * language (short ids, `CHANGES:` deltas) is identical.
 */
async function executeTool(
	director: DirectorApi,
	action: string,
	rawArgs: Record<string, unknown>,
): Promise<{ step: AgentToolStep; observation: string }> {
	const tool = TOOLS[action];
	if (!tool) {
		const message = `Unknown action "${action}". Valid tools: ${Object.keys(TOOLS).join(", ")}.`;
		return {
			step: { action, args: rawArgs, ok: false, message },
			observation: message,
		};
	}

	// Ambiguous/unknown ids surface as a failed step (message from the thrown
	// error) rather than crashing the loop.
	let result: DirectorResultLike;
	try {
		const args = expandIdArgs(rawArgs, reelShortIdMap(director));
		result = await tool(director, args);
	} catch (err) {
		result = {
			ok: false,
			message: err instanceof Error ? err.message : String(err),
		};
	}

	const step: AgentToolStep = {
		action,
		args: rawArgs,
		ok: result.ok,
		message: result.message,
	};

	// Feed the compact delta (short ids) back as the observation for mutating
	// verbs; getReel echoes the short-id reel listing; read-only verbs with a
	// payload (getSlot/searchMedia/getConsistencyContext) include their data;
	// everything else falls back to the plain message.
	const delta = (result as { delta?: unknown }).delta;
	let observation: string;
	if (action === "getReel") {
		observation = reelSummary(director);
	} else if (delta) {
		observation = `${result.message} CHANGES:${JSON.stringify(delta)}`;
	} else if (
		result.ok &&
		result.data !== undefined &&
		(action === "getSlot" ||
			action === "searchMedia" ||
			action === "getConsistencyContext" ||
			action === "getProjectInfo")
	) {
		observation = `${result.message} DATA:${JSON.stringify(result.data)}`;
	} else {
		observation = result.message;
	}
	return { step, observation };
}

// ── cost-preview approval gate (concept: cost-preview gate) ──────────────────
//
// Verbs that spend real generation credits carry an implicit `requiresApproval`
// flag. Before EITHER brain runs one, we estimate its cost; if it crosses the
// user's threshold the loop ENDS ITS TURN with an `awaitingApproval` result
// instead of spending. The human approves (or not) out-of-band and the UI then
// runs the exact proposed action via `executeDirectorAction`. Fail-closed: the
// agent cannot talk itself past the gate within a turn — the loop returns.

/** Verbs gated behind the approval gate — they render takes and cost money. */
const REQUIRES_APPROVAL = new Set(["generate", "reroll"]);

/** The user-configured USD threshold, read live from the studio settings store. */
function approvalThreshold(): number {
	return (
		useStudioSettingsStore.getState().approvalThresholdUsd ??
		DEFAULT_APPROVAL_THRESHOLD_USD
	);
}

/**
 * Estimate the cost of a gated action from its (already id-expanded) args, or
 * `null` if the action isn't cost-bearing. Mirrors how the matching registry
 * entry resolves its targets so the preview matches what would actually run.
 */
function estimateActionCost(
	director: DirectorApi,
	action: string,
	args: Record<string, unknown>,
): (CostRange & { clips: number }) | null {
	if (action === "generate") {
		return (
			director.estimateGenerateCost({
				slotIds: Array.isArray(args.slotIds) ? args.slotIds.map(str) : "all",
				alternatives: numOr(args.alternatives, 1),
			}).data ?? null
		);
	}
	if (action === "reroll") {
		return (
			director.estimateGenerateCost({
				slotIds: [str(args.slotId)],
				alternatives: numOr(args.alternatives, 1),
			}).data ?? null
		);
	}
	return null;
}

/**
 * Cost estimate for a gated verb, for the `tool_start` preview — shown BEFORE
 * the action runs. Returns `undefined` for non-gated verbs or when the estimate
 * can't be formed (e.g. short-id expansion fails); the loop still runs the step.
 * This is display-only: the fail-closed gate in {@link evaluateApprovalGate} is
 * what actually pauses over-threshold spend.
 */
function previewToolCost(
	director: DirectorApi,
	action: string,
	rawArgs: Record<string, unknown>,
): (CostRange & { clips: number }) | undefined {
	if (!REQUIRES_APPROVAL.has(action)) return undefined;
	let expanded: Record<string, unknown>;
	try {
		expanded = expandIdArgs(rawArgs, reelShortIdMap(director));
	} catch {
		return undefined;
	}
	const est = estimateActionCost(director, action, expanded);
	return est && est.clips > 0 ? est : undefined;
}

/** Human-facing copy for a paused, awaiting-approval action. */
function approvalMessage(a: AgentApproval): string {
	return (
		`This will generate ${a.clips} clip(s) at an estimated ` +
		`${formatCostRange(a.estimate)}. Approve to run it — nothing has been ` +
		`generated yet.`
	);
}

/**
 * Evaluate the approval gate for a single proposed tool call BEFORE it runs.
 * Returns an {@link AgentApproval} (carrying the RAW short-id args, ready to feed
 * back through {@link executeDirectorAction}) when the action is gated AND its
 * estimate crosses the threshold; otherwise `null` (run it normally). Id
 * expansion failures aren't gated here — they surface as a failed step when the
 * action actually executes.
 */
function evaluateApprovalGate(
	director: DirectorApi,
	action: string,
	rawArgs: Record<string, unknown>,
): AgentApproval | null {
	if (!REQUIRES_APPROVAL.has(action)) return null;
	let expanded: Record<string, unknown>;
	try {
		expanded = expandIdArgs(rawArgs, reelShortIdMap(director));
	} catch {
		return null;
	}
	const est = estimateActionCost(director, action, expanded);
	if (est && est.clips > 0 && needsApproval(est, approvalThreshold())) {
		return {
			action,
			args: rawArgs,
			estimate: { low: est.low, high: est.high },
			clips: est.clips,
		};
	}
	return null;
}

/**
 * Run a single director verb through the same coercion + short-id expansion the
 * agent loop uses. Exposed so the UI can execute an approved {@link AgentApproval}
 * deterministically (bypassing the LLM) once the user confirms the cost. Reuses
 * {@link executeTool}, so unknown actions and id-expansion errors surface as a
 * failed {@link AgentToolStep} rather than throwing.
 */
export async function executeDirectorAction(
	director: DirectorApi,
	action: string,
	args: Record<string, unknown>,
): Promise<AgentToolStep> {
	const { step } = await executeTool(director, action, args);
	return step;
}

// ── frontier brain (Claude native tool-calling via the server relay) ─────────

/** Thrown when the relay reports that ANTHROPIC_API_KEY is not configured — the signal to fall back to local mode. */
export class AnthropicKeyMissingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AnthropicKeyMissingError";
	}
}

/** The assistant-message slice the relay returns from one `messages.create` call. */
interface AgentModelTurn {
	content: Anthropic.ContentBlock[];
	stop_reason: Anthropic.StopReason | null;
	model: string;
	usage?: unknown;
}

/** Live-delta callback: fires per text/thinking chunk while a turn streams. */
type RelayDeltaFn = (kind: "text" | "thinking", text: string) => void;

/**
 * One model round-trip through the stateless server relay. The relay holds the
 * API key and forwards exactly one model turn — no loop, no tools run
 * server-side.
 *
 * Transport is SSE (`stream: true`): text/thinking deltas fire `onDelta` live so
 * the panel renders reasoning as it's produced, and a single `final` event
 * carries the complete assistant turn (same `{content, stop_reason, ...}` shape
 * the JSON path returned), so the loop's block/tool handling is unchanged. The
 * no-key 503 and other pre-stream failures still come back as JSON and are
 * detected the same way. `signal` aborts the in-flight request.
 */
async function callAgentRelay(request: {
	messages: Anthropic.MessageParam[];
	system: string;
	tools: Anthropic.Tool[];
	tool_choice?: Anthropic.ToolChoice;
	signal?: AbortSignal;
	onDelta?: RelayDeltaFn;
}): Promise<AgentModelTurn> {
	const { signal, onDelta, ...payload } = request;
	const res = await fetch(AGENT_RELAY_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "text/event-stream",
		},
		body: JSON.stringify({ ...payload, stream: true }),
		signal,
	});

	// Non-OK (or a non-stream JSON body, e.g. the no-key 503) → parse as JSON and
	// surface the same errors the JSON path did.
	const contentType = res.headers.get("content-type") ?? "";
	if (!res.ok || !contentType.includes("text/event-stream")) {
		const body = (await res.json().catch(() => null)) as
			| (Partial<AgentModelTurn> & { error?: string; message?: string })
			| null;
		if (!res.ok) {
			if (body?.error === "anthropic_not_configured") {
				throw new AnthropicKeyMissingError(
					body.message ?? "ANTHROPIC_API_KEY is not configured on the server.",
				);
			}
			throw new Error(
				`Claude relay error (${res.status}): ${body?.message ?? body?.error ?? "unknown error"}`,
			);
		}
		if (!body || !Array.isArray(body.content)) {
			throw new Error("Claude relay error: malformed response (no content).");
		}
		return body as AgentModelTurn;
	}

	return await consumeAgentStream(res, onDelta);
}

/**
 * Parse the relay's SSE body: forward `delta` events to `onDelta` and return the
 * turn carried by the `final` event. An `error` event (a failure after headers
 * flushed) is re-thrown so the loop's catch handles it like any relay error.
 */
async function consumeAgentStream(
	res: Response,
	onDelta?: RelayDeltaFn,
): Promise<AgentModelTurn> {
	if (!res.body) throw new Error("Claude relay error: empty stream body.");
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let final: AgentModelTurn | null = null;

	// SSE frames are separated by a blank line; each frame is `event: <name>`
	// followed by one `data: <json>` line.
	const handleFrame = (frame: string) => {
		let event = "message";
		let data = "";
		for (const line of frame.split("\n")) {
			if (line.startsWith("event:")) event = line.slice(6).trim();
			else if (line.startsWith("data:")) data += line.slice(5).trim();
		}
		if (!data) return;
		const parsed = JSON.parse(data) as Record<string, unknown>;
		if (event === "delta") {
			onDelta?.(
				parsed.kind === "thinking" ? "thinking" : "text",
				String(parsed.text ?? ""),
			);
		} else if (event === "final") {
			final = parsed as unknown as AgentModelTurn;
		} else if (event === "error") {
			throw new Error(
				`Claude relay error: ${String(parsed.message ?? parsed.error ?? "stream error")}`,
			);
		}
	};

	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let sep: number;
		while ((sep = buffer.indexOf("\n\n")) !== -1) {
			const frame = buffer.slice(0, sep);
			buffer = buffer.slice(sep + 2);
			if (frame.trim()) handleFrame(frame);
		}
	}
	if (buffer.trim()) handleFrame(buffer);

	if (!final || !Array.isArray((final as AgentModelTurn).content)) {
		throw new Error("Claude relay error: stream ended without a final turn.");
	}
	return final;
}

/** Join a turn's text blocks into the user-facing message. */
function textOf(content: Anthropic.ContentBlock[]): string {
	return content
		.filter((b): b is Anthropic.TextBlock => b.type === "text")
		.map((b) => b.text)
		.join("\n")
		.trim();
}

/**
 * System prompt for the frontier brain. Built ONCE per user turn (not per
 * model call) so the prefix stays byte-stable across the loop for prompt
 * caching; the reel listing inside it is therefore a snapshot — live state
 * flows through tool-result deltas and `getReel`.
 */
function buildFrontierSystemPrompt(director: DirectorApi): string {
	return [
		"You are the Director — an AI that builds and edits a short video reel by calling tools.",
		"A reel is an ordered list of generative SLOTS; each slot holds a prompt and one or more generated TAKES.",
		"",
		"UNITS: all durations and times are in SECONDS unless a field name ends in `Frames`.",
		"IDS: every id shown to you (in the REEL below and in tool-result CHANGES reports) is a SHORT id. Pass short ids back verbatim in tool args — do not lengthen or invent them. Exceptions (always FULL ids, never shortened): `targetTrackId` (a track id), `elementId` (a text-overlay id from addText), and mediaIds from searchMedia.",
		"",
		"Use tools ONLY when the user wants to build or change the reel. For questions, ideas, scripts, or advice, reply with plain text and no tool calls.",
		"You may request several independent tool calls in one turn; dependent steps (e.g. storyboard, then generate the new slots) belong in separate turns so you can read the ids from the results. Each tool result is a compact observation — mutating verbs report a CHANGES diff in short ids. The REEL listing below is a snapshot from the start of this turn; call getReel when you need a fresh view.",
		"Think through multi-step edits as much as needed, then act decisively. When the task is done, reply with a short plain-text summary of what you did.",
		"COST GATE: a generate/reroll that would spend more than a small amount pauses for the user's approval — the run stops and asks them out-of-band. This is expected, not an error; do NOT retry the same action to force it through.",
		"",
		'If the user wants UGC/influencer-style, "looks like a real phone photo" imagery or video, follow these playbook conventions when writing prompts:',
		PLAYBOOK_POINTER,
		"",
		buildContextBlock(director),
		"",
		reelSummary(director),
	].join("\n");
}

/**
 * The frontier agent loop: browser-held `messages` history, one relay call per
 * model turn, ALL tool_use blocks of a turn executed here and answered with
 * tool_result blocks in ONE user message, until `end_turn` or a ceiling.
 */
async function runDirectorAgentFrontier(opts: {
	director: DirectorApi;
	userMessage: string;
	onStep?: (step: AgentToolStep) => void;
	onEvent?: DirectorEventSink;
	signal?: AbortSignal;
}): Promise<AgentRunResult> {
	const { director, userMessage, onStep, onEvent, signal } = opts;
	const steps: AgentToolStep[] = [];
	const system = buildFrontierSystemPrompt(director);
	const tools = anthropicToolDefs();
	const messages: Anthropic.MessageParam[] = [
		{ role: "user", content: userMessage },
	];

	let toolCalls = 0;
	let wrapUp = false; // set when the tool budget is spent → force a text-only close
	let lastText = "";
	let callCounter = 0; // seeds tool_start/tool_finish callIds

	// Cooperative cancel: the loop checks the signal between model/tool calls. A
	// completed run's tool steps have already mutated the editor, so returning
	// early keeps that work — we just stop asking the model for more.
	const cancelledResult = (): AgentRunResult => {
		onEvent?.({ type: "cancelled" });
		return {
			finalMessage:
				lastText ||
				(steps.length
					? `Stopped — ${steps.length} step(s) completed before you cancelled.`
					: "Stopped."),
			steps,
			cancelled: true,
		};
	};

	for (let call = 0; call < MAX_MODEL_CALLS; call++) {
		if (isAbort(signal)) return cancelledResult();

		let turn: AgentModelTurn;
		try {
			turn = await callAgentRelay({
				messages,
				system,
				tools,
				signal,
				onDelta: (kind, text) =>
					onEvent?.(
						kind === "thinking"
							? { type: "thinking_delta", text }
							: { type: "text_delta", text },
					),
				...(wrapUp
					? { tool_choice: { type: "none" } as Anthropic.ToolChoice }
					: {}),
			});
		} catch (err) {
			// A mid-flight abort surfaces as a fetch AbortError — treat it as a
			// clean cancel that preserves completed steps, not a hard failure.
			if (isAbort(signal, err)) return cancelledResult();
			throw err;
		}

		// Check stop_reason BEFORE reading content: a refusal can carry an empty
		// content array.
		if (turn.stop_reason === "refusal") {
			return {
				finalMessage:
					"The model declined this request. Try rephrasing what you want the Director to do.",
				steps,
			};
		}

		// Append the assistant turn verbatim (including thinking blocks — they
		// must be echoed back unchanged on subsequent calls).
		messages.push({ role: "assistant", content: turn.content });
		lastText = textOf(turn.content) || lastText;

		// pause_turn: the server-side turn was interrupted — re-send as-is to
		// let it resume (no user message in between).
		if (turn.stop_reason === "pause_turn") continue;

		const toolUses = turn.content.filter(
			(b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
		);
		if (toolUses.length === 0) {
			// end_turn (or max_tokens) with no tool calls — we're done.
			return { finalMessage: textOf(turn.content), steps };
		}

		// Execute EVERY tool_use block in this assistant message, then return
		// ALL results in ONE user message. `input` is already a structured
		// object — never string-parse it.
		const resultBlocks: Anthropic.ContentBlockParam[] = [];
		for (const use of toolUses) {
			if (isAbort(signal)) return cancelledResult();
			const rawArgs = (use.input ?? {}) as Record<string, unknown>;

			// Cost-preview approval gate: a gated verb whose estimate crosses the
			// threshold ENDS THE TURN here (fail-closed) BEFORE it spends. The user
			// approves out-of-band; the UI then runs the exact proposed action via
			// `executeDirectorAction`. Checked per-block right before execution, so
			// nothing gated ever runs without approval.
			const approval = evaluateApprovalGate(director, use.name, rawArgs);
			if (approval) {
				const message = approvalMessage(approval);
				const step: AgentToolStep = {
					action: approval.action,
					args: approval.args,
					ok: false,
					message: `⏸ Awaiting approval — ${message}`,
				};
				steps.push(step);
				onStep?.(step);
				onEvent?.({ type: "awaiting_approval", approval });
				return { finalMessage: message, steps, awaitingApproval: approval };
			}

			// Announce the step BEFORE it runs so the panel shows it live — with the
			// cost estimate for gated (under-threshold) verbs, so spend is visible
			// before it happens.
			const callId = `c${callCounter++}`;
			onEvent?.({
				type: "tool_start",
				callId,
				action: use.name,
				args: rawArgs,
				cost: previewToolCost(director, use.name, rawArgs),
			});

			const { step, observation } = await executeTool(
				director,
				use.name,
				rawArgs,
			);
			steps.push(step);
			onStep?.(step);
			onEvent?.({ type: "tool_finish", callId, step });
			toolCalls++;
			resultBlocks.push({
				type: "tool_result",
				tool_use_id: use.id,
				content: observation,
				...(step.ok ? {} : { is_error: true }),
			});
		}

		if (toolCalls >= MAX_TOOL_CALLS && !wrapUp) {
			// Ceiling hit: deliver the results, then ask for a final text summary
			// (the next call carries tool_choice: none so the model must close).
			wrapUp = true;
			resultBlocks.push({
				type: "text",
				text: "You have used the tool budget for this turn. Reply with a final plain-text summary of what you did and what (if anything) is left.",
			});
		}
		messages.push({ role: "user", content: resultBlocks });
	}

	// Model-call ceiling hit without a clean close — surface the best text we saw.
	return {
		finalMessage:
			lastText ||
			`Stopped after ${MAX_MODEL_CALLS} model turns (${steps.length} tool call(s) executed).`,
		steps,
	};
}

// ── local brain (plain-text ReAct over Ollama — privacy mode / fallback) ─────

function buildLocalSystemPrompt(director: DirectorApi): string {
	return [
		"You are the Director — an AI that builds and edits a short video reel by calling tools.",
		"A reel is an ordered list of generative SLOTS; each slot holds a prompt and one or more generated TAKES.",
		"",
		"UNITS: all durations and times are in SECONDS unless a field name ends in `Frames`.",
		"IDS: every id shown to you (in the REEL below and in change reports) is a SHORT id. Pass short ids back verbatim in tool args — do not lengthen or invent them.",
		"",
		TOOL_DOCS,
		"",
		'If the user wants UGC/influencer-style, "looks like a real phone photo" imagery or video, follow these playbook conventions when writing prompts:',
		PLAYBOOK_POINTER,
		"",
		"PROTOCOL — reply with a SINGLE minified JSON object and NOTHING else:",
		'  to act:   {"action":"<tool>","args":{...}}',
		'  to reply: {"final":"<message to the user>"}',
		"Use actions ONLY when the user wants to build or change the reel. For questions, ideas, scripts, or advice, answer with a final message.",
		"After each action you receive an OBSERVATION. When the task is done, send a final message summarizing what you did.",
		"COST GATE: a generate/reroll that would spend more than a small amount pauses for the user's approval — the run stops and asks them. This is expected, not an error; never retry the same action to force it through.",
		"",
		buildContextBlock(director),
		"",
		reelSummary(director),
	].join("\n");
}

interface ParsedAction {
	kind: "action";
	action: string;
	args: Record<string, unknown>;
}
interface ParsedFinal {
	kind: "final";
	text: string;
}

/** Extract the first balanced top-level JSON object from arbitrary text. */
function firstJsonObject(text: string): string | null {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const haystack = fenced ? fenced[1] : text;
	const start = haystack.indexOf("{");
	if (start === -1) return null;
	let depth = 0;
	let inStr = false;
	let esc = false;
	for (let i = start; i < haystack.length; i++) {
		const ch = haystack[i];
		if (inStr) {
			if (esc) esc = false;
			else if (ch === "\\") esc = true;
			else if (ch === '"') inStr = false;
		} else if (ch === '"') inStr = true;
		else if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return haystack.slice(start, i + 1);
		}
	}
	return null;
}

/**
 * Parse the local model's reply. Lenient: prose with no JSON is treated as a
 * final answer (graceful fallback for weak local models).
 */
function parseReply(text: string): ParsedAction | ParsedFinal {
	const json = firstJsonObject(text);
	if (json) {
		try {
			const obj = JSON.parse(json) as Record<string, unknown>;
			if (typeof obj.final === "string")
				return { kind: "final", text: obj.final };
			if (typeof obj.action === "string") {
				const args =
					obj.args && typeof obj.args === "object"
						? (obj.args as Record<string, unknown>)
						: {};
				return { kind: "action", action: obj.action, args };
			}
		} catch {
			/* fall through to prose */
		}
	}
	return { kind: "final", text: text.trim() };
}

/**
 * PRIVACY MODE / FALLBACK: the original plain-text ReAct loop over the local
 * Ollama backend. One JSON action per turn, whole system prompt + scratchpad
 * re-sent each step, capped at {@link MAX_STEPS}. Kept as a first-class export
 * so callers can force local inference; `runDirectorAgent` also routes here
 * automatically when the frontier relay reports no API key.
 */
export async function runDirectorAgentLocal(opts: {
	director: DirectorApi;
	chat: AgentChatFn;
	userMessage: string;
	onStep?: (step: AgentToolStep) => void;
	onEvent?: DirectorEventSink;
	signal?: AbortSignal;
}): Promise<AgentRunResult> {
	const { director, chat, userMessage, onStep, onEvent, signal } = opts;
	const steps: AgentToolStep[] = [];
	let scratchpad = `USER: ${userMessage}\n`;
	let callCounter = 0;

	// The local backend's chat call isn't itself abortable (AgentChatFn takes no
	// signal), so cancel is cooperative: we check between steps. Completed steps
	// have already mutated the reel, so an early return preserves them.
	const cancelledResult = (): AgentRunResult => {
		onEvent?.({ type: "cancelled" });
		return {
			finalMessage: steps.length
				? `Stopped — ${steps.length} step(s) completed before you cancelled.`
				: "Stopped.",
			steps,
			cancelled: true,
		};
	};

	for (let i = 0; i < MAX_STEPS; i++) {
		if (isAbort(signal)) return cancelledResult();
		const reply = await chat(
			`${scratchpad}\nRespond with the next JSON object now.`,
			buildLocalSystemPrompt(director),
		);
		const parsed = parseReply(reply);

		if (parsed.kind === "final") {
			return { finalMessage: parsed.text, steps };
		}

		// Cost-preview approval gate: a gated verb whose estimate crosses the
		// threshold ENDS THE TURN here (fail-closed) instead of spending. The user
		// approves out-of-band; the UI then runs the exact proposed action via
		// `executeDirectorAction`.
		const approval = evaluateApprovalGate(director, parsed.action, parsed.args);
		if (approval) {
			const message = approvalMessage(approval);
			const step: AgentToolStep = {
				action: parsed.action,
				args: parsed.args,
				ok: false,
				message: `⏸ Awaiting approval — ${message}`,
			};
			steps.push(step);
			onStep?.(step);
			onEvent?.({ type: "awaiting_approval", approval });
			return { finalMessage: message, steps, awaitingApproval: approval };
		}

		// Coarse per-step events (the local brain has no token stream): announce
		// the step, run it, report the result.
		const callId = `l${callCounter++}`;
		const isKnown = Boolean(TOOLS[parsed.action]);
		if (isKnown) {
			onEvent?.({
				type: "tool_start",
				callId,
				action: parsed.action,
				args: parsed.args,
				cost: previewToolCost(director, parsed.action, parsed.args),
			});
		}

		const { step, observation } = await executeTool(
			director,
			parsed.action,
			parsed.args,
		);
		// Unknown actions aren't real steps — feed the correction back without
		// recording/streaming a step (mirrors the original loop's behavior).
		if (!isKnown) {
			scratchpad +=
				`ASSISTANT: ${JSON.stringify({ action: parsed.action, args: parsed.args })}\n` +
				`OBSERVATION: ${observation}\n`;
			continue;
		}
		steps.push(step);
		onStep?.(step);
		onEvent?.({ type: "tool_finish", callId, step });

		scratchpad +=
			`ASSISTANT: ${JSON.stringify({ action: parsed.action, args: parsed.args })}\n` +
			`OBSERVATION: ${observation}\n`;
	}

	// Hit the step ceiling — ask for a closing summary.
	const closing = await chat(
		`${scratchpad}\nYou have taken enough steps. Reply ONLY with {"final":"..."} summarizing the result for the user.`,
		buildLocalSystemPrompt(director),
	);
	const parsed = parseReply(closing);
	return {
		finalMessage: parsed.kind === "final" ? parsed.text : closing.trim(),
		steps,
	};
}

// ── entry point ──────────────────────────────────────────────────────────────

/**
 * Run one user turn through the agent. `onStep` fires after each executed tool
 * so the UI can stream progress.
 *
 * Brain selection:
 *  - `"auto"` (default): frontier Claude via `/api/llm/agent`; if the relay
 *    reports no `ANTHROPIC_API_KEY`, transparently falls back to the local
 *    Ollama text loop (`chat`). The fallback decision happens on the FIRST
 *    relay call, before any tool has run, so no work is repeated.
 *  - `"frontier"`: Claude only — a missing key surfaces as an error.
 *  - `"local"`: privacy mode — never leaves the machine (uses `chat` only).
 */
export async function runDirectorAgent(opts: {
	director: DirectorApi;
	chat: AgentChatFn;
	userMessage: string;
	onStep?: (step: AgentToolStep) => void;
	/** Live progress sink — reasoning deltas + per-tool start/finish (see {@link DirectorEvent}). */
	onEvent?: DirectorEventSink;
	/** Cooperative cancel — checked between model/tool calls and aborts the in-flight relay fetch. */
	signal?: AbortSignal;
	brain?: "auto" | "frontier" | "local";
}): Promise<AgentRunResult> {
	const brain = opts.brain ?? "auto";
	if (brain === "local") return runDirectorAgentLocal(opts);
	try {
		return await runDirectorAgentFrontier(opts);
	} catch (error) {
		if (brain === "auto" && error instanceof AnthropicKeyMissingError) {
			return runDirectorAgentLocal(opts);
		}
		throw error;
	}
}

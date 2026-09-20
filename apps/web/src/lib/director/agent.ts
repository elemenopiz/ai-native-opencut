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
 *  - LOCAL (RETIRED for now): the original plain-text ReAct loop over the
 *    Ollama backend (`aiClient.chat` injected as `AgentChatFn`), one JSON
 *    action per turn. Kept intact as `runDirectorAgentLocal` for revival, but
 *    `runDirectorAgent` no longer routes to it — with no cloud key configured
 *    the run fails with a clear configuration error instead of silently
 *    degrading to a weak local brain.
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
import type { StoryboardPlan } from "./storyboard-plan";
import { styleBibleDescriptors } from "./storyboard-plan";
import type { ReelSnapshot, ReviewTakeData, WatchBackData } from "./types";
import { PLAYBOOKS } from "@/lib/studio/playbooks";
import { createShortIdMap, type ShortIdMap } from "./short-id";
import {
	needsApproval,
	formatCostRange,
	estimateVoiceoverCost,
	estimateMusicBedCost,
	DEFAULT_APPROVAL_THRESHOLD_CREDITS,
	type CostRange,
} from "@/lib/studio/cost";
// Reel-budget copy stays USD-denominated by design (`./budget`'s own
// formatter) — a separate unit from the credits-denominated cost-preview gate
// above (`@/lib/studio/cost`).
import { formatUsd } from "./budget";
import { useStudioSettingsStore } from "@/stores/studio-settings-store";
import {
	toolCatalog,
	str,
	numOr,
	type JSONSchema,
	type ToolHandler,
} from "./tool-catalog";
import { reportVerbTelemetry } from "@/lib/mcp/verb-telemetry-client";
import {
	buildCriticSystemPrompt,
	buildCriticUserBlocks,
	dataUrlToImageBlock,
	parseVerdict,
	recordVerdict,
	wantsAutoReview,
	type ContinuityContext,
	type CriticVerdict,
} from "./vision-critic";
// Native Gemini sibling brain (`runDirectorAgent` routes to it; it imports this
// module's shared gates/prompt blocks — a deliberate, call-time-only cycle).
import { GeminiKeyMissingError, runDirectorAgentGemini } from "./agent-gemini";

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
	| {
			/**
			 * Running spend against the reel's budget, emitted after a budgeted
			 * generation runs (and on a budget-driven down-route) so the panel can
			 * render "spent X of $Y" live.
			 */
			type: "budget_update";
			spentUsd: number;
			budgetUsd?: number;
	  }
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
export function isAbort(
	signal: AbortSignal | undefined,
	err?: unknown,
): boolean {
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
 *
 * Sized for the Director's "doer" autonomy pass (2026-09-18 — see
 * `docs/plans/2026-09-18-director-autonomy-architecture.md` §3): a one-shot
 * vlog edit (captions, cuts, graphics, generated B-roll, audio/voiceover) is
 * hundreds of primitive verb calls, not a handful, so the old 24/30 forced a
 * "check in" long before a real edit was done. Raised 24→150 / 30→180 (same
 * ~0.8 tool-calls-per-model-call ratio as before) — enough headroom for a
 * long autonomous run while staying a HARD ceiling, not unlimited: hitting it
 * still forces a clean text summary (never a silent stop), and the user can
 * simply continue in a follow-up turn (conversation history rides via
 * `priorMessages`) rather than the loop running forever on its own.
 *
 * COST NOTE: this bounds ROUND-TRIP COUNT, not per-call spend — the relay's
 * own `MAX_OUTPUT_TOKENS` (16k, `app/api/llm/agent/route.ts`) is the
 * per-call anti-abuse ceiling and is UNCHANGED here. Raising `MAX_MODEL_CALLS`
 * does widen the theoretical worst case (all calls hitting the full 16k):
 * 30 × 16k = 480k output tokens/turn before this change, 180 × 16k = 2.88M
 * after — a ~6x worst-case ceiling. Real turns run far below that (most model
 * calls are a short "what's next" decision, not a maxed-out completion), and
 * the existing per-account rate limits (`enforceRateLimit` in the relay
 * route) and the COST GATE below (which still pauses for approval before any
 * real paid generation) are unaffected by this constant. If usage data later
 * shows this ceiling is still being hit routinely, prefer raising it again in
 * a follow-up over removing the cap outright.
 */
export const MAX_TOOL_CALLS = 150;
/** Bound on model round-trips (also covers pause_turn re-sends). See {@link MAX_TOOL_CALLS}'s doc comment for the cost reasoning behind this number. */
export const MAX_MODEL_CALLS = 180;

// ── conversation history replay (Director-revamp Item 9) ─────────────────────
//
// Reopening (or continuing) a persisted conversation should let the model
// actually SEE the earlier turns, not just the chat panel replaying them
// visually. `getConversationHistoryForAgent` (`stores/ai-store.ts`) is the
// producer seam: it already applies the store's OWN replay policy (last N
// messages verbatim + a synthetic truncation-notice row, flattened tool/step
// chips as plain text). `priorMessages` below is the CONSUMER seam — both
// brains prepend it to the outgoing history, capped independently of (and
// tighter than) the store's replay window, because this bound is about the
// MODEL's context budget, not what's rendered on screen.

/** One prior turn from a reopened/ongoing conversation, ready to replay into a fresh run. */
export interface DirectorHistoryMessage {
	role: "user" | "assistant";
	content: string;
}

/**
 * Hard caps on how much prior-conversation history rides the model's context.
 * Two independent bounds, both enforced by {@link capHistoryMessages}:
 *  - at most this many of the MOST RECENT messages,
 *  - AND at most this many total content characters (oldest-first trim),
 * so a handful of huge messages can't blow the budget even under the count
 * cap. Distinct from {@link MAX_TOOL_CALLS}/{@link MAX_MODEL_CALLS} above,
 * which bound a single turn's tool-use loop, not cross-turn history — there
 * was no existing history-length cap before this pass.
 */
export const MAX_HISTORY_MESSAGES = 20;
/** Companion char budget to {@link MAX_HISTORY_MESSAGES} — see that doc comment. */
export const MAX_HISTORY_CHARS = 8000;

/**
 * Apply the {@link MAX_HISTORY_MESSAGES}/{@link MAX_HISTORY_CHARS} caps to a
 * conversation's prior turns: keep the most recent messages, trimming from
 * the OLDEST end first so the turns closest to "now" always survive. Pure and
 * order-preserving; safe to call with `undefined`/empty input.
 */
export function capHistoryMessages(
	messages: DirectorHistoryMessage[] | undefined,
): DirectorHistoryMessage[] {
	if (!messages || messages.length === 0) return [];
	const byCount = messages.slice(-MAX_HISTORY_MESSAGES);
	let totalChars = byCount.reduce((sum, m) => sum + m.content.length, 0);
	let start = 0;
	while (totalChars > MAX_HISTORY_CHARS && start < byCount.length - 1) {
		totalChars -= byCount[start].content.length;
		start++;
	}
	return byCount.slice(start);
}

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

/**
 * Same catalog, keyed to the `mutating` flag — used by `executeTool`'s
 * telemetry to derive `timelineChanged` without threading the descriptor
 * itself through the call. Mirrors `build-mcp-server.ts`'s use of the
 * identical catalog flag for the same purpose on the MCP path.
 */
const MUTATING_BY_NAME: Record<string, boolean> = Object.fromEntries(
	toolCatalog().map((t) => [t.name, t.mutating]),
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

/**
 * The model-routing policy the Director reasons over. States the intent→tier
 * mapping once, shared by both brains. The backend catalog itself is fetched
 * on demand via `getBackends` (not dumped here) to keep the once-per-turn prompt
 * cheap and byte-stable for caching.
 */
export const MODEL_ROUTING_POLICY = [
	"MODEL ROUTING: call getBackends to see the models available now — each has a cost tier (cheap/standard/premium), a safety tier, and whether it supports seed-lock. generate and reroll accept an optional `backendId`. Policy: draft and iterate on a CHEAP-tier backend; render final/hero shots on a PREMIUM-tier backend; put persona/identity-critical shots on a seed-lock-capable backend. Omit `backendId` to let the router auto-pick by intent.",
	"A/B: to compare a shot across two models use compareTake with two backendIds — it auto-picks the winner when a vision critic is available, otherwise it adds both takes for the user to choose. It costs 2x, so reserve it for shots worth the extra spend.",
].join("\n");

/**
 * The whole-reel budget policy. When the user names a total budget ("a 6-shot
 * reel for $2"), the Director plans SPEND across the sequence instead of gating
 * each shot alone.
 */
export const BUDGET_POLICY = [
	"BUDGET: when the user gives the WHOLE reel a dollar cap (e.g. 'a 6-shot reel for $2'), pass `budgetUsd` to storyboard and mark each shot's `importance` (hero/support/broll). The plan then allocates the cap across shots — hero shots get a premium tier, b-roll a cheap one — and down-tiers the least-important shots to fit. Every later generate is gated against the REMAINING budget: a shot that would blow it is automatically down-routed to a cheaper backend, or (if nothing fits) pauses for approval. Check getBudgetStatus for what's left; use setBudget to change the cap after shots exist. Do NOT hand-pick premium `backendId`s that would overspend — trust the allocation.",
].join("\n");

/** Concise pointer to the UGC prompt playbooks — titles/descriptions only, not the full content. */
export const PLAYBOOK_POINTER = Object.values(PLAYBOOKS)
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
export function reelShortIdMap(director: DirectorApi): ShortIdMap {
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
 * Compact PROJECT/PERSONAS/LIBRARY/TIMELINE grounding block, built from
 * `DirectorApi.getProjectInfo` + `DirectorApi.getTimeline` — cheap enough to
 * rebuild every turn and small enough to ride in the once-per-turn system
 * prompt (summarized, not dumped: personas and recent assets are pre-capped
 * by `getProjectInfo`; the timeline line is a single-line digest, full detail
 * stays behind the `getTimeline` verb).
 */
export function buildContextBlock(director: DirectorApi): string {
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

	// STANDING LIBRARY AWARENESS: a faceted, role-aware manifest digest (counts by
	// role, named heroes with captions, face-anchor personas, a searchable tail)
	// instead of only the last few assets by recency — so the brain knows the whole
	// library, not just what it happened to upload last. `getProjectInfo` builds it
	// (via `asset-manifest.ts`) and it degrades to media-type counts + recent names
	// when no Understanding Pass data is wired. `getLibraryManifest` re-queries it.
	lines.push(info.manifest.digest);

	// STANDING TIMELINE AWARENESS: the whole timeline (uploaded clips, text
	// overlays, audio, AND generative slots) — not just the generative REEL
	// below (`reelSummary`/`getReel`, which only ever sees `.generation`-bearing
	// image/video elements). Without this line a hand-built timeline with no
	// generative slots reported as an EMPTY reel even though it had real,
	// visible content — the model needs this digest to know the project isn't
	// empty just because the reel is. Same digest-in-prompt / detail-on-verb
	// pattern as the LIBRARY line above: full per-element detail stays behind
	// the re-queryable `getTimeline` verb.
	const timeline = director.getTimeline().data;
	lines.push(timeline?.digest ?? "TIMELINE: empty.");

	// STANDING BRIEF AWARENESS (P1): a one-line glance at the durable creative
	// intent, same digest-in-prompt / full-detail-behind-a-verb pattern as
	// LIBRARY/TIMELINE above (`getBrief` is the full read). ABSENT entirely
	// when there's no brief yet AND no learned-preference signal, so a fresh
	// project's context block is unchanged from before this field existed —
	// the full DIRECTOR BRIEF block (always rendered, see `briefBlock`) stays
	// the authoritative per-turn read either way.
	if (info.briefDigest) lines.push(info.briefDigest);

	return lines.join("\n");
}

/**
 * Compact render of the active storyboard plan, so a later turn reads back the
 * per-shot INTENT/CAMERA/SUBJECT and the style bible it should generate against
 * WITHOUT having to call getReel. Shows only the creative notes (the prompts are
 * already in the REEL listing), plus the one-line bible.
 */
function planSummary(plan: StoryboardPlan): string {
	const bibleParts = [
		plan.bible.palette && `palette: ${plan.bible.palette}`,
		plan.bible.lensMood && `lens/mood: ${plan.bible.lensMood}`,
		plan.bible.setting && `setting: ${plan.bible.setting}`,
	].filter((p): p is string => Boolean(p));
	const bible = bibleParts.length ? ` — ${bibleParts.join("; ")}` : "";
	const shots = plan.shots.map((s) => {
		const notes = [
			s.intent && `intent: ${s.intent}`,
			s.camera && `camera: ${s.camera}`,
			s.subject && `subject: ${s.subject}`,
		]
			.filter(Boolean)
			.join("; ");
		return `  ${s.index}. ${notes || JSON.stringify(s.prompt)}`;
	});
	return `PLAN (${plan.shotCount} shots${bible}) — generate each shot against its intent:\n${shots.join("\n")}`;
}

/**
 * "34.0s built / 60s target" pacing clause when the brief has a target
 * duration set; empty string otherwise (a brief with no target must not
 * change the digest at all).
 */
function pacingClause(reel: ReelSnapshot): string {
	if (reel.targetDurationSec == null) return "";
	return ` / ${reel.targetDurationSec}s target`;
}

/** Compact, current reel state for the model to target slots by id (SHORT ids). */
export function reelSummary(director: DirectorApi): string {
	const reel = director.getReel();
	const planBlock = reel.plan ? `\n\n${planSummary(reel.plan)}` : "";
	if (reel.slots.length === 0)
		return `REEL: empty (no slots yet).${pacingClause(reel)}${planBlock}`;
	const map = reelShortIdMap(director);
	const lines = reel.slots.map(
		(s, i) =>
			`  #${i + 1} id=${map.shorten(s.id)} @${s.start.toFixed(1)}s+${s.duration.toFixed(1)}s status=${s.status} takes=${s.takeCount} prompt=${JSON.stringify(
				s.prompt,
			)}`,
	);
	return `REEL (${reel.slots.length} slots, ${reel.totalDuration.toFixed(1)}s${pacingClause(reel)}):\n${lines.join("\n")}${planBlock}`;
}

/**
 * The DIRECTOR BRIEF block folded into the system prompt each turn — the
 * summarized, durable creative intent (goal/audience/tone/style/do/don't +
 * learned notes). The DirectorApi owns the summarization (`summarizeBrief`) so
 * both brains and the future MCP surface render it identically.
 */
export function briefBlock(director: DirectorApi): string {
	return director.briefPromptBlock();
}

// ── shared tool execution ────────────────────────────────────────────────────

/**
 * Execute one named tool call against the DirectorApi: expand short ids at the
 * single choke point, run the registry executor, and build the compact
 * observation the model sees. Shared by both brains so the observation
 * language (short ids, `CHANGES:` deltas) is identical.
 */
export async function executeTool(
	director: DirectorApi,
	action: string,
	rawArgs: Record<string, unknown>,
): Promise<{
	step: AgentToolStep;
	observation: string;
	/**
	 * What actually goes in the tool_result: the plain-text `observation` for most
	 * verbs, or a text-plus-image block array for `reviewTake` so the model SEES
	 * the take's frames. The stateless relay forwards message content verbatim, so
	 * image blocks ride through to Claude unchanged (no relay change needed).
	 */
	content: string | Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam>;
}> {
	// Telemetry: `executeTool` is the SINGLE choke point every in-app Director
	// verb call passes through — both agent loops (frontier + Gemini) call it
	// directly, and `executeDirectorAction` (the UI's cost-approval resume
	// path) is a thin wrapper around it — so instrumenting here, not
	// `executeDirectorAction`, gets full agent-path coverage. Mirrors
	// `build-mcp-server.ts`'s `tools/call` handler: same `status`/`durationMs`/
	// `timelineChanged` shape, `source: "agent"` on the wire (stamped by the
	// `/api/telemetry/verb` route, not the client — see
	// `verb-telemetry-client.ts`).
	const startedAt = performance.now();
	const elapsedMs = () => Math.round(performance.now() - startedAt);

	const tool = TOOLS[action];
	if (!tool) {
		const message = `Unknown action "${action}". Valid tools: ${Object.keys(TOOLS).join(", ")}.`;
		reportVerbTelemetry({
			verb: action,
			status: "unknown_action",
			durationMs: elapsedMs(),
			timelineChanged: false,
			mutating: false,
		});
		return {
			step: { action, args: rawArgs, ok: false, message },
			observation: message,
			content: message,
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

	// timelineChanged: the cheap proxy for "did the agent actually do
	// something" — a MUTATING verb (the catalog's own flag) that came back ok.
	const mutating = MUTATING_BY_NAME[action] ?? false;
	reportVerbTelemetry({
		verb: action,
		status: result.ok ? "ok" : "tool_error",
		durationMs: elapsedMs(),
		timelineChanged: mutating && result.ok,
		mutating,
	});

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
			action === "findDuplicateAssets" ||
			action === "getConsistencyContext" ||
			action === "getProjectInfo" ||
			action === "getLibraryManifest" ||
			action === "getBackends" ||
			action === "getBrief" ||
			action === "getProjectBible" ||
			action === "getVoiceProfiles" ||
			action === "intakeReferences")
	) {
		observation = `${result.message} DATA:${JSON.stringify(result.data)}`;
	} else {
		observation = result.message;
	}

	// reviewTake (a slot's SOURCE take) and watchBack (the COMPOSITED timeline —
	// see watch-back.ts) both carry decoded frames — attach them as image content
	// blocks so the model SEES the shot/cut instead of reading about it. The data
	// URLs are kept OUT of `observation` (they're large and never belong in the
	// step log); the text summary rides alongside the images in the tool_result
	// content array.
	let content:
		| string
		| Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = observation;
	if (result.ok && (action === "reviewTake" || action === "watchBack")) {
		const frames =
			action === "reviewTake"
				? ((result.data as ReviewTakeData | undefined)?.frames ?? [])
				: ((result.data as WatchBackData | undefined)?.frames ?? []);
		const imageBlocks = frames
			.map(dataUrlToImageBlock)
			.filter((b): b is Anthropic.ImageBlockParam => b !== null);
		if (imageBlocks.length > 0) {
			content = [{ type: "text", text: observation }, ...imageBlocks];
		}
	}

	return { step, observation, content };
}

// ── cost-preview approval gate (concept: cost-preview gate) ──────────────────
//
// Verbs that spend real generation credits carry an implicit `requiresApproval`
// flag. Before EITHER brain runs one, we estimate its cost; if it crosses the
// user's threshold the loop ENDS ITS TURN with an `awaitingApproval` result
// instead of spending. The human approves (or not) out-of-band and the UI then
// runs the exact proposed action via `executeDirectorAction`. Fail-closed: the
// agent cannot talk itself past the gate within a turn — the loop returns.

/** Verbs gated behind the approval gate — they hit a PAID backend and cost money.
 *  `compareTake` is included because A/B doubles the spend (one take per backend);
 *  `addVoiceover`/`addMusicBed` because they render TTS / pull a licensed track from
 *  the paid sounds backend, so an audio spend must pause at the threshold just like
 *  a visual `generate` does. */
const REQUIRES_APPROVAL = new Set([
	"generate",
	"reroll",
	"remix",
	"compareTake",
	"addVoiceover",
	"addMusicBed",
]);

/** The user-configured credits threshold, read live from the studio settings store. */
export function approvalThreshold(): number {
	return (
		useStudioSettingsStore.getState().approvalThresholdCredits ??
		DEFAULT_APPROVAL_THRESHOLD_CREDITS
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
	if (action === "remix") {
		// remix produces one new take on the one slot — same cost shape as a
		// single-alternative reroll.
		return (
			director.estimateGenerateCost({
				slotIds: [str(args.slotId)],
				alternatives: 1,
			}).data ?? null
		);
	}
	if (action === "compareTake") {
		// One take per backend on the one slot → alternatives = number of backends
		// (at least 2). Reuses the same per-slot estimator so the preview matches
		// the doubled A/B spend.
		const backendCount = Array.isArray(args.backendIds)
			? args.backendIds.length
			: 0;
		return (
			director.estimateGenerateCost({
				slotIds: [str(args.slotId)],
				alternatives: Math.max(2, backendCount),
			}).data ?? null
		);
	}
	// Audio verbs bill a paid backend too, so they gate on a real estimate. TTS
	// cost scales with the script length (always in the args); a music bed is a
	// flat per-track fee. Both are pure functions of the args — no DirectorApi
	// round-trip and no slot resolution — so `director` is intentionally unused.
	if (action === "addVoiceover") {
		const est = estimateVoiceoverCost(str(args.script));
		return est.clips > 0 ? est : null;
	}
	if (action === "addMusicBed") {
		return estimateMusicBedCost();
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
export function previewToolCost(
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
export function approvalMessage(a: AgentApproval): string {
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
export function evaluateApprovalGate(
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

// ── whole-reel budget gate (concept: budget-aware directing) ─────────────────
//
// When the reel carries a total budget (set via `storyboard budgetUsd` / the
// `setBudget` verb), spend is governed by the REMAINING budget, not the flat
// per-action threshold: `director.evaluateSpend` decides whether a proposed
// generation fits at its requested tier and, if not, whether to DOWN-ROUTE it to
// a cheaper backend or PAUSE for approval. This runs BEFORE the flat gate and
// takes precedence while a budget is active — so the Director allocates spend
// across the whole reel instead of blindly gating each action in isolation.

/** Map a gated verb + its id-expanded args to the targeting `evaluateSpend` takes. */
function budgetSpendInput(
	action: string,
	args: Record<string, unknown>,
): {
	slotIds?: string[] | "all";
	alternatives?: number;
	backendId?: string;
} | null {
	if (action === "generate") {
		return {
			slotIds: Array.isArray(args.slotIds) ? args.slotIds.map(str) : "all",
			alternatives: numOr(args.alternatives, 1),
			...(args.backendId ? { backendId: str(args.backendId) } : {}),
		};
	}
	if (action === "reroll") {
		return {
			slotIds: [str(args.slotId)],
			alternatives: numOr(args.alternatives, 1),
			...(args.backendId ? { backendId: str(args.backendId) } : {}),
		};
	}
	if (action === "remix") {
		// One new take on the one slot (remix takes no `alternatives` arg).
		return {
			slotIds: [str(args.slotId)],
			alternatives: 1,
			...(args.backendId ? { backendId: str(args.backendId) } : {}),
		};
	}
	if (action === "compareTake") {
		const backendCount = Array.isArray(args.backendIds)
			? args.backendIds.length
			: 0;
		return {
			slotIds: [str(args.slotId)],
			alternatives: Math.max(2, backendCount),
		};
	}
	return null;
}

/** Human copy for a budget-driven pause (distinct from the flat-threshold message). */
export function budgetPauseMessage(
	a: AgentApproval,
	remainingUsd: number,
): string {
	return (
		`This ${a.action} (~${formatCostRange(a.estimate)} for ${a.clips} clip(s)) ` +
		`would exceed the reel's remaining budget of ${formatUsd(
			Math.max(0, remainingUsd),
		)} even at the cheapest tier. Approve to spend over budget — nothing has ` +
		`been generated yet.`
	);
}

/**
 * The budget verdict for one proposed gated action. `outcome:"inactive"` ⇒ no
 * budget is set (fall back to the flat approval gate). Otherwise the loop pauses,
 * down-routes (pinning `backendId`), or proceeds — recording `costUsd` after a
 * successful run.
 */
export interface BudgetVerdict {
	outcome: "inactive" | "proceed" | "downroute" | "pause";
	/** USD to record as spent once the action succeeds (0 when inactive). */
	costUsd: number;
	/** On down-route: the cheaper backend to pin (undefined ⇒ drop any pin, auto-route cheaper). */
	backendId?: string;
	/** On down-route: a note describing what changed, surfaced as a synthetic step. */
	note?: string;
	/** On pause: the approval to end the turn with. */
	approval?: AgentApproval;
}

/**
 * Evaluate the whole-reel budget gate for one proposed gated action. Delegates
 * the fit decision to `director.evaluateSpend` (which reads the live spend +
 * catalog), then shapes it into a {@link BudgetVerdict} the loop acts on. Any
 * id-expansion or estimate failure degrades to `inactive` so the flat gate still
 * governs — the budget layer never swallows a spend silently.
 */
export async function evaluateBudgetGate(
	director: DirectorApi,
	action: string,
	rawArgs: Record<string, unknown>,
): Promise<BudgetVerdict> {
	const input = budgetSpendInput(action, rawArgs);
	if (!input) return { outcome: "inactive", costUsd: 0 };

	let expanded: {
		slotIds?: string[] | "all";
		alternatives?: number;
		backendId?: string;
	};
	try {
		const e = expandIdArgs(rawArgs, reelShortIdMap(director));
		expanded = budgetSpendInput(action, e) ?? input;
	} catch {
		return { outcome: "inactive", costUsd: 0 };
	}

	let ev: Awaited<ReturnType<DirectorApi["evaluateSpend"]>>;
	try {
		ev = await director.evaluateSpend(expanded);
	} catch {
		return { outcome: "inactive", costUsd: 0 };
	}
	if (!ev.active || !ev.decision) return { outcome: "inactive", costUsd: 0 };

	const { decision } = ev;
	if (decision.outcome === "pause") {
		const est = estimateActionCost(director, action, expanded);
		const approval: AgentApproval = {
			action,
			args: rawArgs,
			estimate: est
				? { low: est.low, high: est.high }
				: { low: decision.costUsd, high: decision.costUsd },
			clips: est?.clips ?? 1,
		};
		return {
			outcome: "pause",
			costUsd: decision.costUsd,
			approval,
		};
	}

	if (decision.outcome === "downroute") {
		const from = decision.downroutedFrom ?? "premium";
		const note = ev.downrouteBackendId
			? `Down-routed ${action} from ${from} to a cheaper backend (${ev.downrouteBackendId}) to stay within the ${formatUsd(
					decision.remainingUsd,
				)} left in budget.`
			: `Down-routed ${action} from ${from} to the cheap tier (auto-routing cheaper) to stay within the ${formatUsd(
					decision.remainingUsd,
				)} left in budget.`;
		return {
			outcome: "downroute",
			costUsd: decision.costUsd,
			backendId: ev.downrouteBackendId,
			note,
		};
	}

	return { outcome: "proceed", costUsd: decision.costUsd };
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

// ── vision self-review loop (concept: generate → SEE → fix) ──────────────────
//
// After a generation, the model normally never SEES the result. When the user
// opts into quality ("make it good", a studio setting), we run a bounded,
// DETERMINISTIC self-correction per generated slot: decode the take's frames
// (reviewTake), have a tool-less critic judge them against the slot's prompt,
// and act on the structured verdict — keep, reroll from a revised prompt, or
// remix with a small anchored delta. Every corrective spend is gated by the SAME
// cost-preview threshold as the interactive loop, so auto-review can never burn
// budget past what the user would have to approve by hand.

/** Max self-correction attempts per slot before auto-review gives up and keeps the take. */
const MAX_AUTO_REVIEW_ATTEMPTS = 2;

/** Record a synthetic (non-model) auto-review step so the UI shows what happened. */
function recordAutoStep(
	steps: AgentToolStep[],
	onStep: ((step: AgentToolStep) => void) | undefined,
	action: string,
	message: string,
	ok: boolean,
): void {
	const step: AgentToolStep = { action, args: {}, ok, message };
	steps.push(step);
	onStep?.(step);
}

/**
 * A critic step: judge a take's frames against its intent → structured verdict.
 * The optional {@link ContinuityContext} (a prior shot's frame + style bible)
 * turns on cross-shot continuity judging and the `remix-for-continuity` verdict.
 */
export type CritiqueFn = (
	intent: string,
	frames: string[],
	context?: ContinuityContext,
) => Promise<CriticVerdict>;

/** The production critic: one tool-less relay call → a parsed {@link CriticVerdict}. */
const relayCritique: CritiqueFn = async (intent, frames, context) => {
	const turn = await callAgentRelay({
		messages: [
			{ role: "user", content: buildCriticUserBlocks(intent, frames, context) },
		],
		system: buildCriticSystemPrompt(Boolean(context?.priorFrame)),
		tools: [],
	});
	return parseVerdict(textOf(turn.content));
};

/**
 * Auto-review one slot: SEE → critique → correct, up to
 * {@link MAX_AUTO_REVIEW_ATTEMPTS} times. Stops early on `pass`, on any
 * non-reviewable state (take not ready / no media / critic error), or when a
 * corrective action would cross the approval threshold (left for the user).
 * Mutations go through the DirectorApi verbs, so the corrected take is selected
 * and the next iteration re-reviews the NEW take.
 *
 * `critique` is injected (defaults to the relay critic) so the loop's decision →
 * action wiring is testable without a live model call. Exported for the same
 * reason.
 */
export async function autoReviewSlot(opts: {
	director: DirectorApi;
	slotId: string;
	shortId: string;
	threshold: number;
	steps: AgentToolStep[];
	onStep?: (step: AgentToolStep) => void;
	critique?: CritiqueFn;
	/**
	 * The PREVIOUS shot's slot id, when this slot follows another in the reel.
	 * Its last frame is decoded once and fed to the critic so it can judge
	 * CROSS-SHOT continuity; on a continuity miss the corrective remix is anchored
	 * on that same frame. Omit for the first shot (no continuity to hold).
	 */
	priorSlotId?: string;
	/** Rendered style-bible descriptors (see `styleBibleDescriptors`) the reel must hold. */
	bible?: string;
}): Promise<void> {
	const {
		director,
		slotId,
		shortId,
		threshold,
		steps,
		onStep,
		priorSlotId,
		bible,
	} = opts;
	const critique = opts.critique ?? relayCritique;

	// Cross-shot continuity: decode the PRIOR shot's last frame once (reused every
	// attempt) so the critic can compare this shot against it. A prior shot that
	// isn't reviewable yet simply turns continuity judging off for this slot.
	let priorFrame: string | undefined;
	if (priorSlotId) {
		const priorReview = await director.reviewTake({
			slotId: priorSlotId,
			frames: 1,
		});
		if (priorReview.ok && priorReview.data) {
			const f = priorReview.data.frames;
			priorFrame = f[f.length - 1];
		}
	}
	const context: ContinuityContext | undefined = priorFrame
		? { priorFrame, ...(bible ? { bible } : {}) }
		: undefined;

	for (let attempt = 0; attempt < MAX_AUTO_REVIEW_ATTEMPTS; attempt++) {
		// 1. SEE the current take.
		const review = await director.reviewTake({ slotId });
		if (!review.ok || !review.data) return; // nothing decodable to review — stop quietly.

		// 2. Critic verdict — a relay failure must not derail the user's turn.
		let verdict: CriticVerdict;
		try {
			verdict = await critique(review.data.prompt, review.data.frames, context);
		} catch (err) {
			recordAutoStep(
				steps,
				onStep,
				"reviewTake",
				`Skipped auto-review of slot ${shortId} — critic call failed: ${
					err instanceof Error ? err.message : String(err)
				}`,
				false,
			);
			return;
		}
		recordAutoStep(
			steps,
			onStep,
			"reviewTake",
			`Reviewed slot ${shortId}: ${verdict.verdict}${verdict.reason ? ` — ${verdict.reason}` : ""}${
				verdict.temporalIssue ? ` [motion: ${verdict.temporalIssue}]` : ""
			}`,
			true,
		);

		// 2b. Feed-forward memory: record this verdict against the slot's prompt so
		// a later generation of the SAME prompt carries "previously failed because
		// X" context into the critic (see `recordVerdict`/`recentVerdictsFor` in
		// vision-critic.ts). In-memory, per-session, no model call; `pass` is
		// recorded too but only non-pass history is ever surfaced.
		recordVerdict({
			promptKey: review.data.prompt,
			verdict,
			slotId,
		});

		// 3. Keep it and stop.
		if (verdict.verdict === "pass" || !verdict.revisedPrompt) return;

		// 4. Cost gate: a corrective generation is a spend. While a whole-reel
		// budget is active it governs the decision (pause / down-route) AND the
		// spend must be recorded against it (auto-review runs OUTSIDE the tool
		// loop, which is where interactive spend is tallied); otherwise fall back
		// to the flat approval threshold. Never spend unsupervised past either.
		const action: "reroll" | "remix" =
			verdict.verdict === "reroll-with-delta" ? "reroll" : "remix";
		const budget = await evaluateBudgetGate(director, action, {
			slotId,
			alternatives: 1,
		});
		let pinnedBackendId: string | undefined;
		if (budget.outcome === "pause") {
			recordAutoStep(
				steps,
				onStep,
				action,
				`Auto-review paused on slot ${shortId} — a corrective ${verdict.verdict} would push the reel over its remaining budget. Approve it to apply the fix.`,
				false,
			);
			return;
		}
		if (budget.outcome === "downroute") {
			if (action === "reroll") {
				pinnedBackendId = budget.backendId;
			} else {
				// remix can't be retargeted to a cheaper backend, so honouring the
				// reel budget means leaving it for the user rather than overspending.
				recordAutoStep(
					steps,
					onStep,
					action,
					`Auto-review paused on slot ${shortId} — a corrective ${verdict.verdict} only fits the reel budget on a cheaper model, which remix can't retarget. Approve it to apply the fix.`,
					false,
				);
				return;
			}
		}
		if (budget.outcome === "inactive") {
			const est = director.estimateGenerateCost({
				slotIds: [slotId],
				alternatives: 1,
			}).data;
			if (est && needsApproval(est, threshold)) {
				recordAutoStep(
					steps,
					onStep,
					action,
					`Auto-review paused on slot ${shortId} — a corrective ${verdict.verdict} (~${formatCostRange(
						est,
					)}) is over your approval threshold. Approve it to apply the fix.`,
					false,
				);
				return;
			}
		}

		// 5. Apply the correction through the real verbs.
		let correctedTakeId: string | undefined;
		let message: string;
		let corrected: boolean;
		if (verdict.verdict === "reroll-with-delta") {
			// Capture the user's authored prompt BEFORE overwriting it, so a failed
			// reroll can be rolled back — otherwise the critic's revision would
			// persist on the slot even though it produced no take and the displayed
			// take is still the old one.
			const originalPrompt = director.getSlot(slotId).data?.prompt;
			director.setPrompt({ slotId, prompt: verdict.revisedPrompt });
			const res = await director.reroll({
				slotId,
				alternatives: 1,
				backendId: pinnedBackendId,
			});
			correctedTakeId = res.data?.takeIds?.[0];
			message = res.message;
			corrected = res.ok;
			// Reroll failed: the revised prompt never made a take. Restore the
			// original so the user's authored prompt isn't silently lost.
			if (!corrected && originalPrompt !== undefined) {
				director.setPrompt({ slotId, prompt: originalPrompt });
			}
		} else if (verdict.verdict === "remix-for-continuity") {
			// Continuity miss: remix anchored on the PRIOR shot's frame (not this
			// take's own), with the bible descriptors folded into the delta so the
			// fix pulls the shot back onto the reel's look. `priorFrame` is present
			// here — a continuity verdict only comes from a continuity-enabled call.
			const remixPrompt = bible
				? `${verdict.revisedPrompt} — hold continuity: ${bible}`
				: verdict.revisedPrompt;
			const res = await director.remix({
				slotId,
				remixPrompt,
				anchorImageUrl: priorFrame,
			});
			correctedTakeId = res.data?.takeId;
			message = res.message;
			corrected = res.ok;
		} else {
			const res = await director.remix({
				slotId,
				remixPrompt: verdict.revisedPrompt,
			});
			correctedTakeId = res.data?.takeId;
			message = res.message;
			corrected = res.ok;
		}
		recordAutoStep(
			steps,
			onStep,
			verdict.verdict === "reroll-with-delta" ? "reroll" : "remix",
			message,
			corrected,
		);
		if (!corrected) return;

		// Record the corrective spend against the reel budget so the cap and the
		// panel stay accurate (this path never reaches the tool loop's recordSpend).
		if (
			(budget.outcome === "proceed" || budget.outcome === "downroute") &&
			budget.costUsd > 0
		) {
			director.recordSpend({ usd: budget.costUsd });
		}

		// 6. Select the corrected take so the reel (and the next review) uses it.
		// Bail if it didn't come back ready — don't spiral on a failing slot.
		if (correctedTakeId) {
			const take = director
				.getSlot(slotId)
				.data?.takes.find((t) => t.id === correctedTakeId);
			if (take?.status === "ready") {
				director.chooseTake({ slotId, takeId: correctedTakeId });
			} else {
				recordAutoStep(
					steps,
					onStep,
					"reviewTake",
					`Corrective take for slot ${shortId} came back ${take?.status ?? "unavailable"} — stopping auto-review.`,
					false,
				);
				return;
			}
		}
		// loop → re-review the corrected take.
	}
}

/**
 * Full ids of slots that a completed run generated or rerolled into, resolved
 * from the recorded steps' (short-id) args — the set auto-review should inspect.
 * A bare `generate` (no `slotIds`, or `"all"`) targets every current slot.
 */
export function collectGeneratedSlotIds(
	director: DirectorApi,
	steps: AgentToolStep[],
): string[] {
	const map = reelShortIdMap(director);
	const ids = new Set<string>();
	const expand = (v: unknown) => {
		if (typeof v === "string" && v) {
			try {
				ids.add(map.expand(v));
			} catch {
				/* stale short id — skip */
			}
		}
	};
	for (const step of steps) {
		if (!step.ok) continue;
		if (step.action === "generate") {
			const raw = step.args.slotIds;
			if (Array.isArray(raw)) raw.forEach(expand);
			else for (const s of director.getReel().slots) ids.add(s.id);
		} else if (step.action === "reroll") {
			expand(step.args.slotId);
		}
	}
	return [...ids];
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
export function textOf(content: Anthropic.ContentBlock[]): string {
	return content
		.filter((b): b is Anthropic.TextBlock => b.type === "text")
		.map((b) => b.text)
		.join("\n")
		.trim();
}

/**
 * One tool-less vision model round-trip through the SAME stateless relay the
 * agent/critic use: a system prompt + user content blocks (text + images) → the
 * assistant's text reply. This is the `VisionRelay` the take-critic adapter
 * (`take-critic-adapter.ts`) is wired with in `use-director`, so `compareTake`'s
 * auto-pick rides the exact relay path `reviewTake`'s critic does.
 */
export async function callVisionRelay(request: {
	system: string;
	content: Anthropic.ContentBlockParam[];
	signal?: AbortSignal;
}): Promise<string> {
	const turn = await callAgentRelay({
		messages: [{ role: "user", content: request.content }],
		system: request.system,
		tools: [],
		signal: request.signal,
	});
	return textOf(turn.content);
}

/**
 * System prompt for the frontier brain. Built ONCE per user turn (not per
 * model call) so the prefix stays byte-stable across the loop for prompt
 * caching; the reel listing inside it is therefore a snapshot — live state
 * flows through tool-result deltas and `getReel`.
 *
 * Exported for testing: the DIRECTOR BRIEF block (see {@link briefBlock}) must
 * demonstrably ride in the prompt so a preference stated on an earlier turn
 * influences generation on a later one.
 */
export function buildFrontierSystemPrompt(director: DirectorApi): string {
	return [
		"You are the Director — an AI that builds and edits a short video reel by calling tools.",
		"The REEL is the GENERATIVE LAYER: an ordered list of generative SLOTS, each holding a prompt and one or more generated TAKES. It sits ON TOP of the project's actual TIMELINE, which may ALSO hold uploaded clips, text overlays, and audio that are NOT reel slots — the TIMELINE line below (and the getTimeline verb) is the source of truth for the whole project; an empty REEL does NOT mean an empty project.",
		"",
		"UNITS: all durations and times are in SECONDS unless a field name ends in `Frames`.",
		"IDS: every id shown to you (in the REEL below and in tool-result CHANGES reports) is a SHORT id. Pass short ids back verbatim in tool args — do not lengthen or invent them. Exceptions (always FULL ids, never shortened): `targetTrackId` (a track id), `elementId` (a text-overlay id from addText), and mediaIds from searchMedia.",
		"",
		"Use tools ONLY when the user wants to build or change the reel. For questions, ideas, scripts, or advice, reply with plain text and no tool calls.",
		"You may request several independent tool calls in one turn; dependent steps (e.g. storyboard, then generate the new slots) belong in separate turns so you can read the ids from the results. Each tool result is a compact observation — mutating verbs report a CHANGES diff in short ids. The REEL listing below is a snapshot from the start of this turn; call getReel when you need a fresh view.",
		"Think through multi-step edits as much as needed, then act decisively. When the task is done, reply with a short plain-text summary of what you did.",
		"CHAT REGISTER: this is a casual chat, not a report. Write replies as a few plain, warm sentences — no markdown headers/section titles, no numbered write-ups. Bold and short lists are fine when they genuinely help scanability, but the default is prose: say what you did (or are about to do) in one or two sentences and move on.",
		"",
		"PLAN FIRST for multi-shot briefs: when the brief implies MORE THAN ONE shot (a sequence, story, ad, montage, or a 'make a video about X' that isn't a single clip), call `storyboard` BEFORE generating anything. Decompose the brief into ordered shots — each with its `prompt` PLUS creative `intent`/`camera`/`subject` notes — under one shared `bible` (palette, lensMood, setting, and any recurring `characters`). `storyboard` persists the plan (it appears as PLAN in the REEL below and via getReel) and auto-seeds the reel's consistency context from the bible, so every later `generate` inherits the same style and cast — do NOT restate style/characters shot by shot. Then generate against each shot's planned intent. If a PLAN already exists, build on it (setPrompt/reroll individual shots) rather than re-storyboarding from scratch.",
		'SINGLE / QUICK requests stay fast: for a one-off clip ("make me one clip of X", "add a shot of Y"), skip planning — go straight to reserveSlot (or a one-shot storyboard) and generate. Don\'t force a storyboard or a style bible onto a single-shot ask.',
		'CLARIFY ONCE, THEN BUILD — you are a DOER, not a brainstorming partner. A request like "edit this vlog" or "make me a product ad" already carries enough intent to start: your job is to fill the gaps yourself, not hand the brief back to the user to write. INFER AGGRESSIVELY FIRST from what you already know — the LIBRARY (footage, its aspect/duration, whether it has speech), getTranscript/scene boundaries on the actual clips, and the project\'s own settings: if the footage is already 9:16 and 45s, that answers aspect and length — do NOT ask about it. Ask ONLY when something that would genuinely change the output cannot be inferred this way: at most 3 short questions, batched into ONE plain-text message (no tool call), asked ONCE for the whole conversation — the turns above are your record of whether you already asked; if you did, do not ask again, infer a sensible default instead and say so in your summary. The questions worth asking, when truly unclear: what must stay CONSISTENT across the cut (a person, brand, or product to lock), target length/platform (only if the footage and brief don\'t already pin it down), and tone/vibe. Phrase it for a lazy user, packing in defaults they can accept in one word, e.g. "On it — keeping it under a minute for Reels, upbeat and punchy, you as the through-line throughout — sound right?" If the user states a target length or platform, call `updateBrief` right away so later turns pace against it. The moment you have an answer (or decided not to ask), GET TO WORK end-to-end without pausing for permission again: cut the footage, add captions, generate whatever graphics/B-roll/AI shots the cut calls for, and add music/voiceover as part of the same run — not a plan you present for approval first.',
		"",
		"COST GATE: any paid action — generate/reroll/compareTake, or an audio add (addVoiceover/addMusicBed) — that would spend more than a small amount pauses for the user's approval; the run stops and asks them out-of-band. This is expected, not an error; do NOT retry the same action to force it through. This is the ONE thing that still stops mid-run — it protects real money, not the user's creative sign-off, so don't treat it as license to ask for approval elsewhere.",
		MODEL_ROUTING_POLICY,
		BUDGET_POLICY,
		"",
		"HONOR THE BRIEF: the DIRECTOR BRIEF below is the user's durable creative intent. Let it shape every prompt you write and every take you pick. When the user states a new preference — or a chosen take reveals one — call updateBrief so it persists for later turns.",
		"CAPTURE, DON'T INTERROGATE: this is about RETAINING facts the user already gave you, not asking for more (the CLARIFY ONCE, THEN BUILD policy above stands — never ask a second round just to fill in the brief). Whenever a brief-relevant fact surfaces naturally in conversation — they name their audience, the platform/format it's for, a tone/vibe, or something that must appear in the cut — call `updateBrief` with it SILENTLY (no tool-call narration, no confirming question) so it rides in every later turn's prompt instead of evaporating after this one.",
		briefBlock(director),
		"",
		'EYES ON INPUT: when the user ATTACHES reference images — style refs (a moodboard, a film still, a product/location shot) and/or a character photo — do NOT plan from words alone. Call `intakeReferences` FIRST with those reference mediaIds (full media ids; see the recent assets in the project info): the model SEES the pixels and derives a StyleBible (palette/lens-mood/setting) that seeds the reel\'s consistency context, and — when a person is the subject — locks & activates a PERSONA so that character recurs across shots. Then pass the returned `bible` into `storyboard` and generate; every shot inherits the referenced look and cast without you restating it. Use it for a plain "make it look like this" / "use this character" ask, not for footage the user wants placed on the timeline (that\'s addClip).',
		"VISION REVIEW: you cannot judge a generated clip from its prompt alone — you must SEE it. Call `reviewTake` to get a slot take's actual frames (first→mid→last) as images, then decide against the slot's prompt:",
		"  · faithful → keep it (chooseTake if it isn't already active); do nothing more.",
		"  · fundamentally wrong shot (wrong subject/scene, missing the point) → fix the prompt with `setPrompt`, then `reroll` for a fresh take.",
		"  · mostly right but one flaw (extra finger, wrong color, missing prop) → `remix` with a SHORT delta prompt to edit it in place, seed-anchored.",
		"Review when the user cares about quality (asks for it to look good/right/best), when a take might be off, or before finishing an important shot — not reflexively after every generation. A separate automatic review may also run for quality-focused turns; it uses the same reviewTake→verdict→fix logic.",
		"WATCH YOUR OWN CUT: `reviewTake` looks at a single slot's SOURCE take before it's placed — it does NOT show you the assembled timeline. Once you've made several edits to the actual TIMELINE (trims, splits, reorders, text, transitions), call `watchBack` with a few seconds to check (an opening, a cut point, the ending) and SEE the composited result before calling the run done — don't assume a cut looks right just because each edit call returned ok.",
		"AUDIO: a reel is not silent. If the brief mentions narration/voiceover, use addVoiceover — pass the narrated shot's slotId so the VO is TIMED to that shot (one VO per shot/beat it narrates). Use addMusicBed for background music/ambience under the whole reel. Do this as part of building the reel, not as an afterthought.",
		"SPEECH-AWARE CUTS: library footage with speech is auto-transcribed (the LIBRARY line reports how many assets have speech). Before you trim or split footage that contains speech, call getTranscript with its mediaId: it returns sentence segments in ASSET-RELATIVE seconds — the same timebase as trim's trimStart/trimEnd — so place cut points AT segment boundaries, never mid-sentence. When choosing which part of a long talking clip to keep, choose by what is SAID (the transcript), not only by how frames look.",
		"SELF-CORRECTION: generation auto-retries transient/provider/timeout errors and auto-rephrases content-safety rejections before giving up. A result that still says a slot 'needs your input' is a genuine dead-end — relay that to the user (with the reason) instead of blindly re-running the same call.",
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
	/** Reopened/ongoing conversation's earlier turns — see the "conversation
	 *  history replay" section above. Prepended AFTER the system prompt, BEFORE
	 *  the current user turn; capped by {@link capHistoryMessages}. */
	priorMessages?: DirectorHistoryMessage[];
	onStep?: (step: AgentToolStep) => void;
	onEvent?: DirectorEventSink;
	signal?: AbortSignal;
}): Promise<AgentRunResult> {
	const { director, userMessage, priorMessages, onStep, onEvent, signal } =
		opts;
	const steps: AgentToolStep[] = [];
	const system = buildFrontierSystemPrompt(director);
	const tools = anthropicToolDefs();
	const messages: Anthropic.MessageParam[] = [
		...capHistoryMessages(priorMessages).map(
			(m): Anthropic.MessageParam => ({ role: m.role, content: m.content }),
		),
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

	/**
	 * On a clean completion, optionally run the vision self-review loop over the
	 * slots this turn generated, appending its steps to the result. Gated on the
	 * user's opt-in ({@link wantsAutoReview}) and skipped when the run paused for
	 * approval (nothing generated to review). Failures here never mask the turn's
	 * own result — auto-review is best-effort polish.
	 */
	async function finalize(result: AgentRunResult): Promise<AgentRunResult> {
		if (result.awaitingApproval) return result;
		// A completed turn under a budget records its final spend on the durable
		// brief, so the budget outcome survives into later sessions. Best-effort:
		// a no-budget reel is a no-op, and this never masks the turn's own result.
		try {
			director.recordFinalSpend();
		} catch {
			/* recording spend must never break a completed turn */
		}
		const settingEnabled =
			useStudioSettingsStore.getState().autoReviewEnabled ?? false;
		if (!wantsAutoReview(userMessage, settingEnabled)) return result;
		const slotIds = collectGeneratedSlotIds(director, result.steps);
		if (slotIds.length === 0) return result;
		const threshold = approvalThreshold();
		const map = reelShortIdMap(director);
		// Reel order + style bible drive CROSS-SHOT continuity: each shot is
		// reviewed against the shot BEFORE it in timeline order, holding the plan's
		// bible. The first shot has no predecessor, so it gets a plain review.
		const reel = director.getReel();
		const order = reel.slots.map((s) => s.id);
		const bible = reel.plan ? styleBibleDescriptors(reel.plan.bible) : "";
		for (const slotId of slotIds) {
			const idx = order.indexOf(slotId);
			const priorSlotId = idx > 0 ? order[idx - 1] : undefined;
			await autoReviewSlot({
				director,
				slotId,
				shortId: map.shorten(slotId),
				threshold,
				steps: result.steps,
				onStep,
				...(priorSlotId ? { priorSlotId } : {}),
				...(bible ? { bible } : {}),
			});
		}
		return result;
	}

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
			return finalize({ finalMessage: textOf(turn.content), steps });
		}

		// Execute EVERY tool_use block in this assistant message, then return
		// ALL results in ONE user message. `input` is already a structured
		// object — never string-parse it.
		const resultBlocks: Anthropic.ContentBlockParam[] = [];
		for (const use of toolUses) {
			if (isAbort(signal)) return cancelledResult();
			const rawArgs = (use.input ?? {}) as Record<string, unknown>;

			// Whole-reel budget gate FIRST: while a budget is active it governs spend
			// (pause / down-route / proceed) in place of the flat threshold, so the
			// Director plans across the reel rather than gating each action alone.
			const budget = await evaluateBudgetGate(director, use.name, rawArgs);
			if (budget.outcome === "pause" && budget.approval) {
				const spend = director.getBudgetStatus().data;
				const message = budgetPauseMessage(
					budget.approval,
					spend?.remainingUsd ?? 0,
				);
				const step: AgentToolStep = {
					action: budget.approval.action,
					args: budget.approval.args,
					ok: false,
					message: `⏸ Over budget — ${message}`,
				};
				steps.push(step);
				onStep?.(step);
				onEvent?.({ type: "awaiting_approval", approval: budget.approval });
				return {
					finalMessage: message,
					steps,
					awaitingApproval: budget.approval,
				};
			}
			if (budget.outcome === "downroute") {
				// Pin the cheaper backend (or drop any premium pin) and tell the user.
				if (budget.backendId) rawArgs.backendId = budget.backendId;
				else delete rawArgs.backendId;
				const drStep: AgentToolStep = {
					action: use.name,
					args: rawArgs,
					ok: true,
					message: `↧ ${budget.note}`,
				};
				steps.push(drStep);
				onStep?.(drStep);
			}

			// Cost-preview approval gate: only when NO budget is active (budget mode
			// supersedes the flat threshold). A gated verb whose estimate crosses the
			// threshold ENDS THE TURN here (fail-closed) BEFORE it spends. The user
			// approves out-of-band; the UI then runs the exact proposed action via
			// `executeDirectorAction`.
			if (budget.outcome === "inactive") {
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

			const { step, content } = await executeTool(director, use.name, rawArgs);
			steps.push(step);
			onStep?.(step);
			onEvent?.({ type: "tool_finish", callId, step });
			toolCalls++;

			// Record the modeled spend against the budget once a budgeted generation
			// actually ran, and surface the running "spent X of $Y" to the panel.
			if (
				(budget.outcome === "proceed" || budget.outcome === "downroute") &&
				step.ok &&
				budget.costUsd > 0
			) {
				const spend = director.recordSpend({ usd: budget.costUsd });
				onEvent?.({
					type: "budget_update",
					spentUsd: spend.spentUsd,
					...(spend.budgetUsd != null ? { budgetUsd: spend.budgetUsd } : {}),
				});
			}

			resultBlocks.push({
				type: "tool_result",
				tool_use_id: use.id,
				content,
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
	return finalize({
		finalMessage:
			lastText ||
			`Stopped after ${MAX_MODEL_CALLS} model turns (${steps.length} tool call(s) executed).`,
		steps,
	});
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
		"PLAN FIRST for multi-shot briefs: if the brief implies more than one shot, use `storyboard` before generating — give each shot a prompt plus intent/camera/subject notes under one shared `bible` (palette, lensMood, setting, characters). It persists the PLAN (shown in the REEL below) and auto-seeds the consistency context, so later shots stay coherent without restating style. For a single quick clip, skip planning and just reserveSlot + generate.",
		"COST GATE: any paid action — generate/reroll/compareTake, or an audio add (addVoiceover/addMusicBed) — that would spend more than a small amount pauses for the user's approval; the run stops and asks them. This is expected, not an error; never retry the same action to force it through.",
		MODEL_ROUTING_POLICY,
		BUDGET_POLICY,
		"",
		"HONOR THE BRIEF: the DIRECTOR BRIEF below is the user's durable creative intent — let it shape every prompt and take. Call updateBrief when the user states a new preference or a chosen take reveals one. Capture facts as they surface (audience, platform, tone, must-include) silently — don't ask extra questions just to fill in the brief.",
		briefBlock(director),
		"AUDIO: a reel is not silent. If the brief mentions narration/voiceover, use addVoiceover with the narrated shot's slotId so the VO is timed to it; use addMusicBed for background music. Generation self-corrects (retries transient errors, rephrases safety rejections); if an OBSERVATION still says a slot 'needs your input', relay that to the user rather than retrying.",
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
 * RETIRED FOR NOW (2026-07-12): the original plain-text ReAct loop over the
 * local Ollama backend. One JSON action per turn, whole system prompt +
 * scratchpad re-sent each step, capped at {@link MAX_STEPS}. No longer routed
 * to by `runDirectorAgent` — with no cloud key the run fails with a clear
 * configuration error instead of degrading to a weak local brain. Kept intact
 * as an export so the privacy-mode path can be revived deliberately later.
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
 *    reports no `ANTHROPIC_API_KEY`, tries the native Gemini brain
 *    (`/api/llm/gemini` — see `agent-gemini.ts`). Each fallback decision
 *    happens on the brain's FIRST relay call, before any tool has run, so no
 *    work is repeated. If BOTH relays report no key, the run fails with a
 *    clear configuration error — the local Ollama fallback is retired for now
 *    (`runDirectorAgentLocal` is kept intact but unrouted).
 *  - `"frontier"`: Claude only — a missing key surfaces as an error.
 *  - `"gemini"`: Gemini only — a missing key surfaces as an error.
 */
export async function runDirectorAgent(opts: {
	director: DirectorApi;
	chat: AgentChatFn;
	userMessage: string;
	/** Reopened/ongoing conversation's earlier turns, routed to whichever brain
	 *  runs (see {@link DirectorHistoryMessage} and the "conversation history
	 *  replay" section above). Ignored by the retired local brain. */
	priorMessages?: DirectorHistoryMessage[];
	onStep?: (step: AgentToolStep) => void;
	/** Live progress sink — reasoning deltas + per-tool start/finish (see {@link DirectorEvent}). */
	onEvent?: DirectorEventSink;
	/** Cooperative cancel — checked between model/tool calls and aborts the in-flight relay fetch. */
	signal?: AbortSignal;
	brain?: "auto" | "frontier" | "gemini";
}): Promise<AgentRunResult> {
	const brain = opts.brain ?? "auto";
	if (brain === "gemini") return runDirectorAgentGemini(opts);
	try {
		return await runDirectorAgentFrontier(opts);
	} catch (error) {
		if (brain === "auto" && error instanceof AnthropicKeyMissingError) {
			try {
				return await runDirectorAgentGemini(opts);
			} catch (geminiError) {
				if (geminiError instanceof GeminiKeyMissingError) {
					// Local Ollama fallback retired for now — fail loud and
					// actionable rather than degrading to a weak local brain.
					throw new Error(
						"No Director brain is configured. Set ANTHROPIC_API_KEY (Claude) or GEMINI_API_KEY (Gemini) in apps/web/.env.local.",
					);
				}
				throw geminiError;
			}
		}
		throw error;
	}
}

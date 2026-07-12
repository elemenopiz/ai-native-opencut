/**
 * The NATIVE Gemini Director brain — a sibling of `agent.ts`'s frontier loop
 * that speaks Gemini's own dialect end to end: `contents` history with
 * user/model roles, `functionCall`/`functionResponse` parts, function
 * declarations in Gemini's OpenAPI-subset schema, and Gemini's native SSE
 * stream. NO Anthropic-shape translation happens anywhere on this path — the
 * point is to let Gemini perform as itself (translation layers tax a model:
 * lossy schema down-conversion, prompts tuned for another model's habits).
 *
 * ARCHITECTURE — same split as the frontier brain:
 *   browser (this file)                      server
 *   ┌─────────────────────────────┐          ┌────────────────────────────┐
 *   │ runDirectorAgentGemini      │  POST    │ /api/llm/gemini (route.ts) │
 *   │  · contents[] history       │ ───────► │  · pure stateless relay    │
 *   │  · native functionCall loop │ ◄─────── │  · one generateContent per │
 *   │  · executes calls against   │  SSE     │    call, key from env      │
 *   │    DirectorApi              │          │  · runs NO loop, NO tools  │
 *   └─────────────────────────────┘          └────────────────────────────┘
 *
 * Everything BELOW the model transport is shared with the frontier brain by
 * importing it from `agent.ts`: the verb executor (`executeTool`), the budget
 * and approval gates, the event vocabulary ({@link DirectorEvent}), the prompt
 * grounding blocks, and the auto-review loop — so the two brains differ ONLY in
 * how the model is addressed, never in what the tools do or what spend is
 * allowed. (`agent.ts` imports this module's entry point for brain routing; the
 * cycle is deliberate and call-time-only.)
 *
 * Gemini specifics this loop owns:
 *  - `functionResponse` parts are keyed by function NAME (Gemini has no call
 *    ids); parallel calls in one turn are answered with multiple
 *    functionResponse parts, in call order, in ONE user turn.
 *  - `thoughtSignature`s on returned parts are preserved verbatim in the
 *    history — Gemini 3-class models require them to be echoed back when
 *    function calling spans turns. Unsigned thought summaries are streamed to
 *    the panel as `thinking_delta`s but kept OUT of the history (they are
 *    display-only).
 *  - `reviewTake` frames ride back as `inlineData` image parts alongside the
 *    functionResponse, so the model SEES the take natively.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { DirectorApi } from "./director-api";
import { styleBibleDescriptors } from "./storyboard-plan";
import { useStudioSettingsStore } from "@/stores/studio-settings-store";
import {
	approvalMessage,
	approvalThreshold,
	autoReviewSlot,
	budgetPauseMessage,
	buildFrontierSystemPrompt,
	collectGeneratedSlotIds,
	evaluateApprovalGate,
	evaluateBudgetGate,
	executeTool,
	isAbort,
	MAX_MODEL_CALLS,
	MAX_TOOL_CALLS,
	previewToolCost,
	reelShortIdMap,
	type AgentRunResult,
	type AgentToolStep,
	type CritiqueFn,
	type DirectorEventSink,
} from "./agent";
import { toGeminiDeclarations } from "./tool-catalog";
import {
	buildCriticSystemPrompt,
	buildCriticUserBlocks,
	parseVerdict,
	wantsAutoReview,
} from "./vision-critic";

/** The browser-side endpoint of the stateless native-Gemini relay. */
const GEMINI_RELAY_URL = "/api/llm/gemini";

// ── native Gemini wire shapes (v1beta) ───────────────────────────────────────

/** One part of a Gemini content turn — text, media, or a function call/reply. */
export interface GeminiPart {
	text?: string;
	/** True on model "thought summary" parts (display-only unless signed). */
	thought?: boolean;
	/** Opaque reasoning signature — MUST be echoed back verbatim in history. */
	thoughtSignature?: string;
	functionCall?: { name: string; args?: Record<string, unknown> };
	functionResponse?: { name: string; response: Record<string, unknown> };
	inlineData?: { mimeType: string; data: string };
}

/** One turn in a Gemini `contents` history. */
export interface GeminiContent {
	role: "user" | "model";
	parts: GeminiPart[];
}

/** The model slice of one `generateContent` response the loop consumes. */
export interface GeminiTurn {
	parts: GeminiPart[];
	finishReason?: string;
	/** Set when the PROMPT was blocked (`promptFeedback.blockReason`). */
	blockReason?: string;
}

/** The subset of a streamed/whole `GenerateContentResponse` the loop reads. */
interface GenerateContentChunk {
	candidates?: Array<{
		content?: { parts?: GeminiPart[] };
		finishReason?: string;
	}>;
	promptFeedback?: { blockReason?: string };
}

/** Thrown when the relay reports that GEMINI_API_KEY is not configured — the signal to fall on to the next brain. */
export class GeminiKeyMissingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GeminiKeyMissingError";
	}
}

/** Live-delta callback: fires per text/thought chunk while a turn streams. */
type GeminiDeltaFn = (kind: "text" | "thinking", text: string) => void;

// ── relay transport ──────────────────────────────────────────────────────────

/**
 * One native model round-trip through `/api/llm/gemini`. The relay holds the
 * key and forwards exactly one `generateContent` — no loop, no tools run
 * server-side. Transport is Gemini's own SSE (`streamGenerateContent?alt=sse`
 * passed through by the relay): thought/text deltas fire `onDelta` live, and
 * the accumulated parts + finishReason form the turn. Pre-stream failures
 * (no key, 4xx) come back as JSON and are surfaced as typed errors.
 */
export async function callGeminiRelay(request: {
	contents: GeminiContent[];
	system: string;
	tools: Array<{ functionDeclarations: unknown[] }>;
	toolConfig?: { functionCallingConfig: { mode: "AUTO" | "ANY" | "NONE" } };
	signal?: AbortSignal;
	onDelta?: GeminiDeltaFn;
}): Promise<GeminiTurn> {
	const res = await fetch(GEMINI_RELAY_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "text/event-stream",
		},
		body: JSON.stringify({
			contents: request.contents,
			systemInstruction: { parts: [{ text: request.system }] },
			tools: request.tools,
			...(request.toolConfig ? { toolConfig: request.toolConfig } : {}),
			stream: true,
		}),
		signal: request.signal,
	});

	// Non-OK (or a non-stream JSON body, e.g. the no-key 503) → parse as JSON.
	const contentType = res.headers.get("content-type") ?? "";
	if (!res.ok || !contentType.includes("text/event-stream")) {
		const body = (await res.json().catch(() => null)) as
			| (GenerateContentChunk & { error?: string; message?: string })
			| null;
		if (!res.ok) {
			if (body?.error === "gemini_not_configured") {
				throw new GeminiKeyMissingError(
					body.message ?? "GEMINI_API_KEY is not configured on the server.",
				);
			}
			throw new Error(
				`Gemini relay error (${res.status}): ${body?.message ?? body?.error ?? "unknown error"}`,
			);
		}
		// Defensive: a whole (non-streamed) GenerateContentResponse body.
		if (!body || !Array.isArray(body.candidates)) {
			throw new Error(
				"Gemini relay error: malformed response (no candidates).",
			);
		}
		const turn = emptyTurn();
		foldChunk(turn, body);
		return turn;
	}

	return await consumeGeminiStream(res, request.onDelta);
}

/** A fresh, empty accumulating turn. */
function emptyTurn(): GeminiTurn {
	return { parts: [] };
}

/**
 * Fold one streamed `GenerateContentResponse` chunk into the accumulating
 * turn: text parts merge into runs, functionCall/media parts append verbatim,
 * and the last non-empty finishReason wins. Fires `onDelta` per text part
 * (`thought: true` → thinking). Unsigned thought parts are DISPLAY-ONLY: they
 * stream to the panel but stay out of `parts` (only signature-bearing parts
 * must survive into history).
 */
function foldChunk(
	turn: GeminiTurn,
	chunk: GenerateContentChunk,
	onDelta?: GeminiDeltaFn,
): void {
	if (chunk.promptFeedback?.blockReason) {
		turn.blockReason = chunk.promptFeedback.blockReason;
	}
	const cand = chunk.candidates?.[0];
	if (!cand) return;
	if (cand.finishReason) turn.finishReason = cand.finishReason;
	for (const part of cand.content?.parts ?? []) {
		if (typeof part.text === "string") {
			onDelta?.(part.thought ? "thinking" : "text", part.text);
			if (part.thought && !part.thoughtSignature) continue;
			const last = turn.parts[turn.parts.length - 1];
			const mergeable =
				last &&
				typeof last.text === "string" &&
				!last.functionCall &&
				!last.thoughtSignature &&
				!part.thoughtSignature &&
				Boolean(last.thought) === Boolean(part.thought);
			if (mergeable) last.text += part.text;
			else turn.parts.push({ ...part });
			continue;
		}
		// functionCall / inlineData / signed non-text parts — keep verbatim
		// (thoughtSignatures included, they must round-trip).
		turn.parts.push(part);
	}
}

/**
 * Parse Gemini's native `alt=sse` body: frames are bare `data: <json>` lines
 * (no `event:` field), separated by blank lines (CRLF from Google's edge).
 */
async function consumeGeminiStream(
	res: Response,
	onDelta?: GeminiDeltaFn,
): Promise<GeminiTurn> {
	if (!res.body) throw new Error("Gemini relay error: empty stream body.");
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	const turn = emptyTurn();
	let buffer = "";

	const handleFrame = (frame: string) => {
		let data = "";
		for (const line of frame.split("\n")) {
			if (line.startsWith("data:")) data += line.slice(5).trim();
		}
		if (!data) return;
		foldChunk(turn, JSON.parse(data) as GenerateContentChunk, onDelta);
	};

	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		buffer = buffer.replace(/\r\n/g, "\n");
		let sep: number;
		while ((sep = buffer.indexOf("\n\n")) !== -1) {
			const frame = buffer.slice(0, sep);
			buffer = buffer.slice(sep + 2);
			if (frame.trim()) handleFrame(frame);
		}
	}
	if (buffer.trim()) handleFrame(buffer);

	return turn;
}

// ── prompt + content helpers ─────────────────────────────────────────────────

/**
 * System prompt for the Gemini brain — the per-brain prompt variant seam. The
 * shared Director doctrine (verbs, policies, grounding blocks) is byte-identical
 * to the frontier prompt (none of it is Claude-specific), and a Gemini-specific
 * tooling block is appended: Gemini's function calling benefits from explicit
 * "use the function mechanism, don't narrate" guidance where Claude needs none.
 * Tune Gemini-only prosody HERE, not in `buildFrontierSystemPrompt`.
 */
export function buildGeminiSystemPrompt(director: DirectorApi): string {
	return [
		buildFrontierSystemPrompt(director),
		"",
		"FUNCTION CALLING (how to act): every tool above is exposed to you as a native function declaration — invoke functions through the function-calling mechanism ONLY, never by writing JSON or code in your text reply. Issue INDEPENDENT calls in parallel within one turn; put DEPENDENT steps (storyboard, then generate the new slots) in separate turns so you can read the ids from the function responses first. When no editing is needed, reply in plain text with no function call.",
	].join("\n");
}

/** Join a turn's answer text (non-thought text parts) into the user-facing message. */
export function textOfParts(parts: GeminiPart[]): string {
	return parts
		.filter((p) => typeof p.text === "string" && !p.thought)
		.map((p) => p.text)
		.join("\n")
		.trim();
}

/**
 * Build the functionResponse part for one executed call — keyed by function
 * NAME (Gemini has no call ids) — plus any `inlineData` image parts the tool
 * returned (reviewTake frames), which ride in the SAME user turn so the model
 * sees them next to the response they belong to.
 */
function functionResponseParts(
	name: string,
	ok: boolean,
	content: string | Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam>,
): { response: GeminiPart; images: GeminiPart[] } {
	let text: string;
	const images: GeminiPart[] = [];
	if (typeof content === "string") {
		text = content;
	} else {
		text = content
			.filter((b): b is Anthropic.TextBlockParam => b.type === "text")
			.map((b) => b.text)
			.join("\n");
		for (const b of content) {
			// Only base64 sources exist on this path (`dataUrlToImageBlock`); a URL
			// source can't be inlined without a fetch, so it is skipped defensively.
			if (b.type === "image" && b.source.type === "base64") {
				images.push({
					inlineData: { mimeType: b.source.media_type, data: b.source.data },
				});
			}
		}
	}
	return {
		response: {
			functionResponse: {
				name,
				response: ok ? { result: text } : { error: text },
			},
		},
		images,
	};
}

/** Finish reasons that mean the model refused / was blocked outright. */
const GEMINI_REFUSALS = new Set([
	"SAFETY",
	"PROHIBITED_CONTENT",
	"BLOCKLIST",
	"SPII",
]);

/**
 * Gemini-native critic for the auto-review loop: same prompts, same verdict
 * grammar as the relay critic in `agent.ts`, but the frames go through the
 * Gemini relay — so a Gemini-brained session never needs an Anthropic key for
 * its vision review. The critic user blocks come back Anthropic-shaped from
 * `buildCriticUserBlocks` (they're plain text/image data), so this converts
 * them to native parts at the boundary.
 */
const geminiCritique: CritiqueFn = async (intent, frames, context) => {
	const parts: GeminiPart[] = buildCriticUserBlocks(
		intent,
		frames,
		context,
	).map((b) =>
		b.type === "image" && b.source.type === "base64"
			? {
					inlineData: {
						mimeType: b.source.media_type,
						data: b.source.data,
					},
				}
			: { text: b.type === "text" ? b.text : "" },
	);
	const turn = await callGeminiRelay({
		contents: [{ role: "user", parts }],
		system: buildCriticSystemPrompt(Boolean(context?.priorFrame)),
		tools: [],
	});
	return parseVerdict(textOfParts(turn.parts));
};

// ── the loop ─────────────────────────────────────────────────────────────────

/**
 * The Gemini agent loop: browser-held `contents` history, one relay call per
 * model turn, ALL functionCall parts of a turn executed here and answered with
 * functionResponse parts (keyed by name, in call order) in ONE user turn,
 * until a plain-text close or a ceiling. Gate semantics, events, ceilings, and
 * auto-review are identical to the frontier loop — shared code, not parallel
 * re-implementations, wherever the transport allows.
 */
export async function runDirectorAgentGemini(opts: {
	director: DirectorApi;
	userMessage: string;
	onStep?: (step: AgentToolStep) => void;
	onEvent?: DirectorEventSink;
	signal?: AbortSignal;
}): Promise<AgentRunResult> {
	const { director, userMessage, onStep, onEvent, signal } = opts;
	const steps: AgentToolStep[] = [];
	const system = buildGeminiSystemPrompt(director);
	const tools = [{ functionDeclarations: toGeminiDeclarations() }];
	const contents: GeminiContent[] = [
		{ role: "user", parts: [{ text: userMessage }] },
	];

	let toolCalls = 0;
	let wrapUp = false; // set when the tool budget is spent → force a text-only close
	let lastText = "";
	let callCounter = 0; // seeds tool_start/tool_finish callIds

	// Cooperative cancel — same contract as the frontier loop: completed tool
	// steps have already mutated the editor, so we keep them and just stop.
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
	 * Clean-completion hook: record final spend, then (opt-in) run the vision
	 * self-review over the slots this turn generated — with the GEMINI critic,
	 * so review never depends on another provider's key. Mirrors the frontier
	 * loop's finalize.
	 */
	async function finalize(result: AgentRunResult): Promise<AgentRunResult> {
		if (result.awaitingApproval) return result;
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
				critique: geminiCritique,
				...(priorSlotId ? { priorSlotId } : {}),
				...(bible ? { bible } : {}),
			});
		}
		return result;
	}

	for (let call = 0; call < MAX_MODEL_CALLS; call++) {
		if (isAbort(signal)) return cancelledResult();

		let turn: GeminiTurn;
		try {
			turn = await callGeminiRelay({
				contents,
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
					? { toolConfig: { functionCallingConfig: { mode: "NONE" as const } } }
					: {}),
			});
		} catch (err) {
			if (isAbort(signal, err)) return cancelledResult();
			throw err;
		}

		// Blocked prompt / refused candidate — can carry no usable parts.
		if (
			turn.blockReason ||
			(turn.finishReason && GEMINI_REFUSALS.has(turn.finishReason))
		) {
			return {
				finalMessage:
					"The model declined this request. Try rephrasing what you want the Director to do.",
				steps,
			};
		}

		// Append the model turn verbatim (thoughtSignatures included — they must
		// be echoed back unchanged on subsequent calls).
		contents.push({ role: "model", parts: turn.parts });
		lastText = textOfParts(turn.parts) || lastText;

		const functionCalls = turn.parts.filter(
			(
				p,
			): p is GeminiPart & {
				functionCall: { name: string; args?: Record<string, unknown> };
			} => Boolean(p.functionCall),
		);
		if (functionCalls.length === 0) {
			// Plain-text close (STOP or MAX_TOKENS) — we're done.
			return finalize({ finalMessage: textOfParts(turn.parts), steps });
		}

		// Execute EVERY functionCall part in this model turn, then return ALL
		// functionResponse parts (keyed by NAME, in call order) in ONE user turn.
		const responseParts: GeminiPart[] = [];
		const imageParts: GeminiPart[] = [];
		for (const part of functionCalls) {
			if (isAbort(signal)) return cancelledResult();
			const name = part.functionCall.name;
			const rawArgs: Record<string, unknown> = {
				...(part.functionCall.args ?? {}),
			};

			// Whole-reel budget gate FIRST (identical semantics to the frontier loop).
			const budget = await evaluateBudgetGate(director, name, rawArgs);
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
				if (budget.backendId) rawArgs.backendId = budget.backendId;
				else delete rawArgs.backendId;
				const drStep: AgentToolStep = {
					action: name,
					args: rawArgs,
					ok: true,
					message: `↧ ${budget.note}`,
				};
				steps.push(drStep);
				onStep?.(drStep);
			}

			// Flat cost-preview approval gate — only when NO budget is active.
			if (budget.outcome === "inactive") {
				const approval = evaluateApprovalGate(director, name, rawArgs);
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

			const callId = `g${callCounter++}`;
			onEvent?.({
				type: "tool_start",
				callId,
				action: name,
				args: rawArgs,
				cost: previewToolCost(director, name, rawArgs),
			});

			const { step, content } = await executeTool(director, name, rawArgs);
			steps.push(step);
			onStep?.(step);
			onEvent?.({ type: "tool_finish", callId, step });
			toolCalls++;

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

			const { response, images } = functionResponseParts(
				name,
				step.ok,
				content,
			);
			responseParts.push(response);
			imageParts.push(...images);
		}

		if (toolCalls >= MAX_TOOL_CALLS && !wrapUp) {
			// Ceiling hit: deliver the results, then force a text-only close (the
			// next call carries functionCallingConfig mode NONE).
			wrapUp = true;
			responseParts.push({
				text: "You have used the tool budget for this turn. Reply with a final plain-text summary of what you did and what (if anything) is left.",
			});
		}
		contents.push({ role: "user", parts: [...responseParts, ...imageParts] });
	}

	// Model-call ceiling hit without a clean close — surface the best text we saw.
	return finalize({
		finalMessage:
			lastText ||
			`Stopped after ${MAX_MODEL_CALLS} model turns (${steps.length} tool call(s) executed).`,
		steps,
	});
}

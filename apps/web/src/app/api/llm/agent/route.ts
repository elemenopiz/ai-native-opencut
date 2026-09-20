/**
 * POST /api/llm/agent — stateless server relay for the Director agent's
 * frontier brain (Claude native tool-calling).
 *
 * WHY THIS SHAPE: the Director's tools mutate CLIENT-SIDE editor state
 * (Zustand stores, the timeline), so the agentic loop and all tool execution
 * live in the browser (`src/lib/director/agent.ts`). The Anthropic API key,
 * however, must never reach the client — so this route is a pure relay: the
 * browser posts `{ messages, system, tools, ... }`, we forward ONE
 * `client.messages.create(...)` with the server-side key, and return the
 * assistant message (`content`, `stop_reason`, `model`, `usage`) as JSON.
 * This route runs NO loop and executes NO tools.
 *
 * Config (see `.env.example`):
 *  - `ANTHROPIC_API_KEY` (server-only, required) — when unset we return a 503
 *    with `error: "anthropic_not_configured"`, which the client agent detects
 *    and uses to fall back to the local Ollama brain (privacy mode).
 *  - `DIRECTOR_MODEL` (optional) — model override; defaults to claude-opus-5.
 */

import { NextResponse } from "next/server";
import { headers } from "next/headers";
import Anthropic from "@anthropic-ai/sdk";
import { webEnv } from "@byorn/env/web";
import { auth } from "@/lib/auth/server";
import { aiAccessDeniedResponse, hasAiAccess } from "@/lib/ai-access";
import { enforceRateLimit } from "@/lib/rate-limit";
import { isOwnerEmail } from "@/lib/credits/signup-grant";
import { logger } from "@/lib/observability/logger";
import {
	DIRECTOR_BURST_LIMIT_MESSAGE,
	DIRECTOR_DAILY_LIMIT_MESSAGE,
} from "@/lib/director/free-tier-copy";

export const runtime = "nodejs";
export const maxDuration = 120;

/** Default model for the Director brain; override with DIRECTOR_MODEL. */
const DEFAULT_MODEL = "claude-opus-5";

/**
 * Kimi (Moonshot) as the Director brain — used when `MOONSHOT_API_KEY` is set.
 * Moonshot exposes an Anthropic-compatible endpoint, so the same
 * `@anthropic-ai/sdk` client drives it with only a `baseURL` swap; native
 * tool-calling works identically (verified: returns `stop_reason: "tool_use"`).
 * This is the zero-setup brain — no Anthropic key, MCP, or Claude Desktop.
 * Override the model with `DIRECTOR_MODEL` (e.g. `kimi-k2.7-code`).
 */
const KIMI_BASE_URL = "https://api.moonshot.ai/anthropic";
const DEFAULT_KIMI_MODEL = "kimi-k2.6";

/** Non-streaming per-turn output budget (thinking + text + tool calls). */
const DEFAULT_MAX_TOKENS = 16000;

/** Hard ceiling on caller-requested output — this relay bills the server's own
 *  provider key, so an unbounded `max_tokens` is a cost-abuse lever. Equal to
 *  DEFAULT_MAX_TOKENS (16k, a sane budget for one orchestration turn: reasoning
 *  + a handful of tool calls) so a caller can no longer request DOUBLE the
 *  intended per-turn spend — this IS the ceiling, not a generous headroom
 *  above it. */
const MAX_OUTPUT_TOKENS = 16000;

/** The request body the browser-side agent loop sends for one model turn. */
interface AgentRelayRequest {
	messages: Anthropic.MessageParam[];
	system?: string;
	tools?: Anthropic.Tool[];
	tool_choice?: Anthropic.ToolChoice;
	model?: string;
	thinking?: Anthropic.ThinkingConfigParam;
	max_tokens?: number;
	/**
	 * When true, the response is a `text/event-stream` (SSE) instead of one JSON
	 * body: the relay forwards the model's text/thinking deltas live as `delta`
	 * events, then a single authoritative `final` event carrying the same
	 * `{ content, stop_reason, model, usage }` shape the non-streaming path
	 * returns. This is what lets the Director panel render reasoning as it's
	 * produced; the loop logic (message shapes, tool handling) is unchanged.
	 */
	stream?: boolean;
}

export async function POST(req: Request) {
	// Provider selection: prefer Kimi (Moonshot) when its key is present — the
	// zero-setup Director brain — otherwise fall back to Anthropic.
	const moonshotKey = webEnv.MOONSHOT_API_KEY;
	const anthropicKey = webEnv.ANTHROPIC_API_KEY;
	const useKimi = Boolean(moonshotKey);
	const apiKey = useKimi ? moonshotKey : anthropicKey;

	// Visibility only — does NOT change the precedence above. MOONSHOT_API_KEY
	// silently wins when both keys are set, so an operator with both configured
	// would otherwise believe they're running Claude while actually on Kimi.
	// This line makes the actual selection (and whether it was contested by a
	// second configured key) show up in the server log, without ever surfacing
	// provider/env names on any customer-facing response.
	if (moonshotKey || anthropicKey) {
		logger.info("llm/agent: director brain selected", {
			brain: useKimi ? "kimi" : "anthropic",
			moonshotKeyConfigured: Boolean(moonshotKey),
			anthropicKeyConfigured: Boolean(anthropicKey),
		});
	}

	if (!apiKey) {
		// Deliberate, machine-readable "no key" signal — the client agent falls
		// back to the local Ollama brain on this exact error code.
		return NextResponse.json(
			{
				error: "anthropic_not_configured",
				message:
					"No Director brain key configured. Set MOONSHOT_API_KEY (Kimi) or ANTHROPIC_API_KEY in apps/web/.env.local.",
			},
			{ status: 503 },
		);
	}

	// A provider key IS configured, so this relay bills our key — require a
	// signed-in user. (Placed AFTER the no-key check so a self-hosted instance
	// with no key still returns the 503 the client uses to fall back to local
	// Ollama, rather than a 401 that blocks the privacy path for anonymous users.)
	const session = await auth.api.getSession({ headers: await headers() });
	if (!session?.user) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}
	if (!hasAiAccess(session.user)) return aiAccessDeniedResponse();

	// Cap paid relay calls per account (both burst and daily volume). Owner
	// accounts (see OWNER_EMAILS) are exempt from the free-tier cap — they
	// still authenticate normally, this only skips the rate check.
	if (!isOwnerEmail(session.user.email)) {
		const limited = await enforceRateLimit({
			name: "llm:agent",
			request: req,
			userId: session.user.id,
			dailyMessage: DIRECTOR_DAILY_LIMIT_MESSAGE,
			minuteMessage: DIRECTOR_BURST_LIMIT_MESSAGE,
		});
		if (limited) return limited;
	}

	let body: AgentRelayRequest;
	try {
		body = (await req.json()) as AgentRelayRequest;
	} catch {
		return NextResponse.json(
			{ error: "bad_request", message: "Request body must be JSON." },
			{ status: 400 },
		);
	}
	if (!Array.isArray(body.messages) || body.messages.length === 0) {
		return NextResponse.json(
			{
				error: "bad_request",
				message: "`messages` must be a non-empty array.",
			},
			{ status: 400 },
		);
	}

	const client = new Anthropic({
		apiKey,
		...(useKimi ? { baseURL: KIMI_BASE_URL } : {}),
	});

	// The create params are identical for streaming and non-streaming — only the
	// transport differs — so build them once and feed both `messages.create` and
	// `messages.stream`.
	const createParams: Anthropic.MessageCreateParamsNonStreaming = {
		model:
			body.model?.trim() ||
			webEnv.DIRECTOR_MODEL.trim() ||
			(useKimi ? DEFAULT_KIMI_MODEL : DEFAULT_MODEL),
		max_tokens: Math.min(
			// Treat 0/negative/NaN as "unset" so a bad caller value can't be sent
			// straight through to the provider as an invalid max_tokens.
			body.max_tokens && body.max_tokens > 0
				? body.max_tokens
				: DEFAULT_MAX_TOKENS,
			MAX_OUTPUT_TOKENS,
		),
		// Adaptive thinking + high effort are Opus-4.8 knobs (budget_tokens /
		// temperature / top_p / top_k all 400 there). Kimi's Anthropic-compatible
		// endpoint is cleanest WITHOUT them — no thinking blocks to echo back
		// through the multi-turn tool loop — so send them only for Anthropic.
		...(useKimi
			? {}
			: {
					thinking: body.thinking ?? { type: "adaptive" },
					output_config: { effort: "high" },
				}),
		...(body.system ? { system: body.system } : {}),
		messages: body.messages,
		...(body.tools?.length ? { tools: body.tools } : {}),
		...(body.tool_choice ? { tool_choice: body.tool_choice } : {}),
	};

	// ── Streaming transport (SSE) ────────────────────────────────────────────
	// Forward the model's text/thinking deltas to the browser as they arrive so
	// the Director panel can render reasoning live, then emit ONE `final` event
	// with the complete assistant turn (same shape the JSON path returns) so the
	// client's agent loop needs no block reconstruction. Errors after headers are
	// flushed can only be surfaced as an in-band `error` event.
	if (body.stream) {
		const encoder = new TextEncoder();

		// Client-cancel → stop billing. When the browser aborts the request (the
		// user hits Stop), the Anthropic stream would otherwise keep running to
		// completion on OUR key — we'd pay for tokens nobody reads. Funnel every
		// disconnect signal (the request's own AbortSignal AND the response
		// stream's `cancel`) into one controller and abort the upstream request,
		// so a Stop halts the server-side spend, not just the client's reading.
		const upstream = new AbortController();
		const onClientAbort = () => upstream.abort();
		if (req.signal.aborted) upstream.abort();
		else req.signal.addEventListener("abort", onClientAbort);

		const rs = new ReadableStream<Uint8Array>({
			start(controller) {
				let closed = false;
				const send = (event: string, data: unknown) => {
					if (closed) return;
					try {
						controller.enqueue(
							encoder.encode(
								`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
							),
						);
					} catch {
						// Consumer already went away — stop trying to write.
						closed = true;
					}
				};
				void (async () => {
					try {
						const streamed = client.messages.stream(createParams, {
							signal: upstream.signal,
						});
						streamed.on("text", (delta) =>
							send("delta", { kind: "text", text: delta }),
						);
						streamed.on("thinking", (delta) =>
							send("delta", { kind: "thinking", text: delta }),
						);
						const final = await streamed.finalMessage();
						send("final", {
							content: final.content,
							stop_reason: final.stop_reason,
							model: final.model,
							usage: final.usage,
						});
						send("done", {});
					} catch (error) {
						// A client-initiated abort is not an error to report — the
						// connection is gone, so there's nothing (and no one) to send to.
						if (upstream.signal.aborted) return;
						send("error", {
							error:
								error instanceof Anthropic.APIError
									? "anthropic_api_error"
									: "relay_error",
							message:
								error instanceof Error ? error.message : "Unknown relay error.",
						});
					} finally {
						req.signal.removeEventListener("abort", onClientAbort);
						closed = true;
						try {
							controller.close();
						} catch {
							// Already closed (e.g. the consumer cancelled) — ignore.
						}
					}
				})();
			},
			// The consumer (client) tore down the response — abort upstream too.
			cancel() {
				upstream.abort();
			},
		});
		return new Response(rs, {
			headers: {
				"Content-Type": "text/event-stream; charset=utf-8",
				"Cache-Control": "no-cache, no-transform",
				Connection: "keep-alive",
				// Disable proxy buffering (nginx) so deltas flush immediately.
				"X-Accel-Buffering": "no",
			},
		});
	}

	// ── Non-streaming transport (JSON) ───────────────────────────────────────
	try {
		const response = await client.messages.create(createParams);

		return NextResponse.json({
			content: response.content,
			stop_reason: response.stop_reason,
			model: response.model,
			usage: response.usage,
		});
	} catch (error) {
		if (error instanceof Anthropic.APIError) {
			return NextResponse.json(
				{ error: "anthropic_api_error", message: error.message },
				{ status: typeof error.status === "number" ? error.status : 502 },
			);
		}
		return NextResponse.json(
			{
				error: "relay_error",
				message:
					error instanceof Error ? error.message : "Unknown relay error.",
			},
			{ status: 502 },
		);
	}
}

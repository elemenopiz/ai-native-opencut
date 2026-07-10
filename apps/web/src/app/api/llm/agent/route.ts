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
 *  - `DIRECTOR_MODEL` (optional) — model override; defaults to claude-opus-4-8.
 */

import { NextResponse } from "next/server";
import { headers } from "next/headers";
import Anthropic from "@anthropic-ai/sdk";
import { auth } from "@/lib/auth/server";
import { enforceRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

/** Default model for the Director brain; override with DIRECTOR_MODEL. */
const DEFAULT_MODEL = "claude-opus-4-8";

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
 *  provider key, so an unbounded `max_tokens` is a cost-abuse lever. */
const MAX_OUTPUT_TOKENS = 32000;

/** The request body the browser-side agent loop sends for one model turn. */
interface AgentRelayRequest {
	messages: Anthropic.MessageParam[];
	system?: string;
	tools?: Anthropic.Tool[];
	tool_choice?: Anthropic.ToolChoice;
	model?: string;
	thinking?: Anthropic.ThinkingConfigParam;
	max_tokens?: number;
}

export async function POST(req: Request) {
	// Provider selection: prefer Kimi (Moonshot) when its key is present — the
	// zero-setup Director brain — otherwise fall back to Anthropic.
	const moonshotKey = process.env.MOONSHOT_API_KEY;
	const anthropicKey = process.env.ANTHROPIC_API_KEY;
	const useKimi = Boolean(moonshotKey);
	const apiKey = useKimi ? moonshotKey : anthropicKey;
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

	// Cap paid relay calls per account (both burst and daily volume).
	const limited = await enforceRateLimit({
		name: "llm:agent",
		request: req,
		userId: session.user.id,
	});
	if (limited) return limited;

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
	try {
		const response = await client.messages.create({
			model:
				body.model?.trim() ||
				process.env.DIRECTOR_MODEL?.trim() ||
				(useKimi ? DEFAULT_KIMI_MODEL : DEFAULT_MODEL),
			max_tokens: Math.min(
				body.max_tokens ?? DEFAULT_MAX_TOKENS,
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
		});

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

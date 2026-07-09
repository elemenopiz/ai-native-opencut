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
import Anthropic from "@anthropic-ai/sdk";

export const runtime = "nodejs";

/** Default model for the Director brain; override with DIRECTOR_MODEL. */
const DEFAULT_MODEL = "claude-opus-4-8";

/** Non-streaming per-turn output budget (thinking + text + tool calls). */
const DEFAULT_MAX_TOKENS = 16000;

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
	const apiKey = process.env.ANTHROPIC_API_KEY;
	if (!apiKey) {
		// Deliberate, machine-readable "no key" signal — the client agent falls
		// back to the local Ollama brain on this exact error code.
		return NextResponse.json(
			{
				error: "anthropic_not_configured",
				message:
					"ANTHROPIC_API_KEY is not set on the server. Add it to apps/web/.env.local to enable the frontier Director brain.",
			},
			{ status: 503 },
		);
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

	const client = new Anthropic({ apiKey });
	try {
		const response = await client.messages.create({
			model:
				body.model?.trim() ||
				process.env.DIRECTOR_MODEL?.trim() ||
				DEFAULT_MODEL,
			max_tokens: body.max_tokens ?? DEFAULT_MAX_TOKENS,
			// Adaptive thinking + high effort — the supported knobs on Opus 4.8
			// (budget_tokens / temperature / top_p / top_k all 400 there).
			thinking: body.thinking ?? { type: "adaptive" },
			output_config: { effort: "high" },
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

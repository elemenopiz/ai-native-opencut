/**
 * POST /api/llm/gemini — stateless server relay for the NATIVE Gemini Director
 * brain (`src/lib/director/agent-gemini.ts`).
 *
 * WHY THIS SHAPE: the sibling of `/api/llm/agent` (read that route's header for
 * the client-loop/server-relay split). The one deliberate difference: this
 * relay is a PASSTHROUGH in Gemini's own dialect — the browser posts a native
 * `generateContent` body (`contents`, `systemInstruction`, `tools`,
 * `toolConfig`, `generationConfig`), we forward exactly ONE
 * `generateContent` (or `streamGenerateContent?alt=sse` when `stream: true`)
 * with the server-side key, and return Gemini's response/SSE untranslated. No
 * dialect adapter exists on purpose: a translation layer taxes the model
 * (lossy schema down-conversion, foreign prompt habits), and the whole point
 * of this brain is maximizing Gemini's native performance. This route runs NO
 * loop and executes NO tools.
 *
 * Config (see `.env.example`):
 *  - `GEMINI_API_KEY` (server-only, required) — when unset we return a 503
 *    with `error: "gemini_not_configured"`, which the client agent detects and
 *    uses to fall on to the next brain (local Ollama, ultimately).
 *  - `GEMINI_BASE_URL` (optional) — API base override; defaults to the public
 *    Gemini API (same convention as the Veo/Imagen studio backends).
 *  - `DIRECTOR_MODEL` (optional) — honored ONLY when it names a gemini model;
 *    a Claude/Kimi id configured for the sibling relay is ignored here.
 */

import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { webEnv } from "@byorn/env/web";
import { auth } from "@/lib/auth/server";
import { enforceRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

/** Default model for the native Gemini Director brain; override with DIRECTOR_MODEL. */
const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash";

/** Public Gemini API base (same default the studio's Veo/Imagen adapters use). */
const DEFAULT_GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

/** Non-streaming per-turn output budget — mirrors the agent relay's default. */
const DEFAULT_MAX_TOKENS = 16000;

/** Hard ceiling on caller-requested output — this relay bills the server's own
 *  provider key, so an unbounded `maxOutputTokens` is a cost-abuse lever. */
const MAX_OUTPUT_TOKENS = 32000;

/** The native request body the browser-side Gemini loop sends for one model turn. */
interface GeminiRelayRequest {
	contents: unknown[];
	systemInstruction?: unknown;
	tools?: unknown[];
	toolConfig?: unknown;
	generationConfig?: Record<string, unknown>;
	model?: string;
	/**
	 * When true, the response is Gemini's own `alt=sse` event stream, passed
	 * through verbatim — the client loop consumes native
	 * `GenerateContentResponse` chunks, so no re-framing happens here.
	 */
	stream?: boolean;
}

/**
 * Resolve the model id: explicit request > DIRECTOR_MODEL (only when it names
 * a gemini model — this relay must never forward a Claude/Kimi id) > default.
 */
function resolveModel(requested: string | undefined): string {
	const fromBody = requested?.trim();
	if (fromBody) return fromBody;
	const fromEnv = webEnv.DIRECTOR_MODEL.trim();
	if (fromEnv.startsWith("gemini")) return fromEnv;
	return DEFAULT_GEMINI_MODEL;
}

export async function POST(req: Request) {
	const apiKey = webEnv.GEMINI_API_KEY;
	if (!apiKey) {
		// Deliberate, machine-readable "no key" signal — the client agent falls
		// on to the next brain on this exact error code (mirrors the sibling
		// relay's `anthropic_not_configured` contract, including firing BEFORE
		// auth so anonymous self-hosted users keep their fallback path).
		return NextResponse.json(
			{
				error: "gemini_not_configured",
				message:
					"No Gemini key configured. Set GEMINI_API_KEY in apps/web/.env.local.",
			},
			{ status: 503 },
		);
	}

	// A provider key IS configured, so this relay bills our key — require a
	// signed-in user (same ordering rationale as /api/llm/agent).
	const session = await auth.api.getSession({ headers: await headers() });
	if (!session?.user) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	// Cap paid relay calls per account (both burst and daily volume).
	const limited = await enforceRateLimit({
		name: "llm:gemini",
		request: req,
		userId: session.user.id,
	});
	if (limited) return limited;

	let body: GeminiRelayRequest;
	try {
		body = (await req.json()) as GeminiRelayRequest;
	} catch {
		return NextResponse.json(
			{ error: "bad_request", message: "Request body must be JSON." },
			{ status: 400 },
		);
	}
	if (!Array.isArray(body.contents) || body.contents.length === 0) {
		return NextResponse.json(
			{
				error: "bad_request",
				message: "`contents` must be a non-empty array.",
			},
			{ status: 400 },
		);
	}

	// The upstream body is the caller's, minus relay-only fields (`model`,
	// `stream`) and with the output budget clamped — the ONLY places this relay
	// touches the payload.
	const requestedMax = Number(body.generationConfig?.maxOutputTokens);
	const upstreamBody = {
		contents: body.contents,
		...(body.systemInstruction != null
			? { systemInstruction: body.systemInstruction }
			: {}),
		...(body.tools?.length ? { tools: body.tools } : {}),
		...(body.toolConfig != null ? { toolConfig: body.toolConfig } : {}),
		generationConfig: {
			...(body.generationConfig ?? {}),
			maxOutputTokens: Math.min(
				// Treat 0/negative/NaN as "unset" so a bad caller value can't be sent
				// straight through to the provider as an invalid budget.
				Number.isFinite(requestedMax) && requestedMax > 0
					? requestedMax
					: DEFAULT_MAX_TOKENS,
				MAX_OUTPUT_TOKENS,
			),
		},
	};

	const base = webEnv.GEMINI_BASE_URL || DEFAULT_GEMINI_BASE;
	const model = resolveModel(body.model);
	const method = body.stream
		? "streamGenerateContent?alt=sse"
		: "generateContent";
	const url = `${base}/models/${encodeURIComponent(model)}:${method}`;

	let upstream: Response;
	try {
		// The request's own AbortSignal is forwarded upstream so a client Stop
		// halts the server-side spend, not just the client's reading (same
		// cancel-stops-billing contract the agent relay implements by hand).
		upstream = await fetch(url, {
			method: "POST",
			headers: {
				// Key travels in a header, never the URL — it cannot leak into error
				// messages, logs, or upstream response bodies echoed below.
				"x-goog-api-key": apiKey,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(upstreamBody),
			signal: req.signal,
		});
	} catch (error) {
		if (req.signal.aborted) {
			// Client already gone — nobody reads this; any response shape closes it.
			return NextResponse.json(
				{ error: "client_disconnected" },
				{ status: 499 },
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

	// Upstream errors surface with their status and Gemini's own message text
	// (mirrors the agent relay's `<provider>_api_error` pattern).
	if (!upstream.ok) {
		const text = await upstream.text().catch(() => "");
		return NextResponse.json(
			{
				error: "gemini_api_error",
				message:
					text.slice(0, 4000) || `Gemini request failed ${upstream.status}.`,
			},
			{ status: upstream.status || 502 },
		);
	}

	// ── Streaming transport (SSE passthrough) ────────────────────────────────
	if (body.stream) {
		return new Response(upstream.body, {
			headers: {
				"Content-Type": "text/event-stream; charset=utf-8",
				"Cache-Control": "no-cache, no-transform",
				Connection: "keep-alive",
				// Disable proxy buffering (nginx) so deltas flush immediately.
				"X-Accel-Buffering": "no",
			},
		});
	}

	// ── Non-streaming transport (JSON passthrough) ───────────────────────────
	const text = await upstream.text();
	return new NextResponse(text, {
		status: 200,
		headers: { "Content-Type": "application/json; charset=utf-8" },
	});
}

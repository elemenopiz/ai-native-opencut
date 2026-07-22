/**
 * POST /api/tts — cloud text-to-speech for voiceover generation.
 *
 * WHY THIS SHAPE: part of the browser-first local AI plan (Task 7) — TTS is one
 * of the capabilities that stays a cloud API rather than moving in-browser
 * (quality gap is too large for on-device models today). The route takes a
 * short script line and returns finished mp3 bytes; the client places them on
 * the timeline (Task 8 wires the consumer — nothing here knows about clips).
 *
 * It mirrors `/api/llm/enhance-prompt` deliberately: the same "no key → 503
 * with a machine-readable code so the client hides the feature" contract, the
 * same session→401 gate placed AFTER the no-key check, and the same
 * per-account rate limiting. It is UN-METERED for beta (free but rate-limited)
 * — no credit/ledger gate BY DECISION, not omission; metering decision is on
 * the backlog — see plan Task 13
 * (apps/web/docs/plans/2026-07-12-local-ai-browser-first.md).
 *
 * Provider: OpenAI `gpt-4o-mini-tts` (rides the existing OPENAI_API_KEY
 * plumbing used by the image backends). No streaming, no voice cloning, no
 * caching — one request, one mp3.
 *
 * Config (see `.env.example`):
 *  - `OPENAI_API_KEY` — when unset we return a 503 with
 *    `error: "tts_not_configured"`.
 */

import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { z } from "zod";
import { webEnv } from "@byorn/env/web";
import { auth } from "@/lib/auth/server";
import { aiAccessDeniedResponse, hasAiAccess } from "@/lib/ai-access";
import { reportError } from "@/lib/observability/logger";
import { enforceRateLimit } from "@/lib/rate-limit";
import { fetchWithTimeout } from "@/lib/studio/fetch-timeout";
import { DEFAULT_TTS_VOICE, TTS_VOICES } from "@/lib/tts/voices";

export const runtime = "nodejs";
// Synthesis of a long paragraph can take tens of seconds — give the invocation
// the same generous wall-clock budget as the other heavy provider routes.
export const maxDuration = 60;

const OPENAI_SPEECH_URL = "https://api.openai.com/v1/audio/speech";
const TTS_MODEL = "gpt-4o-mini-tts";

/** Fail OUR way (catchable 502) before the platform kills the invocation. */
const PROVIDER_TIMEOUT_MS = 55_000;

/** Hard cap on the raw request body, before JSON parsing (abuse bound). */
const MAX_BODY_BYTES = 32 * 1024;

const bodySchema = z
	.object({
		// 4000 chars mirrors OpenAI's own input cap for the speech endpoint.
		text: z.string().min(1).max(4000),
		// Allowlist (shared with the client — see `lib/tts/voices.ts`) so an
		// unknown voice is a 400 here, not an opaque provider error after we've
		// already spent the round-trip.
		voice: z.enum(TTS_VOICES).default(DEFAULT_TTS_VOICE),
		// Accepted for forward-compat with the client's caption language hint;
		// gpt-4o-mini-tts has no language parameter (it follows the input text),
		// so it is validated but NOT forwarded.
		language: z.string().max(16).optional(),
		speed: z.number().min(0.5).max(2).optional(),
	})
	.strict();

export async function POST(req: Request) {
	const apiKey = webEnv.OPENAI_API_KEY;
	if (!apiKey) {
		// Machine-readable "no key" signal — the client maps this exact code to a
		// friendly "TTS isn't configured on this server" AIClientError instead of
		// a generic failure (there is no local fallback for speech synthesis).
		return NextResponse.json(
			{
				error: "tts_not_configured",
				message:
					"No TTS key configured. Set OPENAI_API_KEY in apps/web/.env.local.",
			},
			{ status: 503 },
		);
	}

	// A key IS configured, so this route bills it — require a signed-in user.
	// (After the no-key check so a self-hosted instance with no key returns the
	// 503 the client uses to hide the feature, not a 401.)
	const session = await auth.api.getSession({ headers: await headers() });
	if (!session?.user) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}
	if (!hasAiAccess(session.user)) return aiAccessDeniedResponse();

	const limited = await enforceRateLimit({
		name: "tts:generate",
		request: req,
		userId: session.user.id,
	});
	if (limited) return limited;

	// Bound the body before parsing — content-length can lie or be absent, so
	// re-check the actual text length too.
	const contentLength = Number(req.headers.get("content-length") ?? 0);
	if (contentLength > MAX_BODY_BYTES) {
		return NextResponse.json({ error: "Payload too large" }, { status: 413 });
	}
	let raw: string;
	try {
		raw = await req.text();
	} catch {
		return NextResponse.json(
			{ error: "bad_request", message: "Request body must be readable." },
			{ status: 400 },
		);
	}
	if (raw.length > MAX_BODY_BYTES) {
		return NextResponse.json({ error: "Payload too large" }, { status: 413 });
	}

	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return NextResponse.json(
			{ error: "bad_request", message: "Request body must be JSON." },
			{ status: 400 },
		);
	}

	const parsed = bodySchema.safeParse(json);
	if (!parsed.success) {
		return NextResponse.json(
			{ error: "bad_request", message: "Invalid TTS request." },
			{ status: 400 },
		);
	}
	const { text, voice, speed } = parsed.data;

	try {
		const res = await fetchWithTimeout(OPENAI_SPEECH_URL, {
			method: "POST",
			timeoutMs: PROVIDER_TIMEOUT_MS,
			headers: {
				authorization: `Bearer ${apiKey}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: TTS_MODEL,
				voice,
				input: text,
				response_format: "mp3",
				...(speed !== undefined ? { speed } : {}),
			}),
		});

		if (!res.ok) {
			// Log the provider's status/body server-side (truncated), but NEVER echo
			// it to the client — provider error bodies can quote the request key.
			const providerBody = await res.text().catch(() => "");
			reportError(new Error(`OpenAI TTS error ${res.status}`), {
				route: "tts",
				providerStatus: res.status,
				providerBody: providerBody.slice(0, 500),
			});
			return NextResponse.json(
				{
					error: "provider_api_error",
					message: "The speech provider rejected the request.",
				},
				{ status: 502 },
			);
		}

		const audio = await res.arrayBuffer();
		return new NextResponse(audio, {
			status: 200,
			headers: {
				"content-type": "audio/mpeg",
				// Per-request synthesis for one signed-in user — never cache-shared.
				"cache-control": "no-store",
			},
		});
	} catch (error) {
		// Timeout / network failure on the provider call — upstream, not our bug,
		// but still worth a server-side trace.
		reportError(error, { route: "tts" });
		return NextResponse.json(
			{ error: "tts_error", message: "Failed to synthesize speech." },
			{ status: 502 },
		);
	}
}

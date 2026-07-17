/**
 * POST /api/llm/enhance-prompt — one-shot prompt rewriter for the generation
 * surfaces.
 *
 * WHY THIS SHAPE: drafts range from a sparse fragment to a long, detailed
 * paragraph. This route takes the draft plus a compact, client-supplied slice
 * of the project's reference context (StyleBible / brief / asset notes /
 * persona) and rewrites it into a generation-ready prompt the user can READ and
 * EDIT before they generate — improving it (enriching what's sparse, tightening
 * what's rambling) without ever dropping content the user specified. It NEVER
 * submits anything — the button just replaces the field text.
 *
 * PROVIDER SELECTION — GEMINI FIRST: Gemini is the product's premier LLM, so
 * `GEMINI_API_KEY` wins (one native `generateContent` call against the same
 * public API the `/api/llm/gemini` relay speaks), then Kimi (MOONSHOT_API_KEY),
 * then Anthropic. Everything else mirrors `/api/llm/agent`: the "no key → 503
 * with a machine-readable code so the client hides the button" contract, the
 * session→401 gate placed AFTER the no-key check, and the same per-account
 * rate limiting. It is UN-METERED for beta (free but rate-limited) — no
 * credit gate.
 *
 * Config (see `.env.example`):
 *  - `GEMINI_API_KEY` (preferred) / `MOONSHOT_API_KEY` / `ANTHROPIC_API_KEY` —
 *    when none is set we return a 503 with `error: "enhance_not_configured"`.
 *  - `DIRECTOR_MODEL` (optional) — model override; honored only by the
 *    provider whose dialect it names (a `gemini-*` id never reaches Kimi, and
 *    a Claude/Kimi id never reaches Gemini).
 *  - `GEMINI_BASE_URL` (optional) — Gemini API base override (same as relay).
 */

import { NextResponse } from "next/server";
import { headers } from "next/headers";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { webEnv } from "@byorn/env/web";
import { auth } from "@/lib/auth/server";
import { enforceRateLimit } from "@/lib/rate-limit";
import { reportError } from "@/lib/observability/logger";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Default models — mirror the agent/gemini relays' provider defaults. */
const DEFAULT_MODEL = "claude-opus-4-8";
const KIMI_BASE_URL = "https://api.moonshot.ai/anthropic";
const DEFAULT_KIMI_MODEL = "kimi-k2.6";
const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash";
const DEFAULT_GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Single-shot output budget. On the Gemini path this ceiling is SHARED with
 * thinking tokens (`thinkingConfig` below draws from the same
 * `maxOutputTokens`), and the prompt's own guideline now runs up to ~350
 * words — so this needs generous headroom, not a tight cap, to avoid
 * truncating the visible text mid-sentence.
 */
const MAX_OUTPUT_TOKENS = 2048;

/** Hard cap on the raw request body, before JSON parsing (abuse bound). */
const MAX_BODY_BYTES = 32 * 1024;

/** The enhance modes: the two studio modalities plus the Director chat. */
const MODES = ["image", "video", "director"] as const;
type EnhanceMode = (typeof MODES)[number];

const contextSchema = z
	.object({
		styleBible: z.string().max(2000).optional(),
		brief: z.string().max(2000).optional(),
		assetNotes: z.array(z.string().max(500)).max(10).optional(),
		persona: z.string().max(1000).optional(),
	})
	.strict();

const bodySchema = z
	.object({
		prompt: z.string().min(1).max(8000),
		mode: z.enum(MODES),
		context: contextSchema.optional(),
	})
	.strict();

type EnhanceContext = z.infer<typeof contextSchema>;

/**
 * The enhancer's instructions. The heart of the feature — it must IMPROVE, not
 * REDUCE: a sparse draft gets enriched with concrete specificity, a rambling
 * one gets tightened into sharper wording, but every concrete thing the user
 * specified survives either way. It must expand or tighten without hijacking:
 * keep the user's exact subject/intent, add concrete specificity in the target
 * model's own prompt dialect, and lean on the project's established look
 * (never contradicting or inventing it).
 */
function buildSystemPrompt(mode: EnhanceMode): string {
	const shared = [
		"You are a prompt engineer for an AI video studio. You rewrite a user's draft into ONE improved, generation-ready prompt — you never reduce it.",
		"",
		"FIRST, ASSESS THE DRAFT: if it's sparse or underspecified, ENRICH it with concrete, relevant specificity. If it's rambling, redundant, or repetitive, TIGHTEN it — but tightening means sharper, more economical wording, never dropping content. A long, detailed draft should come back at least as detailed, never compressed into something shorter or vaguer than what the user wrote.",
		"",
		"HARD RULES:",
		"- PRESERVE the user's core intent and subject EXACTLY. Never swap, drop, or add a subject, action, or setting they did not ask for. You are improving THEIR idea, not replacing it.",
		"- EVERY concrete element the user specified — subjects, actions, settings, styles, constraints, names, numbers, ordering — MUST survive into the rewrite. If you're unsure whether a detail was intentional, keep it; when in doubt, preserve.",
		"- If reference context is provided (STYLE, BRIEF, ASSETS, PERSONA), weave it in so the result is consistent with the look the user has already established. Cite their actual descriptors; never contradict them and never invent facts about their assets, characters, or brand that the context does not state.",
		'- The draft may contain literal handle tokens like @Image1 or @Video2 — machine-readable references to attached media (see ASSETS for what each one is). Preserve every one EXACTLY as written: same letters, digits, and leading @, never translated, renamed, merged, explained, or dropped. Keep each token attached to the phrase it modifies (e.g. "@Image1 walking through fog" stays built around @Image1 as the subject).',
		"- Output ONLY the rewritten prompt text. No preamble, no explanation, no surrounding quotes, no markdown, no code fences, no labels. Just the prompt.",
	];

	if (mode === "director") {
		return [
			...shared,
			"- This is a DIRECTOR instruction, addressed to an autonomous editing agent. Write it as clear, natural creative direction — not a comma-separated image caption. Expand the user's ask into concrete direction: the shots or beats implied, pacing, tone, and mood. Keep it actionable and specific, but do NOT fabricate details about the user's footage or cast.",
			"- Length should scale with the draft: roughly 150 words is a good guideline for a typical ask, but this is soft guidance, not a cap — a detailed draft earns a longer rewrite, never a shorter one. Absolute ceiling: about 350 words.",
		].join("\n");
	}

	const motion =
		mode === "video"
			? " camera movement and motion (what moves, and how the shot itself moves),"
			: "";
	return [
		...shared,
		`- This targets an AI ${mode} model. Write a dense, richly visual prompt as comma-separated descriptors: subject and its details, composition and framing, lighting, lens/camera language,${motion} mood, color, and overall style.`,
		"- Front-load the subject, then layer specificity. Prefer concrete, visual nouns and adjectives over abstract or narrative phrasing.",
		"- Length should scale with the draft: roughly 60–200 words is a good guideline, but this is soft guidance, not a cap — a sparse draft can land near the low end, a detailed one deserves more room and should never be compressed below the substance the user already wrote. Absolute ceiling: about 350 words.",
	].join("\n");
}

/** Assemble the user turn: the draft prompt plus whatever context was supplied. */
function buildUserMessage(
	prompt: string,
	mode: EnhanceMode,
	context: EnhanceContext | undefined,
): string {
	const parts: string[] = [];
	const style = context?.styleBible?.trim();
	const brief = context?.brief?.trim();
	const persona = context?.persona?.trim();
	const notes = (context?.assetNotes ?? [])
		.map((n) => n.trim())
		.filter(Boolean);

	if (style) parts.push(`ESTABLISHED STYLE (keep consistent):\n${style}`);
	if (brief) parts.push(`PROJECT BRIEF:\n${brief}`);
	if (persona)
		parts.push(`FEATURED CHARACTER (must stay consistent):\n${persona}`);
	if (notes.length)
		parts.push(
			`PROJECT ASSETS (for grounding — do not invent beyond these):\n${notes
				.map((n) => `- ${n}`)
				.join("\n")}`,
		);

	parts.push(`USER DRAFT (${mode} prompt to enhance):\n${prompt.trim()}`);
	parts.push(
		"Rewrite the user draft into the final prompt now. Output only the prompt.",
	);
	return parts.join("\n\n");
}

/** Concatenate the text blocks out of an Anthropic assistant reply. */
function textOfContent(content: Anthropic.ContentBlock[]): string {
	return content
		.filter((b): b is Anthropic.TextBlock => b.type === "text")
		.map((b) => b.text)
		.join("")
		.trim();
}

/** Concatenate the text parts out of a Gemini `generateContent` reply. */
function textOfGeminiBody(body: unknown): string {
	const candidates = (body as { candidates?: unknown } | null)?.candidates;
	if (!Array.isArray(candidates)) return "";
	const parts = (candidates[0] as { content?: { parts?: unknown } } | undefined)
		?.content?.parts;
	if (!Array.isArray(parts)) return "";
	return parts
		.map((p) => {
			const text = (p as { text?: unknown } | null)?.text;
			return typeof text === "string" ? text : "";
		})
		.join("")
		.trim();
}

/** `candidates[0].finishReason` out of a Gemini `generateContent` reply. */
function finishReasonOfGeminiBody(body: unknown): string | undefined {
	const candidates = (body as { candidates?: unknown } | null)?.candidates;
	if (!Array.isArray(candidates)) return undefined;
	const reason = (candidates[0] as { finishReason?: unknown } | undefined)
		?.finishReason;
	return typeof reason === "string" ? reason : undefined;
}

/**
 * The response for a provider that cut the completion off at the token budget
 * — with the 2048-token cap this should be rare, but the check is the safety
 * net so a partial rewrite is never silently returned as if complete. A fresh
 * `NextResponse` per call: its body is a stream, so a single shared instance
 * could only ever be read once.
 */
function truncatedResponse(): NextResponse {
	return NextResponse.json(
		{
			error: "truncated_completion",
			message: "The enhanced prompt was cut off — try a shorter draft.",
		},
		{ status: 502 },
	);
}

/**
 * The Gemini path: one native `generateContent` call. Returns the enhanced
 * text, or a `NextResponse` error to relay as-is (same `provider_api_error`
 * shape the Anthropic path produces). Key travels in a header, never the URL.
 */
async function enhanceViaGemini(args: {
	apiKey: string;
	system: string;
	user: string;
	signal: AbortSignal;
}): Promise<string | NextResponse> {
	const fromEnv = webEnv.DIRECTOR_MODEL.trim();
	const model = fromEnv.startsWith("gemini") ? fromEnv : DEFAULT_GEMINI_MODEL;
	const base = webEnv.GEMINI_BASE_URL || DEFAULT_GEMINI_BASE;
	const url = `${base}/models/${encodeURIComponent(model)}:generateContent`;

	const upstream = await fetch(url, {
		method: "POST",
		headers: {
			"x-goog-api-key": args.apiKey,
			"Content-Type": "application/json",
		},
		signal: args.signal,
		body: JSON.stringify({
			contents: [{ role: "user", parts: [{ text: args.user }] }],
			systemInstruction: { parts: [{ text: args.system }] },
			generationConfig: {
				maxOutputTokens: MAX_OUTPUT_TOKENS,
				temperature: 0.7,
				// A rewrite of supplied text, not planning — low thinking keeps the
				// button snappy (same rationale as the understanding pass).
				thinkingConfig: { thinkingLevel: "low" },
			},
		}),
	});
	if (!upstream.ok) {
		const text = await upstream.text().catch(() => "");
		return NextResponse.json(
			{
				error: "provider_api_error",
				message:
					text.slice(0, 2000) || `Gemini request failed ${upstream.status}.`,
			},
			{ status: upstream.status || 502 },
		);
	}
	const body = (await upstream.json()) as unknown;
	// `maxOutputTokens` is shared with thinking tokens on this path, so a cutoff
	// is possible even under the 2048 cap — surface it rather than returning
	// partial text silently.
	if (finishReasonOfGeminiBody(body) === "MAX_TOKENS")
		return truncatedResponse();
	return textOfGeminiBody(body);
}

export async function POST(req: Request) {
	// Provider selection — GEMINI FIRST (the premier LLM), then Kimi, then
	// Anthropic.
	const geminiKey = webEnv.GEMINI_API_KEY;
	const moonshotKey = webEnv.MOONSHOT_API_KEY;
	const anthropicKey = webEnv.ANTHROPIC_API_KEY;
	const useGemini = Boolean(geminiKey);
	const useKimi = !useGemini && Boolean(moonshotKey);
	const apiKey = useGemini ? geminiKey : useKimi ? moonshotKey : anthropicKey;
	if (!apiKey) {
		// Machine-readable "no key" signal — the client hides the Enhance button on
		// this exact code (there is no local fallback for this feature).
		return NextResponse.json(
			{
				error: "enhance_not_configured",
				message:
					"No prompt-enhance key configured. Set GEMINI_API_KEY (preferred), MOONSHOT_API_KEY, or ANTHROPIC_API_KEY in apps/web/.env.local.",
			},
			{ status: 503 },
		);
	}

	// A key IS configured, so this route bills it — require a signed-in user.
	// (After the no-key check so a self-hosted instance with no key returns the
	// 503 the client uses to hide the button, not a 401.)
	const session = await auth.api.getSession({ headers: await headers() });
	if (!session?.user) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const limited = await enforceRateLimit({
		name: "llm:enhance",
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
			{ error: "bad_request", message: "Invalid enhance request." },
			{ status: 400 },
		);
	}
	const { prompt, mode, context } = parsed.data;

	const system = buildSystemPrompt(mode);
	const user = buildUserMessage(prompt, mode, context);

	try {
		let enhanced: string;
		if (useGemini) {
			const result = await enhanceViaGemini({
				apiKey,
				system,
				user,
				signal: req.signal,
			});
			if (result instanceof NextResponse) return result;
			enhanced = result;
		} else {
			const client = new Anthropic({
				apiKey,
				...(useKimi ? { baseURL: KIMI_BASE_URL } : {}),
			});
			// A gemini-* DIRECTOR_MODEL must never reach the Anthropic-dialect
			// providers — fall back to their own defaults instead.
			const fromEnv = webEnv.DIRECTOR_MODEL.trim();
			const model =
				fromEnv && !fromEnv.startsWith("gemini")
					? fromEnv
					: useKimi
						? DEFAULT_KIMI_MODEL
						: DEFAULT_MODEL;
			const response = await client.messages.create({
				model,
				max_tokens: MAX_OUTPUT_TOKENS,
				temperature: 0.7,
				system,
				messages: [{ role: "user", content: user }],
			});
			if (response.stop_reason === "max_tokens") return truncatedResponse();
			enhanced = textOfContent(response.content);
		}

		if (!enhanced) {
			return NextResponse.json(
				{ error: "empty_completion", message: "The model returned no text." },
				{ status: 502 },
			);
		}
		return NextResponse.json({ enhanced });
	} catch (error) {
		if (error instanceof Anthropic.APIError) {
			// A provider API error is upstream, not our bug — surface its status,
			// don't page on it.
			return NextResponse.json(
				{ error: "provider_api_error", message: error.message },
				{ status: typeof error.status === "number" ? error.status : 502 },
			);
		}
		// Unexpected — this IS worth reporting through the observability seam.
		reportError(error, { route: "llm/enhance-prompt" });
		return NextResponse.json(
			{ error: "enhance_error", message: "Failed to enhance prompt." },
			{ status: 502 },
		);
	}
}

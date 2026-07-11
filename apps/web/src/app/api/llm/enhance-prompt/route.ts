/**
 * POST /api/llm/enhance-prompt — one-shot prompt rewriter for the generation
 * surfaces.
 *
 * WHY THIS SHAPE: most users type short, underspecified prompts. This route
 * takes their draft plus a compact, client-supplied slice of the project's
 * reference context (StyleBible / brief / asset notes / persona) and rewrites it
 * into a detailed, generation-ready prompt the user can READ and EDIT before they
 * generate. It NEVER submits anything — the button just replaces the field text.
 *
 * It mirrors `/api/llm/agent` deliberately: same provider selection (Kimi via
 * MOONSHOT_API_KEY preferred, else Anthropic), the same "no key → 503 with a
 * machine-readable code so the client hides the button" contract, the same
 * session→401 gate placed AFTER the no-key check, and the same per-account rate
 * limiting. It is UN-METERED for beta (free but rate-limited) — no credit gate.
 *
 * Config (see `.env.example`):
 *  - `MOONSHOT_API_KEY` (preferred) / `ANTHROPIC_API_KEY` — when neither is set
 *    we return a 503 with `error: "enhance_not_configured"`.
 *  - `DIRECTOR_MODEL` (optional) — model override; else the provider default.
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

/** Default models — mirror the agent relay's provider defaults. */
const DEFAULT_MODEL = "claude-opus-4-8";
const KIMI_BASE_URL = "https://api.moonshot.ai/anthropic";
const DEFAULT_KIMI_MODEL = "kimi-k2.6";

/** Single-shot output budget. A generation prompt is short — cap it tight. */
const MAX_OUTPUT_TOKENS = 700;

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
		prompt: z.string().min(1).max(2000),
		mode: z.enum(MODES),
		context: contextSchema.optional(),
	})
	.strict();

type EnhanceContext = z.infer<typeof contextSchema>;

/**
 * The enhancer's instructions. The heart of the feature — it must expand without
 * hijacking: keep the user's exact subject/intent, add concrete specificity in
 * the target model's own prompt dialect, and lean on the project's established
 * look (never contradicting or inventing it).
 */
function buildSystemPrompt(mode: EnhanceMode): string {
	const shared = [
		"You are a prompt engineer for an AI video studio. You rewrite a user's short, underspecified draft into ONE detailed, generation-ready prompt.",
		"",
		"HARD RULES:",
		"- PRESERVE the user's core intent and subject EXACTLY. Never swap, drop, or add a subject, action, or setting they did not ask for. You are enriching THEIR idea, not replacing it.",
		"- If reference context is provided (STYLE, BRIEF, ASSETS, PERSONA), weave it in so the result is consistent with the look the user has already established. Cite their actual descriptors; never contradict them and never invent facts about their assets, characters, or brand that the context does not state.",
		"- Output ONLY the rewritten prompt text. No preamble, no explanation, no surrounding quotes, no markdown, no code fences, no labels. Just the prompt.",
	];

	if (mode === "director") {
		return [
			...shared,
			"- This is a DIRECTOR instruction, addressed to an autonomous editing agent. Write it as clear, natural creative direction — not a comma-separated image caption. Expand the user's ask into concrete direction: the shots or beats implied, pacing, tone, and mood. Keep it actionable and specific, but do NOT fabricate details about the user's footage or cast.",
			"- Keep it under about 120 words.",
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
		"- Keep it under about 150 words.",
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

export async function POST(req: Request) {
	// Provider selection: prefer Kimi (Moonshot) when its key is present, else
	// Anthropic — identical to the agent relay so both bill the same key.
	const moonshotKey = webEnv.MOONSHOT_API_KEY;
	const anthropicKey = webEnv.ANTHROPIC_API_KEY;
	const useKimi = Boolean(moonshotKey);
	const apiKey = useKimi ? moonshotKey : anthropicKey;
	if (!apiKey) {
		// Machine-readable "no key" signal — the client hides the Enhance button on
		// this exact code (there is no local fallback for this feature).
		return NextResponse.json(
			{
				error: "enhance_not_configured",
				message:
					"No prompt-enhance key configured. Set MOONSHOT_API_KEY (Kimi) or ANTHROPIC_API_KEY in apps/web/.env.local.",
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

	const client = new Anthropic({
		apiKey,
		...(useKimi ? { baseURL: KIMI_BASE_URL } : {}),
	});

	try {
		const response = await client.messages.create({
			model:
				webEnv.DIRECTOR_MODEL.trim() ||
				(useKimi ? DEFAULT_KIMI_MODEL : DEFAULT_MODEL),
			max_tokens: MAX_OUTPUT_TOKENS,
			temperature: 0.7,
			system: buildSystemPrompt(mode),
			messages: [
				{ role: "user", content: buildUserMessage(prompt, mode, context) },
			],
		});

		const enhanced = textOfContent(response.content);
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

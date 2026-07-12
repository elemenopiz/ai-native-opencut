/**
 * Podcast transcript analysis on GEMINI — the cloud home for the three
 * LLM-shaped podcast workflows that died with the local Ollama backend:
 *
 *  - {@link findBestClips} — "Find best clips": pick the strongest
 *    self-contained moments from a timestamped transcript.
 *  - {@link extractKeywords} — keyword highlighting for popover subtitles.
 *  - {@link generateQuestionCards} — topic-shift intro cards.
 *
 * All three are one-shot, tool-less structured-output calls in Gemini's NATIVE
 * dialect against the stateless `/api/llm/gemini` relay (auth-gated,
 * rate-limited, server-held key) — the exact pattern `geminiUnderstandAsset`
 * established: `contents` + `systemInstruction` + `generationConfig.
 * responseSchema` (UPPERCASE OpenAPI-subset types, `propertyOrdering` per
 * Gemini's structured-output guidance), with a FAIL-SAFE parser on top that
 * clamps, coerces, and drops rather than trusting the schema alone.
 *
 * SENTENCE-ALIGNED BY CONSTRUCTION: clip boundaries returned by the model are
 * SNAPPED to the nearest transcript-segment boundary before they reach the UI,
 * so an applied clip can never start or end mid-sentence — the same principle
 * the Director's SPEECH-AWARE CUTS rule enforces for trims.
 *
 * PURE where it matters: the request builders and parsers are exported and
 * unit-tested without a network; only {@link callPodcastGemini} touches fetch.
 */

import type {
	ClipCandidate,
	FindClipsResult,
	KeywordEntry,
	KeywordResult,
	QuestionCard,
	QuestionCardsResult,
} from "@/types/ai";

/** The transcript-segment slice these analyses need (a subset of the store's). */
export interface PodcastSegment {
	text: string;
	start: number;
	end: number;
}

const GEMINI_RELAY_URL = "/api/llm/gemini";

/**
 * Char budget for the transcript rendered into one prompt. Gemini 3.5 Flash
 * takes far more, but a multi-hour transcript adds latency/cost without
 * improving clip selection; over budget we keep the head and tail (openers and
 * closers are where hooks live) and say so in the prompt.
 */
export const TRANSCRIPT_CHAR_BUDGET = 200_000;

/** Render segments as the `[12.3–15.6] text` lines all three prompts share. */
export function renderSegmentsForPrompt(
	segments: readonly PodcastSegment[],
	budget: number = TRANSCRIPT_CHAR_BUDGET,
): string {
	const lines = segments.map(
		(s) => `[${s.start.toFixed(1)}–${s.end.toFixed(1)}] ${s.text.trim()}`,
	);
	const full = lines.join("\n");
	if (full.length <= budget) return full;

	// Head + tail halves, with an explicit elision marker for the model.
	const half = Math.floor(budget / 2);
	let headEnd = 0;
	let headLen = 0;
	while (
		headEnd < lines.length &&
		headLen + lines[headEnd].length + 1 <= half
	) {
		headLen += lines[headEnd].length + 1;
		headEnd += 1;
	}
	let tailStart = lines.length;
	let tailLen = 0;
	while (
		tailStart > headEnd &&
		tailLen + lines[tailStart - 1].length + 1 <= half
	) {
		tailLen += lines[tailStart - 1].length + 1;
		tailStart -= 1;
	}
	return [
		...lines.slice(0, headEnd),
		"[… transcript elided for length …]",
		...lines.slice(tailStart),
	].join("\n");
}

// ── relay transport ───────────────────────────────────────────────────────────

/** Typed failure carrying the relay's machine-readable code + HTTP status. */
export class PodcastAiError extends Error {
	constructor(
		message: string,
		readonly code: string,
		readonly status: number,
	) {
		super(message);
		this.name = "PodcastAiError";
	}
}

/** Honest UI copy for a failed analysis (no docker/Ollama ghosts). */
export function podcastAiErrorMessage(err: unknown): string {
	if (err instanceof PodcastAiError) {
		if (err.code === "gemini_not_configured")
			return "AI analysis is not configured on this server.";
		if (err.status === 401) return "Log in to run AI analysis.";
		if (err.status === 429)
			return "AI rate limit reached — try again in a minute.";
		return err.message;
	}
	return err instanceof Error ? err.message : "AI analysis failed.";
}

/** Pull the concatenated text out of a raw Gemini `generateContent` response. */
export function textOfGeminiResponse(body: unknown): string {
	const candidates = (body as { candidates?: unknown } | null)?.candidates;
	if (!Array.isArray(candidates)) return "";
	const first = candidates[0] as { content?: { parts?: unknown } } | undefined;
	const parts = first?.content?.parts;
	if (!Array.isArray(parts)) return "";
	return parts
		.map((p) => {
			const text = (p as { text?: unknown } | null)?.text;
			return typeof text === "string" ? text : "";
		})
		.join("");
}

/** The injectable transport (tests stub this; production uses fetch). */
export type PodcastGeminiCall = (request: {
	system: string;
	userText: string;
	responseSchema: unknown;
	signal?: AbortSignal;
}) => Promise<string>;

/**
 * One tool-less structured-output call through the stateless Gemini relay.
 * Model is left unset so the relay's own resolution applies (DIRECTOR_MODEL
 * when it names a gemini model, else the relay default). Thinking stays LOW:
 * these are extraction/selection tasks over supplied text, not multi-step
 * planning — Gemini's docs recommend low thinking there (latency + cost).
 */
export const callPodcastGemini: PodcastGeminiCall = async ({
	system,
	userText,
	responseSchema,
	signal,
}) => {
	const res = await fetch(GEMINI_RELAY_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		signal,
		body: JSON.stringify({
			contents: [{ role: "user", parts: [{ text: userText }] }],
			systemInstruction: { parts: [{ text: system }] },
			generationConfig: {
				responseMimeType: "application/json",
				responseSchema,
				thinkingConfig: { thinkingLevel: "low" },
			},
		}),
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as {
			error?: string;
			message?: string;
		} | null;
		throw new PodcastAiError(
			body?.message ?? `AI analysis failed (${res.status}).`,
			body?.error ?? "podcast_ai_error",
			res.status,
		);
	}
	return textOfGeminiResponse((await res.json()) as unknown);
};

/** Fail-safe JSON parse: returns null instead of throwing on model noise. */
function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

const num = (v: unknown): number | undefined =>
	typeof v === "number" && Number.isFinite(v) ? v : undefined;
const str = (v: unknown): string | undefined =>
	typeof v === "string" && v.trim() ? v.trim() : undefined;

// ── find best clips ───────────────────────────────────────────────────────────

export interface FindClipsOptions {
	minDuration?: number;
	maxDuration?: number;
	maxClips?: number;
	signal?: AbortSignal;
	/** Injected transport (tests). */
	call?: PodcastGeminiCall;
}

const FIND_CLIPS_DEFAULTS = { minDuration: 15, maxDuration: 90, maxClips: 10 };

export const FIND_CLIPS_RESPONSE_SCHEMA = {
	type: "OBJECT",
	properties: {
		clips: {
			type: "ARRAY",
			items: {
				type: "OBJECT",
				properties: {
					title: { type: "STRING" },
					start: { type: "NUMBER" },
					end: { type: "NUMBER" },
					score: { type: "NUMBER" },
					reason: { type: "STRING" },
					tags: { type: "ARRAY", items: { type: "STRING" } },
				},
				required: ["title", "start", "end", "score", "reason", "tags"],
				propertyOrdering: ["title", "start", "end", "score", "reason", "tags"],
			},
		},
	},
	required: ["clips"],
	propertyOrdering: ["clips"],
} as const;

export function buildFindClipsSystemPrompt(opts: {
	minDuration: number;
	maxDuration: number;
	maxClips: number;
}): string {
	return [
		"You are a short-form video editor reviewing a podcast/talk transcript. Select the strongest SELF-CONTAINED clips — moments that hook fast, deliver one complete idea, and land a payoff.",
		"",
		"RULES:",
		`- Each clip runs ${opts.minDuration}–${opts.maxDuration} seconds and must be understandable with zero surrounding context.`,
		"- `start` and `end` MUST be timestamps taken from the bracketed segment boundaries in the transcript — start at a segment's start, end at a segment's end. Never cut into the middle of a sentence.",
		"- Clips must not overlap each other.",
		`- Return at most ${opts.maxClips} clips, strongest first. Fewer good clips beat many weak ones; return an empty list if nothing stands alone.`,
		"- `score` is 0–100 (standalone strength + hook + payoff). `reason` is one short sentence on why it works. `tags` are 1–3 lowercase topic tags.",
		"- `title` is a punchy 3–8 word title in the speaker's language.",
	].join("\n");
}

/**
 * Snap a model-chosen boundary to the nearest REAL segment boundary so an
 * applied clip is sentence-aligned by construction. Exported for tests.
 */
export function snapToSegmentBounds(
	segments: readonly PodcastSegment[],
	start: number,
	end: number,
): { start: number; end: number } | null {
	if (segments.length === 0 || !(end > start)) return null;
	let bestStart = segments[0].start;
	let bestStartDist = Number.POSITIVE_INFINITY;
	let bestEnd = segments[segments.length - 1].end;
	let bestEndDist = Number.POSITIVE_INFINITY;
	for (const seg of segments) {
		const ds = Math.abs(seg.start - start);
		if (ds < bestStartDist) {
			bestStartDist = ds;
			bestStart = seg.start;
		}
		const de = Math.abs(seg.end - end);
		if (de < bestEndDist) {
			bestEndDist = de;
			bestEnd = seg.end;
		}
	}
	return bestEnd > bestStart ? { start: bestStart, end: bestEnd } : null;
}

/**
 * Fail-safe parse of the model's clip list: coerce fields, snap boundaries to
 * segment bounds, drop invalid/overlong/short entries, de-overlap greedily by
 * score, and cap the count. A garbage reply yields `{ clips: [] }`, never a
 * throw.
 */
export function parseFindClipsResponse(
	text: string,
	segments: readonly PodcastSegment[],
	opts: { minDuration: number; maxDuration: number; maxClips: number },
): FindClipsResult {
	const totalDuration = segments.length ? segments[segments.length - 1].end : 0;
	const root = parseJson(text) as { clips?: unknown } | null;
	const rawClips = Array.isArray(root?.clips) ? root.clips : [];

	const candidates: ClipCandidate[] = [];
	for (const raw of rawClips) {
		const r = raw as Record<string, unknown>;
		const start = num(r.start);
		const end = num(r.end);
		const title = str(r.title);
		if (start === undefined || end === undefined || !title) continue;

		const snapped = snapToSegmentBounds(segments, start, end);
		if (!snapped) continue;
		const duration = snapped.end - snapped.start;
		// Snapping can stretch/shrink slightly — allow 20% slack around bounds.
		if (
			duration < opts.minDuration * 0.8 ||
			duration > opts.maxDuration * 1.2
		) {
			continue;
		}

		candidates.push({
			title,
			start: snapped.start,
			end: snapped.end,
			score: Math.round(Math.min(100, Math.max(0, num(r.score) ?? 0))),
			reason: str(r.reason) ?? "",
			tags: Array.isArray(r.tags)
				? r.tags
						.map((t) => str(t))
						.filter((t): t is string => t !== undefined)
						.slice(0, 3)
				: [],
		});
	}

	// Greedy de-overlap, best score first; then present in timeline order.
	candidates.sort((a, b) => b.score - a.score);
	const kept: ClipCandidate[] = [];
	for (const clip of candidates) {
		if (kept.length >= opts.maxClips) break;
		if (kept.some((k) => clip.start < k.end && clip.end > k.start)) continue;
		kept.push(clip);
	}
	kept.sort((a, b) => a.start - b.start);

	return { clips: kept, total_duration: totalDuration };
}

/** "Find best clips", on Gemini. Sentence-aligned, de-overlapped, fail-safe. */
export async function findBestClips(
	segments: readonly PodcastSegment[],
	options?: FindClipsOptions,
): Promise<FindClipsResult> {
	const opts = { ...FIND_CLIPS_DEFAULTS, ...options };
	const call = options?.call ?? callPodcastGemini;
	const text = await call({
		system: buildFindClipsSystemPrompt(opts),
		userText: `TRANSCRIPT (timestamped segments):\n${renderSegmentsForPrompt(segments)}\n\nSelect the best clips now.`,
		responseSchema: FIND_CLIPS_RESPONSE_SCHEMA,
		signal: options?.signal,
	});
	return parseFindClipsResponse(text, segments, opts);
}

// ── keyword highlighting ──────────────────────────────────────────────────────

/** Category → highlight color, applied server of record here (not the model). */
export const KEYWORD_CATEGORY_COLORS: Record<string, string> = {
	money: "#4ade80",
	number: "#4ade80",
	emotion: "#f87171",
	action: "#facc15",
	person: "#60a5fa",
	place: "#60a5fa",
	topic: "#c084fc",
};
const KEYWORD_FALLBACK_COLOR = "#facc15";
const KEYWORD_CAP = 25;

export const KEYWORDS_RESPONSE_SCHEMA = {
	type: "OBJECT",
	properties: {
		keywords: {
			type: "ARRAY",
			items: {
				type: "OBJECT",
				properties: {
					word: { type: "STRING" },
					category: {
						type: "STRING",
						enum: Object.keys(KEYWORD_CATEGORY_COLORS),
					},
				},
				required: ["word", "category"],
				propertyOrdering: ["word", "category"],
			},
		},
	},
	required: ["keywords"],
	propertyOrdering: ["keywords"],
} as const;

const KEYWORDS_SYSTEM_PROMPT = [
	"You highlight the words that matter in short-form video captions.",
	"From the transcript, pick the single words (or very short 2-word phrases) that deserve visual emphasis: numbers and money amounts, emotionally charged words, strong verbs, names, places, and core topic nouns.",
	`Return 8–${KEYWORD_CAP} entries. Use the word EXACTLY as it appears in the transcript (same casing) so it can be matched. Do not pick filler or common stopwords.`,
].join("\n");

/** Fail-safe parse: dedupe (case-insensitive), color by category, cap. */
export function parseKeywordsResponse(text: string): KeywordResult {
	const root = parseJson(text) as { keywords?: unknown } | null;
	const raw = Array.isArray(root?.keywords) ? root.keywords : [];
	const seen = new Set<string>();
	const keywords: KeywordEntry[] = [];
	for (const item of raw) {
		if (keywords.length >= KEYWORD_CAP) break;
		const r = item as Record<string, unknown>;
		const word = str(r.word);
		if (!word) continue;
		const key = word.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		const category = str(r.category)?.toLowerCase() ?? "topic";
		keywords.push({
			word,
			category,
			color: KEYWORD_CATEGORY_COLORS[category] ?? KEYWORD_FALLBACK_COLOR,
		});
	}
	return { keywords };
}

/** Keyword highlighting, on Gemini. */
export async function extractKeywords(
	segments: readonly PodcastSegment[],
	options?: { signal?: AbortSignal; call?: PodcastGeminiCall },
): Promise<KeywordResult> {
	const call = options?.call ?? callPodcastGemini;
	const text = await call({
		system: KEYWORDS_SYSTEM_PROMPT,
		userText: `TRANSCRIPT:\n${renderSegmentsForPrompt(segments)}\n\nPick the keywords now.`,
		responseSchema: KEYWORDS_RESPONSE_SCHEMA,
		signal: options?.signal,
	});
	return parseKeywordsResponse(text);
}

// ── question cards ────────────────────────────────────────────────────────────

const CARD_THEMES = ["dark", "gradient", "bold", "neon"] as const;
type CardTheme = (typeof CARD_THEMES)[number];
const CARD_FALLBACK_THEME: CardTheme = "gradient";

export const QUESTION_CARDS_RESPONSE_SCHEMA = {
	type: "OBJECT",
	properties: {
		cards: {
			type: "ARRAY",
			items: {
				type: "OBJECT",
				properties: {
					question: { type: "STRING" },
					timestamp: { type: "NUMBER" },
					theme: { type: "STRING", enum: [...CARD_THEMES] },
					emoji: { type: "STRING" },
				},
				required: ["question", "timestamp", "theme", "emoji"],
				propertyOrdering: ["question", "timestamp", "theme", "emoji"],
			},
		},
	},
	required: ["cards"],
	propertyOrdering: ["cards"],
} as const;

export function buildQuestionCardsSystemPrompt(maxCards: number): string {
	return [
		"You segment a podcast/talk transcript into its topic shifts and write an intro card for each.",
		"A card poses the question the upcoming section answers — short, curiosity-driving, in the speaker's language (≤ 10 words).",
		`Return at most ${maxCards} cards. \`timestamp\` is the segment-boundary time (from the brackets) where the topic starts. Pick ONE fitting emoji per card and one theme from the allowed set. Skip micro-shifts; only real topic changes deserve a card.`,
	].join("\n");
}

/** Fail-safe parse: clamp timestamps into the transcript, coerce theme, cap. */
export function parseQuestionCardsResponse(
	text: string,
	segments: readonly PodcastSegment[],
	maxCards: number,
): QuestionCardsResult {
	const totalDuration = segments.length ? segments[segments.length - 1].end : 0;
	const root = parseJson(text) as { cards?: unknown } | null;
	const raw = Array.isArray(root?.cards) ? root.cards : [];
	const cards: QuestionCard[] = [];
	for (const item of raw) {
		if (cards.length >= maxCards) break;
		const r = item as Record<string, unknown>;
		const question = str(r.question);
		const timestamp = num(r.timestamp);
		if (!question || timestamp === undefined) continue;
		const theme = str(r.theme)?.toLowerCase();
		cards.push({
			question,
			timestamp: Math.min(Math.max(0, timestamp), totalDuration),
			theme: (CARD_THEMES as readonly string[]).includes(theme ?? "")
				? (theme as CardTheme)
				: CARD_FALLBACK_THEME,
			emoji: str(r.emoji) ?? "",
		});
	}
	cards.sort((a, b) => a.timestamp - b.timestamp);
	return { cards };
}

/** Question/topic cards, on Gemini. */
export async function generateQuestionCards(
	segments: readonly PodcastSegment[],
	maxCards = 5,
	options?: { signal?: AbortSignal; call?: PodcastGeminiCall },
): Promise<QuestionCardsResult> {
	const call = options?.call ?? callPodcastGemini;
	const text = await call({
		system: buildQuestionCardsSystemPrompt(maxCards),
		userText: `TRANSCRIPT (timestamped segments):\n${renderSegmentsForPrompt(segments)}\n\nWrite the topic cards now.`,
		responseSchema: QUESTION_CARDS_RESPONSE_SCHEMA,
		signal: options?.signal,
	});
	return parseQuestionCardsResponse(text, segments, maxCards);
}

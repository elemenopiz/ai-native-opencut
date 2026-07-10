/**
 * Vision self-review — the critic half of the Director's "generate → SEE → fix"
 * loop.
 *
 * THE GAP THIS CLOSES: the Director can generate takes but never SEES them, so
 * it can't tell a faithful clip from a broken one (wrong subject, deformed
 * anatomy, garbled text, a black frame). This module supplies the pure pieces of
 * a vision critic:
 *
 *  - {@link dataUrlToImageBlock} turns a decoded frame (a `data:` URL from
 *    `lib/media/last-frame.ts`) into an Anthropic image content block, so real
 *    pixels ride back to the model — both as a `reviewTake` tool_result (the
 *    interactive path) and as the critic's input (the automatic path).
 *  - {@link buildCriticUserBlocks} / {@link CRITIC_SYSTEM_PROMPT} frame a
 *    single, tool-less "judge these frames against the intent" model call.
 *  - {@link parseVerdict} coerces the critic's reply into a structured
 *    {@link CriticVerdict} the auto-review loop can act on deterministically.
 *  - {@link wantsAutoReview} decides whether a user turn opted into automatic
 *    self-correction.
 *
 * PURE LOGIC: no network, no React, no `DirectorApi`. The relay call + the bounded
 * self-correct loop live in `agent.ts`; everything here is unit-testable.
 */

import type Anthropic from "@anthropic-ai/sdk";

/**
 * The critic's structured decision about one reviewed take:
 *  - `pass` — the clip realizes the slot's intent; keep it.
 *  - `reroll-with-delta` — fundamentally wrong shot; regenerate from a REVISED
 *    full prompt (`revisedPrompt`).
 *  - `remix-with-anchor` — mostly right, one fixable flaw; edit the current take
 *    in place anchored on its own last frame, driven by a SHORT delta prompt
 *    (`revisedPrompt`).
 */
export type VerdictKind = "pass" | "reroll-with-delta" | "remix-with-anchor";

export const VERDICT_KINDS: readonly VerdictKind[] = [
	"pass",
	"reroll-with-delta",
	"remix-with-anchor",
] as const;

export interface CriticVerdict {
	verdict: VerdictKind;
	/** Plain-language justification, surfaced in the agent's step log. */
	reason: string;
	/**
	 * The prompt to act on when the verdict isn't `pass`:
	 *  - `reroll-with-delta` ⇒ a full, improved slot prompt to set before rerolling.
	 *  - `remix-with-anchor` ⇒ a short delta prompt (e.g. "add a sunset").
	 * Absent for `pass`.
	 */
	revisedPrompt?: string;
}

// ── frame → image content block ──────────────────────────────────────────────

/** `data:` URLs `generateThumbnail` can emit → the Anthropic image media types. */
const DATA_URL_RE =
	/^data:(image\/(?:jpeg|jpg|png|gif|webp));base64,([A-Za-z0-9+/=]+)$/;

type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/**
 * Convert a base64 `data:` image URL (as produced by `generateThumbnail`) into an
 * Anthropic base64 image block. Returns `null` for anything that isn't a
 * supported base64 image data URL (e.g. a remote `http(s)` URL or an unknown
 * mime) so callers can simply filter it out. `image/jpg` is normalized to the
 * canonical `image/jpeg` the API expects.
 */
export function dataUrlToImageBlock(
	dataUrl: string,
): Anthropic.ImageBlockParam | null {
	const match = dataUrl.match(DATA_URL_RE);
	if (!match) return null;
	const media_type = (
		match[1] === "image/jpg" ? "image/jpeg" : match[1]
	) as ImageMediaType;
	return {
		type: "image",
		source: { type: "base64", media_type, data: match[2] },
	};
}

// ── critic call framing ──────────────────────────────────────────────────────

/** System prompt for the tool-less critic model call. */
export const CRITIC_SYSTEM_PROMPT = [
	"You are a STRICT visual critic for an AI video reel. You are shown an INTENT (the prompt a generated clip was supposed to realize) and 1–3 frames sampled from that clip in order (first → last).",
	"Judge ONLY whether the frames faithfully realize the intent. Flag: the wrong subject or scene, missing key elements, deformed hands/faces/anatomy, garbled or misspelled on-screen text, empty/black/duplicated frames, or obvious generation artifacts. A clip that is merely stylistically different but on-brief PASSES.",
	"Reply with ONE minified JSON object and nothing else:",
	'{"verdict":"pass"|"reroll-with-delta"|"remix-with-anchor","reason":"<one sentence>","revisedPrompt":"<see rules>"}',
	"Rules:",
	'- "pass": the clip matches the intent. Omit revisedPrompt.',
	'- "reroll-with-delta": the shot is fundamentally wrong. revisedPrompt = a COMPLETE improved prompt for a fresh generation.',
	'- "remix-with-anchor": the shot is mostly right but has one fixable flaw. revisedPrompt = a SHORT delta instruction (e.g. "remove the extra finger", "add a sunset").',
	"Never invent detail the intent did not ask for. When unsure, prefer pass.",
].join("\n");

/**
 * Build the user-turn content for a critic call: the intent as text, then the
 * frames as image blocks (first → last). Frames that aren't decodable base64
 * data URLs are silently dropped.
 */
export function buildCriticUserBlocks(
	intent: string,
	frames: string[],
): Anthropic.ContentBlockParam[] {
	const blocks: Anthropic.ContentBlockParam[] = [
		{
			type: "text",
			text: `INTENT (what this clip must realize):\n${intent || "(no prompt set)"}\n\nThe clip's frames (first → last) follow. Judge them against the intent and reply with the JSON verdict.`,
		},
	];
	for (const frame of frames) {
		const block = dataUrlToImageBlock(frame);
		if (block) blocks.push(block);
	}
	return blocks;
}

// ── verdict parsing ──────────────────────────────────────────────────────────

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

/** Map a loose verdict string (synonyms included) to a {@link VerdictKind}, or null. */
function normalizeVerdict(raw: unknown): VerdictKind | null {
	const s = String(raw ?? "")
		.toLowerCase()
		.trim();
	if (!s) return null;
	if (s.includes("remix")) return "remix-with-anchor";
	if (s.includes("reroll") || s.includes("re-roll") || s.includes("regenerate"))
		return "reroll-with-delta";
	if (
		s.startsWith("pass") ||
		s === "keep" ||
		s === "ok" ||
		s === "good" ||
		s === "accept"
	)
		return "pass";
	return null;
}

/** A pass verdict is the fail-SAFE default — it stops the loop without spending. */
function passVerdict(reason: string): CriticVerdict {
	return { verdict: "pass", reason };
}

/**
 * Parse a critic model reply into a {@link CriticVerdict}. Always returns a valid
 * verdict — this is the deterministic gate the auto-review loop trusts, so it
 * fails SAFE: unparseable output, an unknown verdict, or a reroll/remix verdict
 * with NO `revisedPrompt` (nothing actionable) all collapse to `pass`, ending the
 * loop rather than spending on a guess.
 */
export function parseVerdict(text: string): CriticVerdict {
	const json = firstJsonObject(text);
	if (!json) return passVerdict("No verdict JSON found; keeping the take.");

	let obj: Record<string, unknown>;
	try {
		obj = JSON.parse(json) as Record<string, unknown>;
	} catch {
		return passVerdict("Verdict JSON was malformed; keeping the take.");
	}

	const kind = normalizeVerdict(obj.verdict);
	if (!kind) return passVerdict("Unrecognized verdict; keeping the take.");

	const reason =
		typeof obj.reason === "string" && obj.reason.trim()
			? obj.reason.trim()
			: typeof obj.critique === "string"
				? obj.critique.trim()
				: "";

	if (kind === "pass") return { verdict: "pass", reason };

	const revisedRaw =
		obj.revisedPrompt ?? obj.prompt ?? obj.delta ?? obj.remixPrompt;
	const revisedPrompt =
		typeof revisedRaw === "string" && revisedRaw.trim()
			? revisedRaw.trim()
			: undefined;

	// A corrective verdict with nothing to correct WITH is not actionable — fail
	// safe to pass so the loop doesn't reroll blindly.
	if (!revisedPrompt) {
		return passVerdict(
			reason
				? `${reason} (no revised prompt supplied; keeping the take.)`
				: "Corrective verdict had no revised prompt; keeping the take.",
		);
	}

	return { verdict: kind, reason, revisedPrompt };
}

// ── auto-review opt-in ───────────────────────────────────────────────────────

/**
 * Whether a user turn opted into automatic vision self-review after generation.
 * True when the studio setting is on, OR the message asks for quality in the
 * plain ways users phrase it ("make it good/great/perfect", "the best take",
 * "auto-review"). Deliberately narrow so an incidental "good" doesn't trigger a
 * spend loop.
 */
const AUTO_REVIEW_RE =
	/\b(?:auto[- ]?review|self[- ]?review|make (?:it|them|this|these) (?:look )?(?:good|great|perfect|right)|looks? (?:good|right|perfect)|best (?:quality|takes?|version)|high[- ]quality)\b/i;

export function wantsAutoReview(
	userMessage: string,
	settingEnabled: boolean,
): boolean {
	if (settingEnabled) return true;
	return AUTO_REVIEW_RE.test(userMessage);
}

// ── A/B pick critic (compareTake) ────────────────────────────────────────────
//
// The sibling of the single-take verdict above: instead of judging ONE take
// against its intent, the pick critic is shown SEVERAL candidate takes (each a
// short label + its frames) and names the one that best realizes the intent. It
// is the model half of `compareTake`'s auto-pick — the pure framing/parsing lives
// here (unit-testable, no network); the relay call + frame extraction live in
// `take-critic-adapter.ts`.

/** One labeled candidate in an A/B(/C…) pick: a short label plus its decoded frames. */
export interface PickCandidate {
	/** Short stable label the model refers to ("A", "B", …). */
	label: string;
	/** Decoded frames as base64 `data:` image URLs, first → last. */
	frames: string[];
}

/** The pick critic's structured decision: the winning label + a one-line why (or null = no confident pick). */
export interface CriticPick {
	label: string;
	reason?: string;
}

/** System prompt for the tool-less "pick the best candidate" model call. */
export const PICK_SYSTEM_PROMPT = [
	"You are a STRICT visual critic for an AI video reel. You are shown an INTENT (the prompt every candidate was meant to realize) and SEVERAL candidate takes, each introduced by a short label (A, B, …) followed by 1–3 frames sampled from that candidate in order (first → last).",
	"All candidates render the SAME intent from different models. Pick the SINGLE candidate that best realizes the intent — most faithful to the subject/scene, fewest artifacts (deformed hands/faces, garbled text, empty/black/duplicated frames), best overall quality. Judge fidelity to the intent, not raw prettiness.",
	"Reply with ONE minified JSON object and nothing else:",
	'{"winner":"<label>"|null,"reason":"<one sentence>"}',
	"Rules:",
	'- "winner": the label (e.g. "A") of the best candidate.',
	"- Use null ONLY when the candidates are genuinely indistinguishable in quality — prefer naming a winner.",
	"Never invent detail the intent did not ask for.",
].join("\n");

/** Deterministic short label for the Nth candidate: A, B, …, Z, then A1, B1, … */
export function pickLabel(index: number): string {
	const letter = String.fromCharCode(65 + (index % 26));
	const wrap = Math.floor(index / 26);
	return wrap === 0 ? letter : `${letter}${wrap}`;
}

/**
 * Build the user-turn content for a pick call: the intent as text, then, for each
 * candidate, a "Candidate <label>:" text marker followed by its frames as image
 * blocks (first → last). Candidates whose frames are all undecodable contribute
 * only their marker; a candidate with no frames at all is skipped entirely.
 */
export function buildPickUserBlocks(
	intent: string,
	candidates: PickCandidate[],
): Anthropic.ContentBlockParam[] {
	const blocks: Anthropic.ContentBlockParam[] = [
		{
			type: "text",
			text: `INTENT (what every candidate must realize):\n${intent || "(no prompt set)"}\n\nThe candidates and their frames follow. Judge each against the intent and reply with the JSON winner.`,
		},
	];
	for (const candidate of candidates) {
		const imageBlocks = candidate.frames
			.map(dataUrlToImageBlock)
			.filter((b): b is Anthropic.ImageBlockParam => b !== null);
		if (imageBlocks.length === 0) continue;
		blocks.push({
			type: "text",
			text: `Candidate ${candidate.label} (${imageBlocks.length} frame${
				imageBlocks.length === 1 ? "" : "s"
			}, first → last):`,
		});
		blocks.push(...imageBlocks);
	}
	return blocks;
}

/**
 * Parse a pick-critic model reply into a {@link CriticPick}, or `null` when there
 * is no confident, VALID pick. Fails SAFE to null (⇒ `compareTake` presents both
 * takes) on: unparseable output, an explicit `null`/missing winner, or a winner
 * whose label isn't one of `validLabels`. Label matching is case-insensitive.
 */
export function parsePick(
	text: string,
	validLabels: string[],
): CriticPick | null {
	const json = firstJsonObject(text);
	if (!json) return null;

	let obj: Record<string, unknown>;
	try {
		obj = JSON.parse(json) as Record<string, unknown>;
	} catch {
		return null;
	}

	const rawWinner = obj.winner ?? obj.label ?? obj.pick ?? obj.best;
	const winner = String(rawWinner ?? "")
		.toUpperCase()
		.trim();
	if (!winner || winner === "NULL") return null;

	const match = validLabels.find((l) => l.toUpperCase() === winner);
	if (!match) return null;

	const reason =
		typeof obj.reason === "string" && obj.reason.trim()
			? obj.reason.trim()
			: typeof obj.critique === "string" && obj.critique.trim()
				? obj.critique.trim()
				: undefined;

	return { label: match, reason };
}

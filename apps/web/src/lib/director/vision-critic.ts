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
 *  - {@link buildCriticUserBlocks} / {@link buildCriticSystemPrompt} frame a
 *    single, tool-less "judge these frames against the intent" model call. The
 *    critic judges on THREE axes: fidelity to the intent, MOTION coherence
 *    across the sampled frames (identity drift, morphing, flicker, warping),
 *    and — when a previous shot's frame is supplied — CROSS-SHOT continuity
 *    (same character/wardrobe/lighting/palette).
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
 *  - `pass` — the clip realizes the slot's intent AND holds together in motion; keep it.
 *  - `reroll-with-delta` — fundamentally wrong shot, or a motion defect bad
 *    enough that the whole clip must be regenerated; reroll from a REVISED full
 *    prompt (`revisedPrompt`).
 *  - `remix-with-anchor` — mostly right, one fixable flaw (a bad detail or a
 *    localized motion artifact); edit the current take in place anchored on its
 *    OWN last frame, driven by a SHORT delta prompt (`revisedPrompt`).
 *  - `remix-for-continuity` — the shot breaks CROSS-SHOT continuity with the
 *    previous shot / style bible; edit it in place anchored on the PRIOR shot's
 *    frame, driven by a SHORT delta naming what to match (`revisedPrompt`).
 */
export type VerdictKind =
	| "pass"
	| "reroll-with-delta"
	| "remix-with-anchor"
	| "remix-for-continuity";

export const VERDICT_KINDS: readonly VerdictKind[] = [
	"pass",
	"reroll-with-delta",
	"remix-with-anchor",
	"remix-for-continuity",
] as const;

/**
 * A small, closed set of WHY-it-failed buckets a {@link CriticVerdict}'s free-
 * prose `reason`/`temporalIssue` can be classified into. Exists so verdict
 * HISTORY (see {@link recordVerdict}) is aggregatable ("this prompt keeps
 * failing on identity-drift") instead of only diffable as prose.
 */
export type FailureAxis =
	| "identity-drift"
	| "motion-artifact"
	| "continuity-break"
	| "prompt-mismatch"
	| "exposure-color";

export const FAILURE_AXES: readonly FailureAxis[] = [
	"identity-drift",
	"motion-artifact",
	"continuity-break",
	"prompt-mismatch",
	"exposure-color",
] as const;

/**
 * Keyword heuristics for {@link classifyFailureAxes}. Deliberately loose
 * (prefix match, no trailing `\b`) so "morphs"/"morphing"/"drifted" etc. all
 * hit their stem — but each pattern still opens on a `\b` so it won't fire
 * inside an unrelated longer word (e.g. "amorphous" does not match "morph").
 */
const AXIS_KEYWORDS: Record<FailureAxis, RegExp> = {
	"identity-drift":
		/\b(identity|recast|drift|face (?:chang)|different (?:person|character|actor))/i,
	"motion-artifact":
		/\b(morph|warp|flicker|artifact|deform|garbl|glitch|jitter|stutter)/i,
	"continuity-break":
		/\b(continuity|palette|wardrobe|outfit|style bible|inconsist|lighting jump)/i,
	"prompt-mismatch":
		/\b(wrong (?:subject|scene)|doesn'?t (?:match|realize)|missing|off-?brief|unrelated|different (?:scene|subject|setting))/i,
	"exposure-color":
		/\b(exposure|overexpos|underexpos|washed out|too (?:dark|bright)|colou?r cast|white balance|black frame)/i,
};

/**
 * Classify a corrective verdict's free-prose `reason`/`temporalIssue` into zero
 * or more {@link FailureAxis} buckets (pure, deterministic, no model call).
 * `remix-for-continuity` always includes `continuity-break` (the verdict kind
 * itself says so). Falls back to `motion-artifact` (a temporal issue was
 * flagged) or `prompt-mismatch` (the general default) when no keyword matches,
 * so a corrective verdict is never left unclassified. Returns `[]` for `pass`
 * — nothing failed.
 */
export function classifyFailureAxes(v: {
	verdict: VerdictKind;
	reason?: string;
	temporalIssue?: string;
}): FailureAxis[] {
	if (v.verdict === "pass") return [];
	const axes = new Set<FailureAxis>();
	if (v.verdict === "remix-for-continuity") axes.add("continuity-break");
	const text = `${v.reason ?? ""} ${v.temporalIssue ?? ""}`.toLowerCase();
	for (const axis of FAILURE_AXES) {
		if (AXIS_KEYWORDS[axis].test(text)) axes.add(axis);
	}
	if (axes.size === 0) {
		axes.add(v.temporalIssue ? "motion-artifact" : "prompt-mismatch");
	}
	return [...axes];
}

export interface CriticVerdict {
	verdict: VerdictKind;
	/** Plain-language justification, surfaced in the agent's step log. */
	reason: string;
	/**
	 * The prompt to act on when the verdict isn't `pass`:
	 *  - `reroll-with-delta` ⇒ a full, improved slot prompt to set before rerolling.
	 *  - `remix-with-anchor` ⇒ a short delta prompt (e.g. "add a sunset").
	 *  - `remix-for-continuity` ⇒ a short delta naming what to match (e.g.
	 *    "match the teal jacket and warm sunset lighting of the previous shot").
	 * Absent for `pass`.
	 */
	revisedPrompt?: string;
	/**
	 * A one-phrase description of a MOTION/temporal defect the critic saw across
	 * the frames (identity drift, morphing, flicker, warping hands/faces).
	 * Populated whenever the critic flags motion trouble — even on a borderline
	 * `pass` — so the step log records it. Absent when motion is clean. Distinct
	 * from `reason`, which summarizes the overall verdict.
	 */
	temporalIssue?: string;
	/**
	 * A small, AGGREGATABLE classification of what went wrong, derived from
	 * `reason`/`temporalIssue` by {@link classifyFailureAxes}. Additive and
	 * backwards-compatible: `reason` stays the free-prose source of truth for the
	 * step log; `failureAxes` exists so verdict HISTORY (see
	 * {@link recordVerdict}/{@link recentVerdictsFor}) can be grouped/counted
	 * across generations instead of only diffed as prose. Absent for `pass`.
	 */
	failureAxes?: FailureAxis[];
}

/**
 * Optional cross-shot continuity context for a critic call. When `priorFrame` is
 * present the critic ALSO judges whether the current shot holds continuity with
 * the previous shot (and the style `bible`), and may return a
 * `remix-for-continuity` verdict. Absent ⇒ a plain single-take review.
 */
export interface ContinuityContext {
	/** A frame from the PREVIOUS shot (N-1), decoded to a `data:` image URL. */
	priorFrame?: string;
	/**
	 * Rendered style-bible descriptors the whole reel must hold (palette, lens/
	 * mood, setting, recurring cast) — see `styleBibleDescriptors` in
	 * `storyboard-plan.ts`. Shown to the critic so a continuity break is judged
	 * against the reel's stated look, not just the prior frame.
	 */
	bible?: string;
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

/**
 * Base system prompt for the tool-less critic model call: judge FIDELITY and
 * MOTION coherence of a single take. {@link buildCriticSystemPrompt} appends the
 * cross-shot continuity rules when a previous shot's frame is supplied.
 */
export const CRITIC_SYSTEM_PROMPT = [
	"You are a STRICT visual critic for an AI video reel. You are shown an INTENT (the prompt a generated clip was supposed to realize) and 1–3 frames sampled from that clip IN TIME ORDER (first → mid → last).",
	"Judge TWO things:",
	"1. FIDELITY — do the frames realize the intent? Flag the wrong subject or scene, missing key elements, deformed hands/faces/anatomy, garbled or misspelled on-screen text, empty/black/duplicated frames, or obvious generation artifacts. A clip that is merely stylistically different but on-brief passes this test.",
	"2. MOTION / TEMPORAL COHERENCE — read the frames as a SEQUENCE and flag defects that only show up across time: the subject's identity drifting (face/hair/build changing frame to frame), morphing or warping shapes, flicker, or hands/faces that deform as the shot moves. A single clean still can still come from a broken clip — judge the MOTION, not just one frame.",
	"Reply with ONE minified JSON object and nothing else:",
	'{"verdict":"pass"|"reroll-with-delta"|"remix-with-anchor","reason":"<one sentence>","temporalIssue":"<see rules>","revisedPrompt":"<see rules>"}',
	"Rules:",
	'- "pass": the clip realizes the intent AND holds together in motion. Omit revisedPrompt.',
	'- "reroll-with-delta": a fundamentally wrong shot, OR a motion defect bad enough that the whole clip must be regenerated (heavy morphing, an identity swap, pervasive flicker). revisedPrompt = a COMPLETE improved prompt for a fresh generation.',
	'- "remix-with-anchor": mostly right with ONE fixable flaw — a bad still detail (extra finger, wrong color, missing prop) OR a localized motion artifact. revisedPrompt = a SHORT delta instruction (e.g. "remove the extra finger", "steady the face so it stops morphing").',
	'- "temporalIssue": whenever you see ANY motion/temporal defect, name it in one short phrase (e.g. "face identity drifts between frames", "left hand morphs mid-shot"). Omit it when motion is clean. Set it even on a borderline pass so the log records it.',
	"Never invent detail the intent did not ask for. When unsure, prefer pass.",
].join("\n");

/**
 * Cross-shot continuity rules, appended to {@link CRITIC_SYSTEM_PROMPT} when a
 * previous shot's frame is in play. Adds the fourth verdict,
 * `remix-for-continuity`.
 */
const CONTINUITY_RULES = [
	"",
	"CROSS-SHOT CONTINUITY: the FIRST image is a REFERENCE frame from the PREVIOUS shot; the image(s) after it are the CURRENT shot (first → last). This reel is one continuous sequence, so the current shot must hold continuity with the previous one and with the STYLE BIBLE stated in the user turn: the SAME recurring character(s) and wardrobe, and a consistent lighting and color palette. Judge ONLY the elements that should PERSIST across shots — an intentional new location, framing, or action is fine; a recast character, a changed outfit on the same character, or a palette/lighting jump is NOT.",
	'If the current shot BREAKS continuity, reply with verdict "remix-for-continuity" and revisedPrompt = a SHORT delta naming what to match (e.g. "match the teal jacket and warm sunset lighting of the previous shot"). Reserve "remix-for-continuity" for continuity breaks; keep "reroll-with-delta"/"remix-with-anchor" for fidelity/motion problems. When continuity holds, judge fidelity and motion as usual.',
].join("\n");

/**
 * The critic system prompt for a call. Returns the base fidelity+motion prompt,
 * plus the cross-shot continuity rules when `continuity` is true (i.e. a prior
 * shot's frame is supplied).
 */
export function buildCriticSystemPrompt(continuity: boolean): string {
	return continuity
		? `${CRITIC_SYSTEM_PROMPT}\n${CONTINUITY_RULES}`
		: CRITIC_SYSTEM_PROMPT;
}

/**
 * Build the user-turn content for a critic call: the intent (and, for a
 * continuity review, the style bible) as text, then the frames as image blocks.
 * When `continuity.priorFrame` is present it is pushed FIRST as the previous
 * shot's reference, ahead of this shot's frames (first → last), and the intro
 * text explains that ordering. Frames that aren't decodable base64 data URLs are
 * silently dropped.
 *
 * FEED-FORWARD: automatically consults {@link recentVerdictsFor} for `intent`
 * and, when this prompt has a recorded failure history, folds a compact
 * "PRIOR ATTEMPTS" line into the intro so the critic doesn't repeat a mistake
 * it already caught. No new model call — it's a synchronous, in-memory lookup.
 * A silent no-op (identical output to before this existed) until a caller
 * starts recording verdicts via {@link recordVerdict}.
 */
export function buildCriticUserBlocks(
	intent: string,
	frames: string[],
	continuity?: ContinuityContext,
): Anthropic.ContentBlockParam[] {
	const priorBlock = continuity?.priorFrame
		? dataUrlToImageBlock(continuity.priorFrame)
		: null;

	const introParts = [
		`INTENT (what this clip must realize):\n${intent || "(no prompt set)"}`,
	];
	const history = recentVerdictsFor(intent);
	if (history) {
		introParts.push(
			`PRIOR ATTEMPTS ON THIS PROMPT (avoid repeating these mistakes):\n${history}`,
		);
	}
	if (priorBlock && continuity?.bible?.trim()) {
		introParts.push(
			`STYLE BIBLE (must hold across shots):\n${continuity.bible.trim()}`,
		);
	}
	introParts.push(
		priorBlock
			? "The FIRST image is a reference frame from the PREVIOUS shot; the image(s) after it are THIS shot's frames (first → last). Judge fidelity, motion, AND cross-shot continuity, then reply with the JSON verdict."
			: "The clip's frames (first → last) follow. Judge them against the intent and reply with the JSON verdict.",
	);

	const blocks: Anthropic.ContentBlockParam[] = [
		{ type: "text", text: introParts.join("\n\n") },
	];
	if (priorBlock) blocks.push(priorBlock);
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
	// Continuity must be checked BEFORE remix — "remix-for-continuity" contains
	// "remix", so the plain-remix branch would otherwise swallow it.
	if (s.includes("continuity")) return "remix-for-continuity";
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

/** Pull a trimmed string field off the parsed object, trying aliases in order. */
function stringField(
	obj: Record<string, unknown>,
	...keys: string[]
): string | undefined {
	for (const key of keys) {
		const v = obj[key];
		if (typeof v === "string" && v.trim()) return v.trim();
	}
	return undefined;
}

/** A pass verdict is the fail-SAFE default — it stops the loop without spending. */
function passVerdict(reason: string, temporalIssue?: string): CriticVerdict {
	return {
		verdict: "pass",
		reason,
		...(temporalIssue ? { temporalIssue } : {}),
	};
}

/**
 * Parse a critic model reply into a {@link CriticVerdict}. Always returns a valid
 * verdict — this is the deterministic gate the auto-review loop trusts, so it
 * fails SAFE: unparseable output, an unknown verdict, or a reroll/remix verdict
 * with NO `revisedPrompt` (nothing actionable) all collapse to `pass`, ending the
 * loop rather than spending on a guess. A `temporalIssue`, when present, is
 * carried through on every verdict (including `pass`).
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
	const temporalIssue = stringField(obj, "temporalIssue", "motionIssue");
	if (!kind)
		return passVerdict(
			"Unrecognized verdict; keeping the take.",
			temporalIssue,
		);

	const reason = stringField(obj, "reason", "critique") ?? "";

	if (kind === "pass") return passVerdict(reason, temporalIssue);

	const revisedPrompt = stringField(
		obj,
		"revisedPrompt",
		"prompt",
		"delta",
		"remixPrompt",
	);

	// A corrective verdict with nothing to correct WITH is not actionable — fail
	// safe to pass so the loop doesn't reroll blindly.
	if (!revisedPrompt) {
		return passVerdict(
			reason
				? `${reason} (no revised prompt supplied; keeping the take.)`
				: "Corrective verdict had no revised prompt; keeping the take.",
			temporalIssue,
		);
	}

	const failureAxes = classifyFailureAxes({
		verdict: kind,
		reason,
		temporalIssue,
	});

	return {
		verdict: kind,
		reason,
		revisedPrompt,
		...(temporalIssue ? { temporalIssue } : {}),
		...(failureAxes.length ? { failureAxes } : {}),
	};
}

// ── verdict memory (feed-forward) ────────────────────────────────────────────
//
// TIER-4 GAP THIS CLOSES: a {@link CriticVerdict} used to be transient — parsed,
// acted on once, then discarded, so a prompt that failed review one generation
// could fail the SAME way again next time with the critic none the wiser. This
// is an in-memory, per-session ledger (module-scoped Map — the same
// "pure-logic-plus-a-small-seam" idiom `cross-project-memory.ts` uses for its
// promote/seed rules, minus the async storage glue: there is no server-side or
// IndexedDB precedent for PER-GENERATION critic history, so in-memory is the
// right tier here — see that file's module doc for the promotion/seeding split
// this deliberately does NOT need). It never grows unbounded (capped per key
// and in total) and is READ automatically by {@link buildCriticUserBlocks} so a
// re-review of a previously-failed prompt carries "previously failed because X"
// context WITHOUT any new model call or persistence infrastructure.
//
// Recording is an explicit, separate step ({@link recordVerdict}) — parsing a
// verdict stays a pure function with no side effects. The auto-review loop
// (`agent.ts`, not owned by this module) is what actually SEES a slot's prompt
// + the parsed verdict together; wiring it to call `recordVerdict` after each
// `reviewTake` critique is a one-line addition there (see the module's callers)
// once this seam is on main.

/** One recorded critic decision, keyed by a normalized prompt. */
export interface VerdictRecord {
	/** Normalized (see {@link normalizePromptKey}) prompt/intent the take was judged against. */
	promptKey: string;
	verdict: VerdictKind;
	reason: string;
	failureAxes?: FailureAxis[];
	temporalIssue?: string;
	/** The reviewed take, when the caller has it. */
	takeId?: string;
	/** The slot the take belongs to, when the caller has it. */
	slotId?: string;
	/** `Date.now()` at record time (or an injected clock, for tests). */
	at: number;
}

/** Bound on how many records are kept per prompt key — recent history only. */
const MAX_VERDICTS_PER_KEY = 5;
/** Bound on how many distinct prompt keys the ledger tracks — evicts oldest. */
const MAX_LEDGER_KEYS = 200;

/** The ledger itself: normalized prompt key → its recent verdict records, oldest first. */
const verdictLedger = new Map<string, VerdictRecord[]>();

/**
 * Normalize a prompt/intent string into a stable ledger key: trimmed,
 * lower-cased, internal whitespace collapsed, length-capped. Two prompts that
 * differ only in casing/spacing hit the SAME history.
 */
export function normalizePromptKey(text: string): string {
	return (text ?? "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 200);
}

/**
 * Record a critic verdict against a prompt key (in-memory, this session only).
 * A no-op when `promptKey` is blank. Bounded on both axes (per-key recency cap,
 * total-keys eviction of the oldest key) so a long Director session never leaks
 * memory. Safe to call for EVERY verdict, including `pass` — {@link
 * recentVerdictsFor} only ever surfaces the non-pass ones.
 */
export function recordVerdict(input: {
	promptKey: string;
	verdict: CriticVerdict;
	takeId?: string;
	slotId?: string;
	at?: number;
}): void {
	const key = normalizePromptKey(input.promptKey);
	if (!key) return;

	const record: VerdictRecord = {
		promptKey: key,
		verdict: input.verdict.verdict,
		reason: input.verdict.reason,
		...(input.verdict.failureAxes?.length
			? { failureAxes: input.verdict.failureAxes }
			: {}),
		...(input.verdict.temporalIssue
			? { temporalIssue: input.verdict.temporalIssue }
			: {}),
		...(input.takeId ? { takeId: input.takeId } : {}),
		...(input.slotId ? { slotId: input.slotId } : {}),
		at: input.at ?? Date.now(),
	};

	const list = verdictLedger.get(key) ?? [];
	list.push(record);
	if (list.length > MAX_VERDICTS_PER_KEY) {
		list.splice(0, list.length - MAX_VERDICTS_PER_KEY);
	}
	verdictLedger.set(key, list);

	if (verdictLedger.size > MAX_LEDGER_KEYS) {
		const oldestKey = verdictLedger.keys().next().value;
		if (oldestKey !== undefined) verdictLedger.delete(oldestKey);
	}
}

/** Render one record as a compact, token-lean history line. */
function formatVerdictRecord(r: VerdictRecord): string {
	const axes = r.failureAxes?.length ? ` [${r.failureAxes.join(", ")}]` : "";
	const why = r.reason || r.temporalIssue || "unspecified issue";
	return `${r.verdict}${axes}: ${why}`;
}

/**
 * Compact, token-lean feed-forward retrieval: the most recent non-`pass`
 * verdicts recorded for a prompt (or, when nothing matches the prompt key, for
 * a takeId/slotId — a looser fallback so an asset-shaped lookup still finds
 * something). Returns `""` when there is no relevant failure history (the
 * common case — most prompts pass first try, and this seam is currently unread
 * until a caller starts recording). Never throws, never calls the model.
 */
export function recentVerdictsFor(
	promptOrAsset: string,
	opts?: { limit?: number },
): string {
	const needle = (promptOrAsset ?? "").trim();
	if (!needle) return "";
	const limit = Math.max(1, opts?.limit ?? 2);

	let records = verdictLedger.get(normalizePromptKey(needle)) ?? [];
	if (records.length === 0) {
		// Fallback: scan for a takeId/slotId match. The ledger is capped, so a
		// linear scan is cheap.
		records = [];
		for (const list of verdictLedger.values()) {
			for (const r of list) {
				if (r.takeId === needle || r.slotId === needle) records.push(r);
			}
		}
	}

	const failures = records.filter((r) => r.verdict !== "pass");
	if (failures.length === 0) return "";
	return failures.slice(-limit).reverse().map(formatVerdictRecord).join("; ");
}

/**
 * Wipe the verdict ledger. Exported for tests, and for a caller (e.g. the
 * project-switch reset path) that wants to avoid one project's failure history
 * leaking into another's critic prompts within the same browser session.
 */
export function clearVerdictMemory(): void {
	verdictLedger.clear();
}

// ── auto-review opt-in ───────────────────────────────────────────────────────

/**
 * Whether a user turn opted into automatic vision self-review after generation.
 * True only on a DELIBERATE quality request: an explicit "auto-review" /
 * "self-review", an imperative "make it/them/this/these (look) good/great/
 * perfect/right", a "best quality/take/version", or "high-quality". Bare
 * incidental phrasing like "a park that looks good at sunset" must NOT match —
 * a corrective generation is real spend, so the matcher stays narrow.
 */
const AUTO_REVIEW_RE =
	/\b(?:auto[- ]?review|self[- ]?review|make (?:it|them|this|these) (?:look )?(?:good|great|perfect|right)|best (?:quality|takes?|version)|high[- ]quality)\b/i;

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
 *
 * `history` is an optional compact feed-forward line — typically
 * {@link recentVerdictsFor}`(intent)` — folded into the intro so a repeated A/B
 * pick for a prompt that has failed single-take review before carries that
 * context too. Omit (or pass `""`) for the plain, unchanged prompt; callers
 * that don't pass it get byte-identical output to before this existed.
 */
export function buildPickUserBlocks(
	intent: string,
	candidates: PickCandidate[],
	history?: string,
): Anthropic.ContentBlockParam[] {
	const historyLine = history?.trim()
		? `\n\nPRIOR ATTEMPTS ON THIS PROMPT (avoid repeating these mistakes):\n${history.trim()}`
		: "";
	const blocks: Anthropic.ContentBlockParam[] = [
		{
			type: "text",
			text: `INTENT (what every candidate must realize):\n${intent || "(no prompt set)"}${historyLine}\n\nThe candidates and their frames follow. Judge each against the intent and reply with the JSON winner.`,
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

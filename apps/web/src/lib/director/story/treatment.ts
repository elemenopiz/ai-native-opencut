/**
 * Story Engine, stage 3 — the Treatment prompt + parse (model call #1)
 * (`docs/plans/2026-07-20-story-engine-design.md` §3, build partition SE-2).
 *
 * The creative leap of the whole pipeline: given a {@link StoryBrief} and a
 * deterministic {@link FootageInventory} (SE-1's `inventory.ts`), decide the
 * STORY ORDER — what to lead with (the hook), what comes next, what to drop
 * — as a compact {@link Treatment}. This module owns exactly the two halves
 * of that ONE structured-output model call:
 *
 *  - {@link buildTreatmentPrompt} frames the call: a fixed
 *    {@link TREATMENT_SYSTEM_PROMPT} (the rubric/schema/rules) plus a
 *    per-run user block (the brief, a compact inventory digest, and the
 *    resolved target duration + tolerance). Same "fixed system prompt +
 *    per-call user content" split `edit-critic.ts` and
 *    `asset-understanding.ts` use for their own structured-output calls.
 *  - {@link parseTreatment} coerces the model's raw reply into a validated
 *    {@link Treatment} — tolerant JSON extraction (fenced or unfenced, same
 *    `firstJsonObject` idiom `edit-critic.ts`'s `parseEditCritique` uses),
 *    then VALIDATION: every `materialRefs` id must resolve against the
 *    inventory that grounded the call (unknown ids fail the whole parse with
 *    a structured, coaching error — the same "code + coaching message that
 *    NAMES the recovery path" philosophy `DirectorResult`'s converted
 *    lookup-failure contract uses in `types.ts`, applied here to MODEL
 *    output instead of a verb call), every section's `targetSec` must be a
 *    positive finite number, `order` is normalized to a clean 0-based
 *    sequence, and the section COUNT is capped at
 *    {@link TREATMENT_MAX_SECTIONS} by TRUNCATING (never failing) — only the
 *    duration-sum-vs-target check is soft, riding back as an advisory
 *    `deviationNote` rather than a hard failure, per the design doc's
 *    explicit "±10%" tolerance language.
 *
 * PURE LOGIC, same discipline `inventory.ts`/`edit-critic.ts`/`craft/*.ts`
 * all share: no network, no React, no `DirectorApi`, NO MODEL CALL anywhere
 * in this file. The actual relay round-trip (and the single coached retry
 * `parseTreatment`'s error `retryHint` feeds) is SE-4's job, wiring this
 * module's two pure functions into the `draftCut` verb.
 */

import type {
	FootageInventory,
	FootageInventoryAsset,
	StoryBrief,
	Treatment,
	TreatmentSection,
} from "./types";

// ── tunables ──────────────────────────────────────────────────────────────

/**
 * Hard cap on sections a parsed {@link Treatment} carries — token/UI economy
 * and assembly sanity, same spirit as `edit-critic.ts`'s
 * `MAX_EDIT_CRITIQUE_ISSUES`. Enforced at PARSE by truncating to the
 * strongest-ordered prefix (never a hard failure) — see
 * {@link parseTreatment}.
 */
export const TREATMENT_MAX_SECTIONS = 12;

/**
 * Tolerance band (as a fraction of the target) that a Treatment's
 * section-`targetSec` sum is allowed to deviate from the brief's resolved
 * target duration before {@link parseTreatment} attaches a `deviationNote`.
 * Advisory only — never a hard parse failure (design doc §3: "sections
 * summing to target ±10%").
 */
export const TREATMENT_DURATION_TOLERANCE_FRACTION = 0.1;

/** Cap on ids listed verbatim in a retry hint / structured error before falling back to an "…and N more" tail — mirrors `DirectorResult.available`'s own "~20 + …and N more" cap in `types.ts`. */
const MAX_RETRY_HINT_IDS = 30;

// ── prompt building ──────────────────────────────────────────────────────

/**
 * Fixed system prompt for the Treatment model call. Carries the schema, the
 * hook-first rule, and the editing-first / never-generate rule — everything
 * that does NOT change per run. Per-run data (the brief, the inventory
 * digest, the resolved target) rides the user block instead, built by
 * {@link buildTreatmentPrompt}.
 */
export const TREATMENT_SYSTEM_PROMPT = [
	"You are the story editor of an AI video editing pipeline. You are given a BRIEF (what the user wants) and an INVENTORY digest of the footage that actually exists in their project. Your job is the creative leap of the whole pipeline: decide the STORY ORDER — what to lead with, what comes next, what to drop — as a compact Treatment.",
	"Reply with ONE minified JSON object and nothing else:",
	'{"logline":"<one-sentence pitch for the cut>","sections":[{"intent":"<what this section is FOR, e.g. \\"hook\\", \\"problem\\", \\"demo\\", \\"cta\\">","targetSec":<number, planned length of this section in seconds>,"materialRefs":["<inventory asset id>", ...],"order":<0-based position in the final sequence>}]}',
	"Rules:",
	"- HOOK FIRST: section 1 (order 0) MUST use your single strongest, most attention-grabbing material from the inventory — the moment that makes a cold viewer keep watching. Never bury the best material later in the cut.",
	'- EDITING-FIRST, NEVER GENERATE: this pipeline edits the user\'s OWN footage only — it never generates new material. "materialRefs" MUST be real ids copied VERBATIM from the INVENTORY digest below; never invent an id, never reference footage that isn\'t listed. When a section\'s narrative need has NO matching material anywhere in the inventory, leave "materialRefs" as an EMPTY array and say so explicitly inside "intent" (e.g. "cutaway to product — GAP: no matching b-roll in the library") instead of inventing footage or forcing a wrong materialRef.',
	'- DURATION: "targetSec" values across all sections should sum to within ±10% of the brief\'s target duration (stated below), when one is given. Every "targetSec" must be a positive number.',
	'- ORDER: "order" must be 0-based and sequential, matching the sections\' narrative sequence (0 = first, i.e. the hook).',
	`- SECTION COUNT: produce AT MOST ${TREATMENT_MAX_SECTIONS} sections — fewer, well-chosen sections beat many thin ones.`,
	"Never invent detail the brief/inventory did not show you. When genuinely unsure whether a piece of material fits a section, prefer the explicit gap note over a wrong materialRef.",
].join("\n");

/** The brief, rendered compactly (verbatim instruction + only the fields actually resolved — omitted fields add zero bytes). */
export function formatTreatmentBriefBlock(brief: StoryBrief): string {
	const lines: string[] = [`INSTRUCTION: ${JSON.stringify(brief.instruction)}`];
	if (brief.goal) lines.push(`GOAL: ${brief.goal}`);
	if (brief.audience) lines.push(`AUDIENCE: ${brief.audience}`);
	if (brief.tone) lines.push(`TONE: ${brief.tone}`);
	if (brief.format) lines.push(`FORMAT: ${brief.format}`);
	if (brief.aspect) lines.push(`ASPECT: ${brief.aspect}`);
	if (brief.mustInclude?.length)
		lines.push(`MUST INCLUDE: ${brief.mustInclude.join("; ")}`);
	return lines.join("\n");
}

/**
 * The resolved target duration + tolerance band, rendered as the concrete
 * numbers the model should hit — spelling out the ±10% band in seconds
 * rather than leaving the arithmetic to the model. No target resolved
 * (`brief.targetDuration` unset) ⇒ an explicit "pick a natural length" line,
 * never a fabricated number (mirrors `TargetDurationSource`'s `"unset"` doc
 * comment in `types.ts`: assembly is free to pick a natural length).
 */
export function formatTreatmentTargetBlock(brief: StoryBrief): string {
	const td = brief.targetDuration;
	if (!td || td.source === "unset") {
		return "TARGET DURATION: none specified — pick a natural, tight length for the available material (prefer well under 2 minutes for a hook-first cut).";
	}
	const lo = td.sec * (1 - TREATMENT_DURATION_TOLERANCE_FRACTION);
	const hi = td.sec * (1 + TREATMENT_DURATION_TOLERANCE_FRACTION);
	const noteText = td.note ? ` (${td.note})` : "";
	return `TARGET DURATION: ${td.sec}s${noteText}, source=${td.source}. Your sections' "targetSec" values MUST sum to between ${lo.toFixed(1)}s and ${hi.toFixed(1)}s (±10% tolerance).`;
}

/**
 * One inventory asset, rendered as one digest line. `FootageInventoryAsset`
 * (frozen, SE-1) carries only PRESENCE flags for understanding/transcript —
 * not the caption text or a segment count — so this renders "understood /
 * understood(deep)" and "speech:yes / speech:none / speech:UNCHECKED" facets
 * honestly from what the inventory actually has, rather than fabricating a
 * caption or a count the type doesn't carry. See this file's header/report
 * for the frozen-type friction note.
 */
function formatTreatmentAssetLine(asset: FootageInventoryAsset): string {
	const bits: string[] = [asset.kind, `${asset.durationSec.toFixed(1)}s`];

	bits.push(
		asset.hasUnderstanding
			? asset.hasDeepUnderstanding
				? "understood(deep)"
				: "understood"
			: "no-understanding",
	);

	if (asset.hasTranscriptSegments === true) bits.push("speech:yes");
	else if (asset.hasTranscriptSegments === false)
		bits.push("speech:none(transcribed-silent)");
	else if (asset.possiblyUntranscribed)
		bits.push("speech:UNCHECKED(possibly-untranscribed)");
	else bits.push("speech:n/a");

	if (asset.hasBeatGrid) bits.push("beatGrid:yes");
	if (asset.hasSilenceMap) bits.push("silenceMap:yes");

	return `- ${JSON.stringify(asset.id)}: ${bits.join(" · ")}`;
}

/**
 * The full inventory digest: an aggregate header (asset count, total
 * duration, `speechShare`, `untranscribedCount` — surfaced honestly so the
 * model can nudge "transcribe more first" via a gap note when it looks
 * relevant) followed by one line per asset, in inventory order. Every asset
 * is listed (never truncated) — `materialRefs` must resolve against the
 * FULL inventory, so hiding rows would make some valid ids undiscoverable to
 * the model and manufacture false "unknown materialRef" retries.
 */
export function formatTreatmentInventoryDigest(
	inventory: FootageInventory,
): string {
	const header = `INVENTORY (${inventory.assets.length} assets, ${inventory.totalDurationSec.toFixed(1)}s total, speechShare=${Math.round(inventory.speechShare * 100)}%, ${inventory.untranscribedCount} possibly-untranscribed):`;
	const lines = inventory.assets.map(formatTreatmentAssetLine);
	return [header, ...lines].join("\n");
}

/** The two blocks {@link buildTreatmentPrompt} returns for ONE Treatment model call. */
export interface TreatmentPrompt {
	system: string;
	user: string;
}

/**
 * Build the system + user blocks for the ONE structured-output Treatment
 * model call. DETERMINISTIC: identical `brief`/`inventory` input ⇒ an
 * identical `{ system, user }` pair, byte for byte (no timestamps, no
 * randomness, no ambient state read) — see `treatment.test.ts`'s
 * determinism assertion.
 */
export function buildTreatmentPrompt(
	brief: StoryBrief,
	inventory: FootageInventory,
): TreatmentPrompt {
	const userParts = [
		formatTreatmentBriefBlock(brief),
		formatTreatmentTargetBlock(brief),
		formatTreatmentInventoryDigest(inventory),
		`Produce the Treatment now: ONE minified JSON object per the schema above, at most ${TREATMENT_MAX_SECTIONS} sections, section 1 (order 0) = the hook.`,
	];
	return { system: TREATMENT_SYSTEM_PROMPT, user: userParts.join("\n\n") };
}

// ── reply parsing (tolerant extraction, then hard validation) ──────────────

/**
 * Extract the first balanced top-level JSON object from arbitrary text,
 * fenced (```json ... ```) or unfenced. Own local copy of the
 * `firstJsonObject` idiom `edit-critic.ts`'s `parseEditCritique` uses — same
 * "own copy, not import" discipline this package already follows for small
 * decoupled parsing helpers (see `craft/types.ts`'s `CraftOp` doc comment).
 */
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

/** Why {@link parseTreatment} rejected a reply outright (never thrown — always returned as a structured `ok: false` result). */
export type TreatmentParseFailureReason =
	| "no-json"
	| "malformed-json"
	| "invalid-shape"
	| "invalid-sections"
	| "unknown-material-refs";

/**
 * A structured, ACTIONABLE parse failure — the "recovery-error coaching"
 * philosophy (`DirectorResult`'s `code`/`error`/`available` split in
 * `types.ts`) applied to MODEL output instead of a verb call: `message` is
 * the bare fact, `retryHint` (on the enclosing {@link ParseTreatmentResult})
 * NAMES the fix, and `validIds` (when present) is the recovery list, same
 * role `DirectorResult.available` plays for a bad enum/id lookup.
 */
export interface TreatmentParseError {
	reason: TreatmentParseFailureReason;
	/** Plain-language explanation of what was wrong — the bare fact, without the coaching suffix `retryHint` carries. */
	message: string;
	/** `materialRefs` ids the model referenced that don't resolve against the inventory. Present only when `reason === "unknown-material-refs"`. */
	unknownRefs?: string[];
	/** Every real inventory asset id, for retry-prompt coaching. Present only when `unknownRefs` is. */
	validIds?: string[];
}

/** Successful parse: a validated {@link Treatment} plus zero or more ADVISORY notes (never a failure on their own). */
export interface ParsedTreatmentOk {
	ok: true;
	treatment: Treatment;
	/** Present when the sections' `targetSec` sum fell outside the ±{@link TREATMENT_DURATION_TOLERANCE_FRACTION} band around the resolved target duration. Soft — the treatment is still returned `ok: true`. */
	deviationNote?: string;
	/** Present when the model returned more than {@link TREATMENT_MAX_SECTIONS} sections and the tail was truncated. */
	truncationNote?: string;
}

/**
 * A hard parse/validation failure. `retryHint` is a ready-to-append string
 * for the SINGLE retry the design doc calls for (SE-4's job to actually
 * retry) — always non-empty, always names the concrete fix.
 */
export interface ParsedTreatmentError {
	ok: false;
	error: TreatmentParseError;
	retryHint: string;
}

export type ParseTreatmentResult = ParsedTreatmentOk | ParsedTreatmentError;

function fail(
	reason: TreatmentParseFailureReason,
	message: string,
	retryHint: string,
	extra?: Pick<TreatmentParseError, "unknownRefs" | "validIds">,
): ParsedTreatmentError {
	return { ok: false, error: { reason, message, ...extra }, retryHint };
}

/** Render a capped, quoted id list for a retry hint — mirrors `DirectorResult.available`'s own "~20 ids + …and N more" cap. */
function formatIdList(ids: string[]): string {
	const quoted = ids.map((id) => JSON.stringify(id));
	if (quoted.length <= MAX_RETRY_HINT_IDS) return quoted.join(", ");
	const shown = quoted.slice(0, MAX_RETRY_HINT_IDS).join(", ");
	return `${shown}, …and ${quoted.length - MAX_RETRY_HINT_IDS} more`;
}

/** One section mid-validation, before order-normalization/truncation. */
interface DraftSection {
	intent: string;
	targetSec: number;
	materialRefs: string[];
	order: number;
}

/**
 * Parse + validate a Treatment model reply into a {@link ParseTreatmentResult}.
 *
 * Pipeline: tolerant JSON extraction (fenced/unfenced) → JSON.parse → shape
 * checks (`logline` non-empty, `sections` a non-empty array, each section has
 * a non-empty `intent`, a positive finite `targetSec`, and a `materialRefs`
 * array of strings) → every `materialRefs` id resolves against `inventory`
 * (unknown ids fail the WHOLE parse with a structured, coaching error listing
 * every valid id — never silently dropped, since a dangling ref is the model
 * having invented footage, exactly what ADR-007's editing-first rule
 * forbids) → `order` normalized to a clean 0-based sequence (sorted by the
 * model's reported `order`, ties broken by array position) → capped at
 * {@link TREATMENT_MAX_SECTIONS} by TRUNCATING the weakest tail (never a
 * failure — order-normalizing FIRST means the hook and other strong,
 * early-ordered sections always survive truncation) → an OPTIONAL soft
 * duration check against `opts.targetDurationSec` (when supplied), attaching
 * a `deviationNote` rather than failing when the sum falls outside the
 * ±10% tolerance.
 *
 * `opts.targetDurationSec` is intentionally a separate optional parameter
 * rather than re-deriving it from a `StoryBrief` — this function's only
 * required grounding is the `FootageInventory` (for `materialRefs`
 * validation); the caller (SE-4) already has `brief.targetDuration?.sec`
 * to hand, and many runs have no resolved target at all (`"unset"` — see
 * `TargetDurationSource` in `types.ts`), in which case the duration check is
 * simply skipped (no `deviationNote`), never fabricated.
 */
export function parseTreatment(
	replyText: string,
	inventory: FootageInventory,
	opts: { targetDurationSec?: number } = {},
): ParseTreatmentResult {
	const json = firstJsonObject(replyText);
	if (!json) {
		return fail(
			"no-json",
			"No JSON object found in the model's reply.",
			"Your reply did not contain a JSON object. Reply again with ONLY the minified Treatment JSON object described in the schema — no prose, no markdown fences.",
		);
	}

	let obj: Record<string, unknown>;
	try {
		obj = JSON.parse(json) as Record<string, unknown>;
	} catch (e) {
		const detail = e instanceof Error ? e.message : String(e);
		return fail(
			"malformed-json",
			`Treatment JSON could not be parsed: ${detail}`,
			"Your reply's JSON was malformed and could not be parsed. Reply again with ONLY well-formed, minified JSON matching the schema — no trailing commas, no comments, no unescaped quotes.",
		);
	}

	const logline = typeof obj.logline === "string" ? obj.logline.trim() : "";
	if (!logline) {
		return fail(
			"invalid-shape",
			'Treatment JSON is missing a non-empty "logline" string.',
			'Your reply was missing a non-empty "logline" string. Reply again with the full schema, including a one-sentence "logline".',
		);
	}

	const rawSections = Array.isArray(obj.sections) ? obj.sections : [];
	if (rawSections.length === 0) {
		return fail(
			"invalid-shape",
			'Treatment JSON is missing a non-empty "sections" array.',
			'Your reply had no sections. Reply again with a "sections" array containing at least one section, per the schema.',
		);
	}

	const shapeIssues: string[] = [];
	const drafts: DraftSection[] = [];
	rawSections.forEach((raw, i) => {
		if (!raw || typeof raw !== "object") {
			shapeIssues.push(`section ${i}: not an object`);
			return;
		}
		const o = raw as Record<string, unknown>;
		const intent = typeof o.intent === "string" ? o.intent.trim() : "";
		const targetSec =
			typeof o.targetSec === "number" ? o.targetSec : Number.NaN;
		const materialRefs = Array.isArray(o.materialRefs)
			? o.materialRefs.filter((r): r is string => typeof r === "string")
			: null;

		if (!intent) shapeIssues.push(`section ${i}: missing non-empty "intent"`);
		if (!Number.isFinite(targetSec) || targetSec <= 0)
			shapeIssues.push(
				`section ${i}: "targetSec" must be a positive finite number`,
			);
		if (materialRefs === null)
			shapeIssues.push(
				`section ${i}: "materialRefs" must be an array of strings`,
			);

		if (intent && Number.isFinite(targetSec) && targetSec > 0 && materialRefs) {
			const order =
				typeof o.order === "number" && Number.isFinite(o.order) ? o.order : i;
			drafts.push({ intent, targetSec, materialRefs, order });
		}
	});

	if (shapeIssues.length > 0) {
		const detail = shapeIssues.join("; ");
		return fail(
			"invalid-sections",
			`Treatment sections had invalid shape: ${detail}.`,
			`Some sections were invalid: ${detail}. Every section needs a non-empty "intent" string, a positive finite "targetSec" number, and a "materialRefs" array of strings (may be empty when nothing fits — say so in "intent" instead). Reply again with corrected sections.`,
		);
	}

	// materialRefs must resolve against the inventory that grounded this call.
	const validIdSet = new Set(inventory.assets.map((a) => a.id));
	const unknownRefs = Array.from(
		new Set(
			drafts.flatMap((s) =>
				s.materialRefs.filter((ref) => !validIdSet.has(ref)),
			),
		),
	);
	if (unknownRefs.length > 0) {
		const validIds = inventory.assets.map((a) => a.id);
		return {
			ok: false,
			error: {
				reason: "unknown-material-refs",
				message: `Unknown materialRefs: ${unknownRefs.map((r) => JSON.stringify(r)).join(", ")}.`,
				unknownRefs,
				validIds,
			},
			retryHint: `The following materialRefs don't exist in the footage inventory: ${unknownRefs.map((r) => JSON.stringify(r)).join(", ")}. Valid ids are: ${formatIdList(validIds)}. Reply again using ONLY ids from that list — or an empty "materialRefs" array with an explicit gap note in "intent" when no real material fits.`,
		};
	}

	// Order-normalize FIRST (sorted by reported order, ties broken by array
	// position) so truncation below keeps the strongest, earliest-ordered
	// sections — the hook (order 0) survives any cap.
	const ordered = drafts
		.map((s, i) => ({ s, i }))
		.sort((a, b) => a.s.order - b.s.order || a.i - b.i)
		.map((x) => x.s);

	const wasTruncated = ordered.length > TREATMENT_MAX_SECTIONS;
	const capped = ordered.slice(0, TREATMENT_MAX_SECTIONS);

	const sections: TreatmentSection[] = capped.map((s, i) => ({
		intent: s.intent,
		targetSec: s.targetSec,
		materialRefs: s.materialRefs,
		order: i,
	}));

	const truncationNote = wasTruncated
		? `Treatment had ${ordered.length} sections; truncated to the strongest ${TREATMENT_MAX_SECTIONS} (by order).`
		: undefined;

	// Soft duration check — advisory only, never a hard failure.
	let deviationNote: string | undefined;
	const targetDurationSec = opts.targetDurationSec;
	if (
		targetDurationSec != null &&
		Number.isFinite(targetDurationSec) &&
		targetDurationSec > 0
	) {
		const sum = sections.reduce((acc, s) => acc + s.targetSec, 0);
		const lo = targetDurationSec * (1 - TREATMENT_DURATION_TOLERANCE_FRACTION);
		const hi = targetDurationSec * (1 + TREATMENT_DURATION_TOLERANCE_FRACTION);
		if (sum < lo || sum > hi) {
			const pct = Math.round(
				Math.abs(((sum - targetDurationSec) / targetDurationSec) * 100),
			);
			const direction = sum > targetDurationSec ? "over" : "under";
			deviationNote = `Sections sum to ${sum.toFixed(1)}s; target was ${targetDurationSec}s (±10% = ${lo.toFixed(1)}–${hi.toFixed(1)}s) — ${direction} by ${pct}%.`;
		}
	}

	return {
		ok: true,
		treatment: { logline, sections },
		...(deviationNote ? { deviationNote } : {}),
		...(truncationNote ? { truncationNote } : {}),
	};
}

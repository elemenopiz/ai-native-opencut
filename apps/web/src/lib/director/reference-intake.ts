/**
 * Reference intake — the INPUT twin of the vision self-review loop.
 *
 * THE GAP THIS CLOSES: today the Director only ever SEES its OWN output (a
 * generated take, via `reviewTake`/`vision-critic.ts`). It has no eyes on the
 * user's INPUT: a dropped style reference (a moodboard, a film still, a product
 * shot) or a character photo. So a user who hands over "make it look like THIS"
 * gets a plan built from words, not from the picture they actually attached.
 *
 * This module supplies the pure pieces that turn reference IMAGES into the two
 * artifacts the Director already knows how to honor:
 *
 *  - a {@link StyleBible} (palette / lens+mood / setting) that seeds the
 *    reel-level consistency context (`consistency-prompt.ts`) and can be passed
 *    straight into `storyboard({ bible })`, so every generated shot inherits the
 *    referenced LOOK; and
 *  - an optional {@link DerivedPersonaSketch} (name + physical descriptor + which
 *    reference image is the best face anchor) that feeds the persona seed-lock
 *    path, so a dropped character photo makes that CHARACTER recur shot to shot.
 *
 * The shape deliberately mirrors `vision-critic.ts`:
 *  - {@link buildIntakeUserBlocks} / {@link REFERENCE_INTAKE_SYSTEM_PROMPT} frame
 *    one tool-less "look at these references and describe the look" model call,
 *    with the references riding as Anthropic image blocks (real pixels, reusing
 *    `dataUrlToImageBlock`).
 *  - {@link parseReferenceDerivation} coerces the model's reply into a structured
 *    {@link DerivedReference} the intake verb can act on deterministically — and,
 *    like `parseVerdict`, it FAILS SAFE: unparseable output yields an empty style
 *    and no persona, so a bad model reply never fabricates a look.
 *
 * PURE LOGIC by default: no React, no `DirectorApi`. {@link relayDeriveReferences}
 * is the one production seam that touches the network (the same stateless
 * `/api/llm/agent` relay the agent uses) — injected into the `intakeReferences`
 * verb so headless tests swap in a stub.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { StyleBible } from "./storyboard-plan";
import { dataUrlToImageBlock } from "./vision-critic";

/**
 * A character the model recognized as consistent across the reference photos —
 * the raw sketch the intake verb turns into a real persona (descriptor + anchor
 * image) on the seed-lock path.
 */
export interface DerivedPersonaSketch {
	/** Short display name / role for the character (e.g. "Mara", "The Founder"). */
	name: string;
	/** Detailed, identity-anchoring physical descriptor — reused verbatim as the persona's `descriptor`. */
	descriptor: string;
	/**
	 * 0-based index into the reference images of the single best FACE anchor —
	 * the clearest, most front-on portrait. Clamped into range by the parser.
	 */
	anchorIndex: number;
}

/**
 * The structured result of looking at a user's reference images: the visual look
 * as a {@link StyleBible} plus, when the references center on a person, a
 * {@link DerivedPersonaSketch}. `summary` is a one-line, human-readable recap for
 * the step log / brief note.
 */
export interface DerivedReference {
	/** The derived look — palette / lens+mood / setting. Empty object ⇒ nothing usable derived. */
	style: StyleBible;
	/** Present ⇒ the references depict a consistent character worth locking. */
	persona?: DerivedPersonaSketch;
	/** One-sentence recap of what the references establish. */
	summary: string;
}

/** The tool-less model call that turns reference images into a {@link DerivedReference}. */
export type DeriveReferencesFn = (
	images: string[],
	hint?: string,
) => Promise<DerivedReference>;

// ── model-call framing ───────────────────────────────────────────────────────

/** System prompt for the tool-less reference-intake model call. */
export const REFERENCE_INTAKE_SYSTEM_PROMPT = [
	"You are the Director's INTAKE eye. You are shown 1–6 REFERENCE images a user attached to steer a short video reel — these are STYLE references (a moodboard, a film still, a product shot, a location) and/or a CHARACTER photo. An optional HINT states what the user wants.",
	"Your job is to translate what you SEE into a reusable creative brief so every generated shot inherits this look. Describe only what is actually visible; never invent a look the images don't show.",
	"Reply with ONE minified JSON object and nothing else:",
	'{"style":{"palette":"<color grade / palette>","lensMood":"<lens, depth of field, film stock, overall mood>","setting":"<environment, time of day, lighting, atmosphere>"},"persona":{"name":"<short name/role>","descriptor":"<detailed physical description: age range, build, hair, face, wardrobe, distinguishing features>","anchorIndex":<0-based index of the clearest front-on portrait>},"summary":"<one sentence>"}',
	"Rules:",
	"- style: fill every field you can from the images. Omit a field (or the whole style object) only if the references genuinely say nothing about it. Keep each field a compact phrase, not a paragraph.",
	"- persona: include ONLY when the references clearly center on a specific PERSON whose identity should recur across shots (a character/spokesperson photo). For pure style/mood/location boards with no consistent person, OMIT persona entirely.",
	"- anchorIndex: the index of the single image that is the best face anchor (clearest, most front-on). If only one image, it is 0.",
	"- Prefer the HINT for intent, but the IMAGES are the source of truth for the look.",
	"When unsure whether the references depict a lockable character, omit persona rather than guess.",
].join("\n");

/**
 * Build the user-turn content for a reference-intake call: the hint as text, then
 * each reference as an image block (index order preserved so `anchorIndex` lines
 * up). Frames that aren't decodable base64 data URLs are silently dropped.
 */
export function buildIntakeUserBlocks(
	images: string[],
	hint?: string,
): Anthropic.ContentBlockParam[] {
	const trimmedHint = (hint ?? "").trim();
	const blocks: Anthropic.ContentBlockParam[] = [
		{
			type: "text",
			text: `${
				trimmedHint ? `HINT (what the user wants): ${trimmedHint}\n\n` : ""
			}The ${images.length} reference image(s) follow in order (index 0 first). Describe the look as the JSON brief.`,
		},
	];
	for (const image of images) {
		const block = dataUrlToImageBlock(image);
		if (block) blocks.push(block);
	}
	return blocks;
}

// ── derivation parsing ───────────────────────────────────────────────────────

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

/** Trim a loose value to a non-empty string, or `undefined`. */
function cleanStr(v: unknown): string | undefined {
	if (typeof v !== "string") return undefined;
	const t = v.trim();
	return t ? t : undefined;
}

/** Coerce a loose `style` object into a {@link StyleBible} (only non-empty fields kept). */
function parseStyle(raw: unknown): StyleBible {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const obj = raw as Record<string, unknown>;
	const palette = cleanStr(obj.palette);
	const lensMood = cleanStr(obj.lensMood ?? obj.lens ?? obj.mood);
	const setting = cleanStr(obj.setting ?? obj.location);
	return {
		...(palette ? { palette } : {}),
		...(lensMood ? { lensMood } : {}),
		...(setting ? { setting } : {}),
	};
}

/**
 * Coerce a loose `persona` object into a {@link DerivedPersonaSketch}, or
 * `undefined` when there's nothing lockable. A persona is only real if it has a
 * non-empty `descriptor` (identity is the point) — a name alone is dropped.
 * `anchorIndex` is coerced to an integer and clamped into `[0, imageCount - 1]`
 * so a hallucinated index can never point out of bounds.
 */
function parsePersona(
	raw: unknown,
	imageCount: number,
): DerivedPersonaSketch | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const obj = raw as Record<string, unknown>;
	const descriptor = cleanStr(obj.descriptor);
	if (!descriptor) return undefined; // no identity → not a lockable persona.
	const name = cleanStr(obj.name) ?? "Reference character";
	const rawIndex = Number(obj.anchorIndex);
	const maxIndex = Math.max(0, imageCount - 1);
	const anchorIndex = Number.isFinite(rawIndex)
		? Math.min(maxIndex, Math.max(0, Math.floor(rawIndex)))
		: 0;
	return { name, descriptor, anchorIndex };
}

/**
 * Parse a reference-intake model reply into a {@link DerivedReference}. Always
 * returns a valid object — this is the deterministic gate the intake verb trusts,
 * so it FAILS SAFE: unparseable output, malformed JSON, or a reply with no usable
 * style all collapse to an EMPTY style + no persona (the verb then simply changes
 * nothing rather than seeding a fabricated look). `imageCount` bounds `anchorIndex`.
 */
export function parseReferenceDerivation(
	text: string,
	imageCount: number,
): DerivedReference {
	const empty = (summary: string): DerivedReference => ({ style: {}, summary });

	const json = firstJsonObject(text);
	if (!json)
		return empty("No reference brief could be parsed from the model reply.");

	let obj: Record<string, unknown>;
	try {
		obj = JSON.parse(json) as Record<string, unknown>;
	} catch {
		return empty("The reference brief JSON was malformed.");
	}

	const style = parseStyle(obj.style);
	const persona = parsePersona(obj.persona, imageCount);
	const summary =
		cleanStr(obj.summary) ??
		(styleHasContent(style) || persona
			? "Derived a look from the reference image(s)."
			: "The reference image(s) yielded no usable look.");

	return { style, ...(persona ? { persona } : {}), summary };
}

/** True when a {@link StyleBible} carries at least one non-empty style field. */
export function styleHasContent(style: StyleBible): boolean {
	return Boolean(
		style.palette?.trim() ||
			style.lensMood?.trim() ||
			style.setting?.trim() ||
			(style.characters?.length ?? 0) > 0,
	);
}

/**
 * Render a derived {@link StyleBible} as the one-line STYLE string the durable
 * DIRECTOR BRIEF (`director-brief.ts`) stores — palette, lens/mood, and setting
 * joined into a compact rule so the referenced look survives across turns (D4).
 * Returns `""` when nothing is worth recording.
 */
export function styleBibleToBriefLine(style: StyleBible): string {
	const parts = [style.palette, style.lensMood, style.setting]
		.map((p) => p?.trim())
		.filter((p): p is string => Boolean(p));
	return parts.join("; ");
}

// ── production model call (the one network seam) ─────────────────────────────

/** The browser-side endpoint of the stateless server relay (mirrors `agent.ts`). */
const AGENT_RELAY_URL = "/api/llm/agent";

/** Pull the concatenated text out of an Anthropic assistant content array. */
function textOfContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(b): b is Anthropic.TextBlock =>
				!!b &&
				typeof b === "object" &&
				(b as { type?: string }).type === "text",
		)
		.map((b) => b.text)
		.join("");
}

/**
 * Production {@link DeriveReferencesFn}: one tool-less, non-streaming relay call
 * that sends the reference images as image blocks and parses the reply. This is
 * the default the `intakeReferences` verb uses; tests inject a stub instead.
 * Throws on a relay/transport error (the verb catches and reports it) — a
 * PARSE failure, by contrast, fails safe to an empty derivation.
 */
export const relayDeriveReferences: DeriveReferencesFn = async (
	images,
	hint,
) => {
	const res = await fetch(AGENT_RELAY_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			messages: [
				{ role: "user", content: buildIntakeUserBlocks(images, hint) },
			],
			system: REFERENCE_INTAKE_SYSTEM_PROMPT,
			tools: [],
			// Non-streaming: we want the whole reply as one JSON body to parse.
			stream: false,
		}),
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as {
			error?: string;
			message?: string;
		} | null;
		throw new Error(
			`Reference intake relay error (${res.status}): ${
				body?.message ?? body?.error ?? "unknown error"
			}`,
		);
	}
	const body = (await res.json()) as { content?: unknown };
	return parseReferenceDerivation(textOfContent(body.content), images.length);
};

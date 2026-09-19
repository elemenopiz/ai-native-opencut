/**
 * Persona prompt helpers — weave a persona's locked identity descriptor into the
 * two prompts that drive reference-conditioned consistency:
 *   1. the per-shot reference still (gpt-image-2 /images/edits), and
 *   2. the Seedance video generation itself (belt-and-suspenders).
 * Keeping these pure makes them trivial to unit-test and reuse server + client.
 *
 * NAMED REFERENCE HANDLES (docs/plans/2026-09-18-commercial-prompt-patterns.md
 * §3) and PER-REFERENCE ROLE LABELS (§4) live here too. The doc's whole point:
 * identity gets REFERENCED, never re-described — `@Orlando opens the door`
 * instead of restating hair/build/wardrobe on every shot — and a multi-
 * reference call tells the model explicitly what each image is FOR rather
 * than leaving it to infer. `toReferenceHandle` turns a display name (a
 * persona's `name`, already persisted per-project via `/api/studio/personas`
 * — see `stores/persona-store.ts` — so the handle rides on storage that
 * already exists) into a valid `@handle` token; `buildReferenceContractSentence`
 * turns a `ReferenceImage[]` into the explicit-use sentence.
 */

import type {
	ReferenceImage,
	ReferenceRole,
} from "@/lib/studio/backends/types";

/** Strip trailing punctuation/whitespace so fragments compose cleanly. */
function trimEnd(s: string): string {
	return s.trim().replace(/[.,\s]+$/, "");
}

/**
 * Prompt for /images/edits: keep THIS character (from the reference images) and
 * place them into the requested scene. The descriptor anchors identity textually
 * alongside the visual anchor image.
 */
export function composePersonaScenePrompt(
	descriptor: string,
	scenePrompt: string,
): string {
	const id = trimEnd(descriptor);
	const scene = trimEnd(scenePrompt);
	return [
		`Keep the exact same character shown in the reference image(s): ${id}.`,
		`Preserve their facial features, hairstyle, build and identity precisely —`,
		`it must be unmistakably the same person.`,
		`Place them in this scene: ${scene}.`,
		`Photorealistic, consistent character, natural lighting.`,
	].join(" ");
}

/** Weave the descriptor into the video-generation prompt for extra anchoring. */
export function composePersonaVideoPrompt(
	prompt: string,
	descriptor: string,
): string {
	return `${trimEnd(prompt)}. Featuring ${trimEnd(descriptor)}.`;
}

// ─── Named reference handles ────────────────────────────────────────────────
// §3: "Every locked asset gets a name, then is addressed by handle in later
// prompts." Byorn already mints positional `@Image1`/`@Video2` tokens
// per-attachment in generation-form.tsx; what's missing (and what lives here)
// is a SEMANTIC handle that survives past one generation call because it's
// derived from something already named and persisted — a persona's `name` —
// rather than from attachment order.

/**
 * Turn a display name ("Orlando", "the spy costume", "hologram img") into a
 * valid handle body — alphanumeric + underscore, matching the doc's own
 * examples (`Orlando`, `Orlando_spy_costume`, `hologram_img`, `watch_img`).
 * Deterministic and case-preserving, so calling this twice on the same
 * persona name always yields the same handle — that determinism, not new
 * storage, is what makes the handle "persist across a project": as long as
 * the persona's `name` is persisted (it already is — see the module header),
 * `toReferenceHandle(persona.name)` reproduces the identical `@handle` every
 * time it's needed, with nothing new to save or migrate.
 *
 * Returns `null` for input with no usable characters at all (e.g. "" or
 * "!!!") — callers should fall back to a positional handle in that case.
 */
export function toReferenceHandle(name: string): string | null {
	const cleaned = name
		.trim()
		.replace(/[^A-Za-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
	if (!cleaned) return null;
	// A token that starts with a digit reads ambiguously as a number in prose
	// ("@9lives") — prefix rather than reject, so a name like "99 Luftballons"
	// still round-trips to a usable handle.
	return /^[0-9]/.test(cleaned) ? `Ref_${cleaned}` : cleaned;
}

/** Format a handle body as the literal `@token` mentioned in prompts.
 *  Idempotent — passing an already-`@`-prefixed handle back in is a no-op —
 *  so call sites don't need to track whether a string has been formatted yet. */
export function formatReferenceHandle(handle: string): string {
	const body = handle.startsWith("@") ? handle.slice(1) : handle;
	return `@${body}`;
}

/**
 * The one-time sentence that BINDS a handle to a persona's identity — spoken
 * once so every later prompt can just address `@handle` instead of restating
 * "same face, same hair, same build" on every shot. Mirrors
 * `composePersonaScenePrompt`'s identity-preservation language so a
 * handle-aware prompt is exactly as strict about likeness as the positional
 * one, just phrased as an introduction rather than an instruction to keep.
 */
export function bindReferenceHandleSentence(
	handle: string,
	descriptor: string,
): string {
	const token = formatReferenceHandle(handle);
	const id = trimEnd(descriptor);
	return (
		`${token} is the character shown in the reference image(s): ${id}. ` +
		`Preserve their facial features, hairstyle, build and identity precisely — ` +
		`it must be unmistakably the same person.`
	);
}

/**
 * Handle-aware, DELTA-ONLY video prompt — the mechanism's whole payoff. Once
 * a handle is bound (`bindReferenceHandleSentence`, said once), every later
 * prompt for that character carries only what CHANGES: `@Orlando opens the
 * door` rather than `@Orlando opens the door. Featuring <full descriptor
 * again>.` (contrast `composePersonaVideoPrompt`, which re-asserts the
 * descriptor on every call — the thing this function exists to stop doing).
 * Leaves the prompt untouched if it already addresses the handle, so a
 * caller can pass the same prompt through repeatedly without accumulating
 * duplicate mentions.
 */
export function composeHandlePersonaPrompt(
	prompt: string,
	handle: string,
): string {
	const token = formatReferenceHandle(handle);
	const trimmed = trimEnd(prompt);
	if (!trimmed) return trimmed;
	const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const alreadyAddressed = new RegExp(`(^|\\s)${escaped}(\\s|$)`, "i").test(
		trimmed,
	);
	return alreadyAddressed ? trimmed : `${token} ${trimmed}`;
}

// ─── Per-reference role labels ──────────────────────────────────────────────
// §4: "Not 'here are two references, figure it out' — an explicit contract
// per image." One clause per role, phrased close to the source material's own
// contract sentences ("use image 1 exclusively for the character's
// appearance, and image 2 only for the environment, lighting, atmosphere,
// materials, and architectural language").

const REFERENCE_ROLE_PHRASE: Record<ReferenceRole, string> = {
	appearance: "the character's appearance",
	environment:
		"the environment, lighting, atmosphere, materials, and architectural language",
	grade: "color grading and tonal balance",
	style: "style, mood, and lighting",
};

/**
 * Turn a roled reference list into the explicit-use contract sentence the
 * prompt sends to the model — so it's told what each reference is FOR
 * instead of being left to infer. References without a `role` are skipped
 * (they're still sent to the provider via the plain `referenceImages[]`
 * array; they just get no explicit-use clause). A reference with a `handle`
 * is addressed by name (`@Orlando`); one without falls back to its 1-based
 * position in the FULL `refs` array (`image 2`) so the numbering always
 * matches the order the references are actually attached in.
 *
 * Returns `""` when no reference carries a role — callers should skip
 * appending anything to the prompt in that case rather than send an empty
 * sentence.
 */
export function buildReferenceContractSentence(refs: ReferenceImage[]): string {
	const clauses = refs
		.map((ref, i) => ({ ref, position: i + 1 }))
		.filter(
			(
				entry,
			): entry is {
				ref: ReferenceImage & { role: ReferenceRole };
				position: number;
			} => entry.ref.role != null,
		)
		.map(({ ref, position }, i) => {
			const label = ref.handle
				? formatReferenceHandle(ref.handle)
				: `image ${position}`;
			const qualifier = i === 0 ? "exclusively" : "only";
			return `use ${label} ${qualifier} for ${REFERENCE_ROLE_PHRASE[ref.role]}`;
		});
	if (clauses.length === 0) return "";
	const body = clauses.join("; ");
	return `${body.charAt(0).toUpperCase()}${body.slice(1)}.`;
}

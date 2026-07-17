/**
 * "Keep face & pose" identity lock for reference-image generation.
 *
 * Nano Banana Pro (Gemini Flash Image) has no dedicated "preserve identity"
 * parameter — it follows explicit natural-language edit instructions
 * instead. So the lock is implemented as an instruction block around the
 * prompt at request-build time (here), rather than:
 *  - living in the visible textarea, which would mean rewriting the user's
 *    own draft out from under them every time they toggle the setting; or
 *  - becoming a new field in the `/api/studio/image` server contract, which
 *    would require the server to understand and special-case it instead of
 *    just forwarding a prompt string it already knows how to handle.
 *
 * WHY INSTRUCTION-FIRST (v2): with the lock appended after the prompt, a
 * draft that *describes a person* ("a handsome young cowboy…") won the fight
 * for who appears in the frame — the model kept the pose from the reference
 * but invented a new face to match the description. Leading with the lock,
 * framing the task as an EDIT of the reference photo, and stating outright
 * that any person the directions mention IS the reference person closes that
 * gap: the prompt then reads as wardrobe/setting/role directions for that
 * same person, not as a spec for a new one.
 *
 * Keeping it a pure string transform also makes it trivial to test and to
 * preview (e.g. in a tooltip) without touching the request path.
 */

export const IDENTITY_LOCK_INSTRUCTION =
	'Identity lock — this is an edit of the attached reference photo of a real person. The output MUST show this exact same person: identical face, facial features, skin tone, and hair, in the same body pose, instantly recognizable as them. Never substitute a different, idealized, or generic person. If the directions below describe a person or character (for example "a cowboy"), that is THIS person playing that role — same face, same pose — in that wardrobe and setting. Everything else is free to change exactly as the directions say: clothing, background, environment, lighting, props, camera, and style. Only if the directions explicitly ask to change their face, expression, or pose may those change.';

/**
 * Wraps the user's prompt in the identity-lock instruction when `locked` is
 * true — instruction first, then the draft as "Directions:" (see the header
 * comment for why the order matters). Returns the prompt unchanged when
 * `locked` is false or the prompt is empty/whitespace-only (nothing
 * meaningful to lock onto).
 */
export function withIdentityLock(prompt: string, locked: boolean): string {
	if (!locked || !prompt.trim()) return prompt;
	return `${IDENTITY_LOCK_INSTRUCTION}\n\nDirections: ${prompt}`;
}

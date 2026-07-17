/**
 * "Keep face & pose" identity lock for reference-image generation.
 *
 * Nano Banana Pro (Gemini Flash Image) has no dedicated "preserve identity"
 * parameter — it follows explicit natural-language edit instructions
 * instead. So the lock is implemented as an instruction block appended to
 * the prompt at request-build time (here), rather than:
 *  - living in the visible textarea, which would mean rewriting the user's
 *    own draft out from under them every time they toggle the setting; or
 *  - becoming a new field in the `/api/studio/image` server contract, which
 *    would require the server to understand and special-case it instead of
 *    just forwarding a prompt string it already knows how to handle.
 *
 * Keeping it a pure string transform also makes it trivial to test and to
 * preview (e.g. in a tooltip) without touching the request path.
 */

export const IDENTITY_LOCK_INSTRUCTION =
	"Identity lock: the person in the reference image must remain EXACTLY the same — identical face, facial features, identity, and body pose. Do not alter, restyle, or reinterpret their face or pose. Everything else is free to change as the instructions above describe: clothing, background, setting, lighting, objects, and surroundings. If the instructions above explicitly ask to change the face, expression, or pose, those instructions win.";

/**
 * Appends the identity-lock instruction block after the user's prompt when
 * `locked` is true. Returns the prompt unchanged when `locked` is false or
 * the prompt is empty/whitespace-only (nothing meaningful to lock onto).
 */
export function withIdentityLock(prompt: string, locked: boolean): string {
	if (!locked || !prompt.trim()) return prompt;
	return `${prompt}\n\n${IDENTITY_LOCK_INSTRUCTION}`;
}

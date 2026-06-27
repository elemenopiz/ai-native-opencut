/**
 * Persona prompt helpers — weave a persona's locked identity descriptor into the
 * two prompts that drive reference-conditioned consistency:
 *   1. the per-shot reference still (gpt-image-2 /images/edits), and
 *   2. the Seedance video generation itself (belt-and-suspenders).
 * Keeping these pure makes them trivial to unit-test and reuse server + client.
 */

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

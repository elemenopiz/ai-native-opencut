/**
 * Image generation presets — Higgsfield-style structured image workflows.
 *
 * Like the camera presets, each is a prompt template woven around the user's
 * input plus sensible size/count defaults. The two beyond "freeform" target the
 * two highest-leverage artifacts in an AI-video pipeline, where consistency is
 * everything:
 *
 *   - Storyboard      — up to N consistent panels mapping to shots (à la
 *                       Higgsfield's storyboard generator).
 *   - Character sheet — one composite "model sheet" reused as the identity
 *                       anchor for every image-to-video shot (à la Soul ID).
 */

import type { ImageSize } from "@/lib/studio/image-generator";

export type ImagePresetId = "freeform" | "storyboard" | "character-sheet";

export interface ImagePreset {
	id: ImagePresetId;
	label: string;
	/** Shown under the header when the preset is active. */
	description: string;
	placeholder: string;
	recommendedSize: ImageSize;
	/** Whether the multi-image count control applies (storyboard is one board). */
	allowsMultiple: boolean;
	/** Builds the final prompt sent to the image backend. */
	buildPrompt: (input: string, opts?: { panels?: number }) => string;
}

function clean(input: string): string {
	return input.trim().replace(/\s+/g, " ");
}

export const IMAGE_PRESETS: Record<ImagePresetId, ImagePreset> = {
	freeform: {
		id: "freeform",
		label: "Freeform",
		description:
			"Generate character, scene, or product stills to use as image-to-video reference frames.",
		placeholder:
			"A cinematic still of a woman in her 30s standing in a rain-soaked Tokyo alley, neon reflections, film grain…",
		recommendedSize: "1536x1024",
		allowsMultiple: true,
		buildPrompt: (input) => clean(input),
	},

	storyboard: {
		id: "storyboard",
		label: "Storyboard",
		description:
			"Lay out your scene as a numbered multi-panel board with consistent character and style across shots — then send panels to image-to-video.",
		placeholder:
			"A detective enters a dim warehouse, finds a glowing briefcase, opens it, and recoils as light floods the room…",
		recommendedSize: "1536x1024",
		allowsMultiple: false,
		buildPrompt: (input, opts) => {
			const panels = opts?.panels ?? 6;
			return [
				`A clean ${panels}-panel film storyboard laid out as an even grid, depicting this sequence in order: ${clean(input)}.`,
				`Each panel is a distinct cinematic shot, numbered 1 to ${panels} in the corner.`,
				`Keep the SAME character design, art style, color palette and lighting consistent across every panel.`,
				`Professional storyboard / animatic look with clear framing and thin borders between panels.`,
			].join(" ");
		},
	},

	"character-sheet": {
		id: "character-sheet",
		label: "Character Sheet",
		description:
			"Generate a reference sheet of one character from multiple angles — your identity anchor to feed every image-to-video shot for consistency.",
		placeholder:
			"A grizzled space pilot in her 40s, short silver hair, scarred cheek, worn orange flight jacket, utility belt…",
		recommendedSize: "1536x1024",
		allowsMultiple: true,
		buildPrompt: (input) =>
			[
				`A professional character reference sheet (model sheet) of this exact character: ${clean(input)}.`,
				`Show the SAME character with identical design, outfit and proportions from multiple views — front, 3/4, side profile and back —`,
				`plus a row of three facial-expression close-ups and one full-body turnaround.`,
				`Even studio lighting, plain neutral background, consistent colors, subtle view labels, character-design-sheet layout.`,
			].join(" "),
	},
};

export const IMAGE_PRESET_ORDER: ImagePresetId[] = [
	"freeform",
	"storyboard",
	"character-sheet",
];

export const STORYBOARD_PANEL_OPTIONS = [4, 6, 8] as const;

/**
 * Animated caption STYLE presets.
 *
 * These drive the styling of subtitle text elements that already carry
 * word-level timings (from local Whisper transcription). They do NOT touch
 * transcription — they only decide how a caption line is drawn frame-by-frame
 * by the canvas renderer's karaoke path (see services/renderer/nodes/text-node.ts).
 *
 * The per-word state model (not-yet-narrated / being-narrated / already-narrated)
 * and the pop + highlight-box treatments are adapted from the MIT-licensed
 * pycaps project (github.com/francozanardi/pycaps), whose CSS templates key
 * off `.word`, `.word-being-narrated` and `.word-already-narrated` classes.
 * The preset taxonomy (karaoke / pop / highlight-box / clean subtitle) mirrors
 * the MIT-licensed vanta caption map (github.com/itsjwill/vanta).
 */

import type { CreateTextElement, TextBackground } from "@/types/timeline";
import type { ElementAnimations } from "@/types/animation";

export type CaptionPresetId =
	| "karaoke-pop"
	| "highlight-box"
	| "bounce"
	| "clean-bold"
	| "hype"
	| "classic-outline"
	| "neon-glow";

export interface CaptionStylePreset {
	id: CaptionPresetId;
	name: string;
	description: string;
	fontSize: number;
	fontFamily: string;
	fontWeight: "normal" | "bold";
	/** Color of words not yet spoken. */
	color: string;
	/** Color of words already spoken (progressive karaoke fill). */
	highlightColor: string;
	/** Color of the word currently being spoken. Falls back to highlightColor. */
	wordActiveColor?: string;
	/** Rounded box drawn behind the currently-spoken word. */
	wordActiveBackground?: string;
	/** Scale multiplier for the currently-spoken word (1.0 = no pop). */
	wordPopScale: number;
	/** Outline color drawn around glyphs (CapCut-style readability outline). */
	strokeColor?: string;
	/** Outline width as a ratio of font size (0 = none, ~0.08 = bold outline). */
	strokeWidth?: number;
	/** Background box behind the whole caption line. */
	background: Omit<TextBackground, "enabled"> & { enabled: boolean };
	/** Vertical position as a ratio of canvas height (0 = top, 1 = bottom). */
	yPositionRatio: number;
	/** Whether the caption line fades/scales in when it appears. */
	animateSegmentIn: boolean;
}

export const CAPTION_PRESETS: CaptionStylePreset[] = [
	{
		id: "karaoke-pop",
		name: "Karaoke Pop",
		description: "Words fill in as spoken; the active word pops.",
		fontSize: 5,
		fontFamily: "Inter",
		fontWeight: "bold",
		color: "#FFFFFF",
		highlightColor: "#FACC15",
		wordActiveColor: "#FACC15",
		wordPopScale: 1.25,
		strokeColor: "#000000",
		strokeWidth: 0.08,
		background: {
			enabled: false,
			color: "transparent",
			cornerRadius: 0,
			paddingX: 0,
			paddingY: 0,
			offsetX: 0,
			offsetY: 0,
		},
		yPositionRatio: 0.36,
		animateSegmentIn: false,
	},
	{
		id: "highlight-box",
		name: "Highlight Box",
		description: "Active word sits inside a colored box (word-focus).",
		fontSize: 4.5,
		fontFamily: "Inter",
		fontWeight: "bold",
		color: "#FFFFFF",
		highlightColor: "#FFFFFF",
		wordActiveColor: "#FFFFFF",
		wordActiveBackground: "#F76F00",
		wordPopScale: 1.1,
		background: {
			enabled: false,
			color: "transparent",
			cornerRadius: 0,
			paddingX: 0,
			paddingY: 0,
			offsetX: 0,
			offsetY: 0,
		},
		yPositionRatio: 0.38,
		animateSegmentIn: true,
	},
	{
		id: "bounce",
		name: "Bounce",
		description: "Each word bounces in big; spoken words turn cyan.",
		fontSize: 5.5,
		fontFamily: "Inter",
		fontWeight: "bold",
		color: "#FFFFFF",
		highlightColor: "#22D3EE",
		wordActiveColor: "#22D3EE",
		wordPopScale: 1.4,
		strokeColor: "#000000",
		strokeWidth: 0.09,
		background: {
			enabled: false,
			color: "transparent",
			cornerRadius: 0,
			paddingX: 0,
			paddingY: 0,
			offsetX: 0,
			offsetY: 0,
		},
		yPositionRatio: 0.36,
		animateSegmentIn: true,
	},
	{
		id: "clean-bold",
		name: "Clean Bold",
		description: "Readable bold subtitle bar; no per-word coloring.",
		fontSize: 4,
		fontFamily: "Inter",
		fontWeight: "bold",
		color: "#FFFFFF",
		// Same color for spoken/unspoken → no karaoke color shift, just clean text.
		highlightColor: "#FFFFFF",
		wordActiveColor: "#FFFFFF",
		wordPopScale: 1.0,
		background: {
			enabled: true,
			color: "#000000",
			cornerRadius: 6,
			paddingX: 12,
			paddingY: 6,
			offsetX: 0,
			offsetY: 0,
		},
		yPositionRatio: 0.4,
		animateSegmentIn: false,
	},
	{
		id: "hype",
		name: "Hype",
		description: "Punchy pop with yellow active word (TikTok-style).",
		fontSize: 6,
		fontFamily: "Inter",
		fontWeight: "bold",
		color: "#DDDDDD",
		highlightColor: "#FFFFFF",
		wordActiveColor: "#FFFF00",
		wordPopScale: 1.3,
		strokeColor: "#000000",
		strokeWidth: 0.1,
		background: {
			enabled: false,
			color: "transparent",
			cornerRadius: 0,
			paddingX: 0,
			paddingY: 0,
			offsetX: 0,
			offsetY: 0,
		},
		yPositionRatio: 0.36,
		animateSegmentIn: true,
	},
	{
		id: "classic-outline",
		name: "Classic Outline",
		description: "White text with a heavy black outline; no box.",
		fontSize: 4.5,
		fontFamily: "Inter",
		fontWeight: "bold",
		color: "#FFFFFF",
		highlightColor: "#FFFFFF",
		wordActiveColor: "#FFFFFF",
		wordPopScale: 1.0,
		strokeColor: "#000000",
		strokeWidth: 0.11,
		background: {
			enabled: false,
			color: "transparent",
			cornerRadius: 0,
			paddingX: 0,
			paddingY: 0,
			offsetX: 0,
			offsetY: 0,
		},
		yPositionRatio: 0.4,
		animateSegmentIn: false,
	},
	{
		id: "neon-glow",
		name: "Neon Glow",
		description: "Bright active word with a dark outline for punch.",
		fontSize: 5.5,
		fontFamily: "Inter",
		fontWeight: "bold",
		color: "#FFFFFF",
		highlightColor: "#F0ABFC",
		wordActiveColor: "#E879F9",
		wordPopScale: 1.2,
		strokeColor: "#3B0764",
		strokeWidth: 0.09,
		background: {
			enabled: false,
			color: "transparent",
			cornerRadius: 0,
			paddingX: 0,
			paddingY: 0,
			offsetX: 0,
			offsetY: 0,
		},
		yPositionRatio: 0.36,
		animateSegmentIn: true,
	},
];

export function getCaptionPreset(id: CaptionPresetId): CaptionStylePreset {
	return CAPTION_PRESETS.find((p) => p.id === id) ?? CAPTION_PRESETS[0];
}

/**
 * Entry animation for a caption line, adapted from pycaps' `fade_in` +
 * `zoom_in` on `narration-starts`. Times are relative to the element's own
 * start (local time), matching how the renderer resolves animation channels.
 */
export function buildCaptionEntryAnimation(elementKey: string): ElementAnimations {
	const prefix = `cap-${elementKey}`;
	return {
		channels: {
			"transform.scale": {
				valueKind: "number",
				keyframes: [
					{ id: `${prefix}-s0`, time: 0, value: 0.82, interpolation: "linear" },
					{ id: `${prefix}-s1`, time: 0.12, value: 1.04, interpolation: "linear" },
					{ id: `${prefix}-s2`, time: 0.2, value: 1, interpolation: "linear" },
				],
			},
			opacity: {
				valueKind: "number",
				keyframes: [
					{ id: `${prefix}-o0`, time: 0, value: 0, interpolation: "linear" },
					{ id: `${prefix}-o1`, time: 0.12, value: 1, interpolation: "linear" },
				],
			},
		},
	};
}

/**
 * Build the caption-specific TextElement fields for a given preset. The caller
 * supplies content/timing/position; this fills in the styling so the renderer's
 * karaoke path animates it. Returns a partial ready to spread into a
 * CreateTextElement.
 */
export function buildCaptionElementStyle({
	preset,
	elementKey,
}: {
	preset: CaptionStylePreset;
	elementKey: string;
}): Partial<CreateTextElement> {
	return {
		fontSize: preset.fontSize,
		fontFamily: preset.fontFamily,
		fontWeight: preset.fontWeight,
		color: preset.color,
		highlightColor: preset.highlightColor,
		wordActiveColor: preset.wordActiveColor,
		wordActiveBackground: preset.wordActiveBackground,
		wordPopScale: preset.wordPopScale,
		strokeColor: preset.strokeColor,
		strokeWidth: preset.strokeWidth,
		textAlign: "center",
		background: preset.background,
		...(preset.animateSegmentIn
			? { animations: buildCaptionEntryAnimation(elementKey) }
			: {}),
	};
}

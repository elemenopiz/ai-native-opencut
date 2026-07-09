import type { EffectDefinition } from "@/types/effects";
import colorAdjustShader from "./color-adjust.frag.glsl";

function getParam(effectParams: Record<string, unknown>, key: string, fallback: number): number {
	const val = effectParams[key];
	return typeof val === "number" ? val : fallback;
}

/** Neutral color-wheel value: mid-gray = zero tint. */
export const NEUTRAL_WHEEL = "#808080";

/** Decode a hex color into a signed per-channel offset in [-1, 1] around neutral gray. */
function hexToWheelOffset(hex: string): [number, number, number] {
	const matched = hex.trim().match(/^#?([0-9a-fA-F]{6})$/);
	if (!matched) return [0, 0, 0];
	const int = parseInt(matched[1], 16);
	const r = ((int >> 16) & 0xff) / 255;
	const g = ((int >> 8) & 0xff) / 255;
	const b = (int & 0xff) / 255;
	return [(r - 0.5) * 2, (g - 0.5) * 2, (b - 0.5) * 2];
}

function getWheelHex(effectParams: Record<string, unknown>, key: string): string {
	const val = effectParams[key];
	return typeof val === "string" ? val : NEUTRAL_WHEEL;
}

export const colorAdjustEffectDefinition: EffectDefinition = {
	type: "color-adjust",
	name: "Color Grade",
	keywords: [
		"color",
		"grade",
		"grading",
		"brightness",
		"contrast",
		"saturation",
		"temperature",
		"tint",
		"exposure",
		"highlights",
		"shadows",
		"lift",
		"gamma",
		"gain",
		"wheels",
		"adjust",
	],
	params: [
		{
			key: "exposure",
			label: "Exposure",
			type: "number",
			default: 0,
			min: -2,
			max: 2,
			step: 0.01,
		},
		{
			key: "brightness",
			label: "Brightness",
			type: "number",
			default: 0,
			min: -0.5,
			max: 0.5,
			step: 0.01,
		},
		{
			key: "contrast",
			label: "Contrast",
			type: "number",
			default: 1,
			min: 0.2,
			max: 3,
			step: 0.01,
		},
		{
			key: "saturation",
			label: "Saturation",
			type: "number",
			default: 1,
			min: 0,
			max: 3,
			step: 0.01,
		},
		{
			key: "temperature",
			label: "Temperature",
			type: "number",
			default: 0,
			min: -1,
			max: 1,
			step: 0.01,
		},
		{
			key: "tint",
			label: "Tint",
			type: "number",
			default: 0,
			min: -1,
			max: 1,
			step: 0.01,
		},
		{
			key: "highlights",
			label: "Highlights",
			type: "number",
			default: 0,
			min: -1,
			max: 1,
			step: 0.01,
		},
		{
			key: "shadows",
			label: "Shadows",
			type: "number",
			default: 0,
			min: -1,
			max: 1,
			step: 0.01,
		},
		{
			key: "whites",
			label: "Whites",
			type: "number",
			default: 0,
			min: -1,
			max: 1,
			step: 0.01,
		},
		{
			key: "blacks",
			label: "Blacks",
			type: "number",
			default: 0,
			min: -1,
			max: 1,
			step: 0.01,
		},
		{
			key: "liftColor",
			label: "Lift (Shadows)",
			type: "wheel",
			default: NEUTRAL_WHEEL,
		},
		{
			key: "liftLuma",
			label: "Lift Luma",
			type: "number",
			default: 0,
			min: -0.5,
			max: 0.5,
			step: 0.01,
		},
		{
			key: "gammaColor",
			label: "Gamma (Midtones)",
			type: "wheel",
			default: NEUTRAL_WHEEL,
		},
		{
			key: "gammaLuma",
			label: "Gamma Luma",
			type: "number",
			default: 0,
			min: -0.5,
			max: 0.5,
			step: 0.01,
		},
		{
			key: "gainColor",
			label: "Gain (Highlights)",
			type: "wheel",
			default: NEUTRAL_WHEEL,
		},
		{
			key: "gainLuma",
			label: "Gain Luma",
			type: "number",
			default: 0,
			min: -0.5,
			max: 0.5,
			step: 0.01,
		},
		{
			key: "vignette",
			label: "Vignette",
			type: "number",
			default: 0,
			min: 0,
			max: 1,
			step: 0.01,
		},
	],
	renderer: {
		type: "webgl",
		passes: [
			{
				fragmentShader: colorAdjustShader,
				uniforms: ({ effectParams }) => {
					const lift = hexToWheelOffset(getWheelHex(effectParams, "liftColor"));
					const gamma = hexToWheelOffset(getWheelHex(effectParams, "gammaColor"));
					const gain = hexToWheelOffset(getWheelHex(effectParams, "gainColor"));
					const liftLuma = getParam(effectParams, "liftLuma", 0);
					const gammaLuma = getParam(effectParams, "gammaLuma", 0);
					const gainLuma = getParam(effectParams, "gainLuma", 0);
					return {
						u_exposure: getParam(effectParams, "exposure", 0),
						u_brightness: getParam(effectParams, "brightness", 0),
						u_contrast: getParam(effectParams, "contrast", 1),
						u_saturation: getParam(effectParams, "saturation", 1),
						u_temperature: getParam(effectParams, "temperature", 0),
						u_tint: getParam(effectParams, "tint", 0),
						u_highlights: getParam(effectParams, "highlights", 0),
						u_shadows: getParam(effectParams, "shadows", 0),
						u_whites: getParam(effectParams, "whites", 0),
						u_blacks: getParam(effectParams, "blacks", 0),
						u_vignette: getParam(effectParams, "vignette", 0),
						// Lift: additive offset, Gain: multiplier around 1, Gamma: exponent basis around 1
						u_lift: [
							lift[0] * 0.2 + liftLuma,
							lift[1] * 0.2 + liftLuma,
							lift[2] * 0.2 + liftLuma,
						],
						u_gain: [
							1 + gain[0] * 0.5 + gainLuma,
							1 + gain[1] * 0.5 + gainLuma,
							1 + gain[2] * 0.5 + gainLuma,
						],
						u_gamma: [
							1 + gamma[0] * 0.5 + gammaLuma,
							1 + gamma[1] * 0.5 + gammaLuma,
							1 + gamma[2] * 0.5 + gammaLuma,
						],
					};
				},
			},
		],
	},
};

/**
 * Filter presets — pre-configured color-adjust parameter sets.
 */
export interface FilterPreset {
	id: string;
	name: string;
	params: Record<string, number>;
}

export const FILTER_PRESETS: FilterPreset[] = [
	{
		id: "grayscale",
		name: "Grayscale",
		params: { brightness: 0, contrast: 1, saturation: 0, temperature: 0, vignette: 0 },
	},
	{
		id: "sepia",
		name: "Sepia",
		params: { brightness: 0.05, contrast: 0.95, saturation: 0.3, temperature: 0.6, vignette: 0.2 },
	},
	{
		id: "vintage",
		name: "Vintage",
		params: { brightness: -0.05, contrast: 1.15, saturation: 0.6, temperature: 0.3, vignette: 0.5 },
	},
	{
		id: "warm",
		name: "Warm",
		params: { brightness: 0.03, contrast: 1.05, saturation: 1.1, temperature: 0.5, vignette: 0 },
	},
	{
		id: "cool",
		name: "Cool",
		params: { brightness: 0, contrast: 1.05, saturation: 0.9, temperature: -0.5, vignette: 0 },
	},
	{
		id: "vivid",
		name: "Vivid",
		params: { brightness: 0.02, contrast: 1.3, saturation: 1.8, temperature: 0, vignette: 0 },
	},
	{
		id: "muted",
		name: "Muted",
		params: { brightness: 0.05, contrast: 0.85, saturation: 0.5, temperature: 0, vignette: 0 },
	},
	{
		id: "dramatic",
		name: "Dramatic",
		params: { brightness: -0.08, contrast: 1.5, saturation: 0.7, temperature: -0.2, vignette: 0.6 },
	},
	{
		id: "high-key",
		name: "High Key",
		params: { brightness: 0.2, contrast: 0.8, saturation: 0.8, temperature: 0.1, vignette: 0 },
	},
	{
		id: "low-key",
		name: "Low Key",
		params: { brightness: -0.15, contrast: 1.4, saturation: 0.6, temperature: -0.1, vignette: 0.4 },
	},
	{
		id: "noir",
		name: "Noir",
		params: { brightness: -0.1, contrast: 1.6, saturation: 0, temperature: 0, vignette: 0.7 },
	},
	{
		id: "golden",
		name: "Golden Hour",
		params: { brightness: 0.05, contrast: 1.1, saturation: 1.2, temperature: 0.7, vignette: 0.3 },
	},
	{
		id: "sunset-glow",
		name: "Sunset Glow",
		params: { brightness: 0.08, contrast: 1.15, saturation: 1.3, temperature: 0.8, vignette: 0.25 },
	},
	{
		id: "moonlight",
		name: "Moonlight",
		params: { brightness: -0.1, contrast: 1.2, saturation: 0.3, temperature: -0.7, vignette: 0.5 },
	},
	{
		id: "cyberpunk",
		name: "Cyberpunk",
		params: { brightness: -0.05, contrast: 1.6, saturation: 1.5, temperature: -0.6, vignette: 0.4 },
	},
	{
		id: "film-noir-bw",
		name: "Film Noir B&W",
		params: { brightness: -0.15, contrast: 1.8, saturation: 0, temperature: 0, vignette: 0.8 },
	},
	{
		id: "dreamy",
		name: "Dreamy",
		params: { brightness: 0.15, contrast: 0.75, saturation: 0.7, temperature: 0.2, vignette: 0.15 },
	},
	{
		id: "retro-vhs",
		name: "Retro VHS",
		params: { brightness: 0.05, contrast: 1.3, saturation: 1.4, temperature: 0.4, vignette: 0.1 },
	},
	{
		id: "cinematic-teal-orange",
		name: "Teal & Orange",
		params: { brightness: -0.03, contrast: 1.25, saturation: 1.1, temperature: 0.35, vignette: 0.3 },
	},
	{
		id: "bleach-bypass",
		name: "Bleach Bypass",
		params: { brightness: -0.05, contrast: 1.7, saturation: 0.35, temperature: 0.1, vignette: 0.35 },
	},
	{
		id: "cross-process",
		name: "Cross Process",
		params: { brightness: 0.1, contrast: 1.2, saturation: 1.6, temperature: -0.3, vignette: 0.2 },
	},
	{
		id: "faded-film",
		name: "Faded Film",
		params: { brightness: 0.12, contrast: 0.9, saturation: 0.55, temperature: 0.15, vignette: 0.3 },
	},
];

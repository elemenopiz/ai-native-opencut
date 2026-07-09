/**
 * Auto color-correction profiles.
 *
 * `adjustments` are expressed in the *native* param scale of the `color-adjust`
 * effect (see lib/effects/definitions/color-adjust.ts), so they can be spread
 * directly onto an effect's params:
 *   exposure     stops, -2..2       (0 = neutral)
 *   brightness   -0.5..0.5          (0 = neutral)
 *   contrast     0.2..3             (1 = neutral)
 *   saturation   0..3               (1 = neutral)
 *   temperature  -1 cool .. 1 warm  (0 = neutral)
 *   tint         -1 green .. 1 magenta (0 = neutral)
 *   highlights   -1..1              (0 = neutral)
 *   shadows      -1..1              (0 = neutral)
 */
export interface ColorCorrectionProfile {
	name: string;
	description: string;
	adjustments: {
		exposure: number;
		brightness: number;
		contrast: number;
		saturation: number;
		temperature: number;
		tint: number;
		highlights: number;
		shadows: number;
	};
}

export const AUTO_CORRECT_PROFILES: ColorCorrectionProfile[] = [
	{
		name: "Auto Balance",
		description: "Neutral white balance and exposure",
		adjustments: {
			exposure: 0,
			brightness: 0,
			contrast: 1,
			saturation: 1,
			temperature: 0,
			tint: 0,
			highlights: 0,
			shadows: 0,
		},
	},
	{
		name: "Vibrant Pop",
		description: "Boosted saturation and contrast",
		adjustments: {
			exposure: 0.15,
			brightness: 0.05,
			contrast: 1.15,
			saturation: 1.25,
			temperature: 0.05,
			tint: 0,
			highlights: -0.1,
			shadows: 0.1,
		},
	},
	{
		name: "Film Look",
		description: "Cinematic color grading",
		adjustments: {
			exposure: -0.1,
			brightness: -0.05,
			contrast: 1.1,
			saturation: 0.85,
			temperature: -0.1,
			tint: 0.05,
			highlights: -0.2,
			shadows: 0.15,
		},
	},
	{
		name: "Warm Sunset",
		description: "Warm, golden tones",
		adjustments: {
			exposure: 0.15,
			brightness: 0.05,
			contrast: 1.05,
			saturation: 1.1,
			temperature: 0.35,
			tint: 0.05,
			highlights: 0.05,
			shadows: 0.1,
		},
	},
	{
		name: "Cool Blue",
		description: "Cool, blue tones",
		adjustments: {
			exposure: 0,
			brightness: 0,
			contrast: 1.1,
			saturation: 0.9,
			temperature: -0.3,
			tint: -0.05,
			highlights: 0.05,
			shadows: -0.05,
		},
	},
	{
		name: "High Contrast B&W",
		description: "Dramatic black and white",
		adjustments: {
			exposure: 0.1,
			brightness: 0.05,
			contrast: 1.4,
			saturation: 0,
			temperature: 0,
			tint: 0,
			highlights: 0.1,
			shadows: -0.2,
		},
	},
	{
		name: "Soft Portrait",
		description: "Soft, flattering skin tones",
		adjustments: {
			exposure: 0.15,
			brightness: 0.08,
			contrast: 0.95,
			saturation: 1.05,
			temperature: 0.12,
			tint: 0.05,
			highlights: -0.1,
			shadows: 0.15,
		},
	},
	{
		name: "Night Vision",
		description: "Enhanced low-light footage",
		adjustments: {
			exposure: 0.6,
			brightness: 0.15,
			contrast: 1.15,
			saturation: 0.8,
			temperature: -0.15,
			tint: 0.1,
			highlights: -0.3,
			shadows: 0.4,
		},
	},
];

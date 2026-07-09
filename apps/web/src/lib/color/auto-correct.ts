/**
 * Real auto color-correction: turn measured frame statistics (from the scopes
 * engine) into `color-adjust` effect params.
 *
 * Every output key/range matches `lib/effects/definitions/color-adjust.ts` and
 * the shader in `color-adjust.frag.glsl`, so the result can be spread straight
 * onto an effect's `params`. All math is derived from the pixels we sampled —
 * nothing here is hardcoded — with a single global `strength` knob to avoid
 * over-correction, and every value clamped into the effect's legal range.
 */

import type { ScopeSummary } from "@/lib/color/scopes";
import type { ColorCorrectionProfile } from "@/lib/color/auto-color-profiles";

/** The subset of `color-adjust` params auto-correction writes. */
export interface AutoCorrectAdjustments {
	exposure: number;
	brightness: number;
	contrast: number;
	saturation: number;
	temperature: number;
	tint: number;
	highlights: number;
	shadows: number;
	whites: number;
	blacks: number;
}

/** Native `color-adjust` param ranges (kept in sync with the effect definition). */
const RANGE = {
	exposure: [-2, 2],
	brightness: [-0.5, 0.5],
	contrast: [0.2, 3],
	saturation: [0, 3],
	temperature: [-1, 1],
	tint: [-1, 1],
	highlights: [-1, 1],
	shadows: [-1, 1],
	whites: [-1, 1],
	blacks: [-1, 1],
} as const;

function clamp(value: number, [min, max]: readonly [number, number]): number {
	return value < min ? min : value > max ? max : value;
}

function round(value: number): number {
	return Math.round(value * 1000) / 1000;
}

/** Mid-gray target the auto-exposure aims the mean luma toward. */
const TARGET_MEAN_LUMA = 0.46;
/** Target luma spread (whitePoint - blackPoint) the auto-contrast opens up to. */
const TARGET_SPREAD = 0.92;

export interface ComputeAutoCorrectionOptions {
	summary: ScopeSummary;
	/**
	 * Global correction strength, 0 (no correction) .. 1 (full). Values below 1
	 * apply a gentler grade. Defaults to 0.75.
	 */
	strength?: number;
}

/**
 * Derive base auto-correction adjustments purely from measured statistics.
 *
 * Statistic → param mapping:
 *  - mean luma ......... exposure (stops = log2(target/mean))
 *  - black/white spread  contrast (open up compressed dynamic range)
 *  - blue−red mean ..... temperature (auto white balance; shader shifts R/B by ±0.1)
 *  - green excess ...... tint (neutralize green/magenta cast; shader shifts G by 0.1)
 *  - elevated blackPt .. blacks (deepen washed-out shadows)
 *  - dull whitePt ...... whites (recover flat highlights)
 *  - highlight clipping  highlights (pull down blown highlights)
 *  - shadow clipping ... shadows (lift crushed shadows)
 */
export function computeAutoCorrection({
	summary,
	strength = 0.75,
}: ComputeAutoCorrectionOptions): AutoCorrectAdjustments {
	const s = clamp(strength, [0, 1]);
	const { luma, temperatureEstimate, tintEstimate } = summary;

	// --- Exposure: match mean luma to the target (multiplicative, in stops). ---
	const meanLuma = Math.max(luma.mean, 0.02);
	const exposure = clamp(
		Math.log2(TARGET_MEAN_LUMA / meanLuma) * s,
		[-1.5, 1.5],
	);

	// --- Contrast: stretch a compressed tonal range toward the target spread. ---
	const spread = Math.max(luma.whitePoint - luma.blackPoint, 0.05);
	const contrast = clamp(1 + (TARGET_SPREAD / spread - 1) * s, [0.8, 1.8]);

	// --- White balance: shader shifts R by +0.1·temp and B by -0.1·temp, so the
	//     R/B differential moves by 0.2·temp. To close a (blue−red) gap `d` we
	//     need temp ≈ d / 0.2 = 5d; apply at strength. Positive temp = warmer. ---
	const temperature = clamp(temperatureEstimate * 5 * s, RANGE.temperature);

	// --- Tint: shader shifts G by +0.1·tint, so neutralizing a green excess `e`
	//     needs tint ≈ -e / 0.1 = -10e; damp it (green casts read stronger). ---
	const tint = clamp(-tintEstimate * 6 * s, RANGE.tint);

	// --- Black point: pull elevated blacks down (only if noticeably washed). ---
	const blacks = clamp(
		-Math.max(luma.blackPoint - 0.03, 0) * 2.5 * s,
		[-0.6, 0],
	);

	// --- White point: raise dull highlights toward clipping. ---
	const whites = clamp(Math.max(0.97 - luma.whitePoint, 0) * 2 * s, [0, 0.6]);

	// --- Clipping recovery from luma extremes. ---
	const highlights = clamp(-luma.clipHigh * 4 * s, [-0.5, 0]);
	const shadows = clamp(luma.clipLow * 4 * s, [0, 0.5]);

	return {
		exposure: round(exposure),
		brightness: 0,
		contrast: round(contrast),
		saturation: 1,
		temperature: round(temperature),
		tint: round(tint),
		highlights: round(highlights),
		shadows: round(shadows),
		whites: round(whites),
		blacks: round(blacks),
	};
}

/**
 * Layer an optional "look" profile on top of the measured base correction.
 * Profiles are absolute values relative to a fully-neutral grade, so additive
 * params (exposure/brightness/temperature/tint/highlights/shadows) add and
 * multiplicative-neutral params (contrast/saturation) multiply. Everything is
 * re-clamped to the effect's legal range.
 */
export function layerLookProfile({
	base,
	profile,
}: {
	base: AutoCorrectAdjustments;
	profile: ColorCorrectionProfile;
}): AutoCorrectAdjustments {
	const a = profile.adjustments;
	return {
		exposure: round(clamp(base.exposure + a.exposure, RANGE.exposure)),
		brightness: round(clamp(base.brightness + a.brightness, RANGE.brightness)),
		contrast: round(clamp(base.contrast * a.contrast, RANGE.contrast)),
		saturation: round(clamp(base.saturation * a.saturation, RANGE.saturation)),
		temperature: round(
			clamp(base.temperature + a.temperature, RANGE.temperature),
		),
		tint: round(clamp(base.tint + a.tint, RANGE.tint)),
		highlights: round(clamp(base.highlights + a.highlights, RANGE.highlights)),
		shadows: round(clamp(base.shadows + a.shadows, RANGE.shadows)),
		whites: base.whites,
		blacks: base.blacks,
	};
}

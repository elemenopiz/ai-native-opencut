import type {
	CubicBezierControlPoints,
	EasingPresetId,
	KeyframeEasing,
} from "@/types/animation";

/**
 * Cubic-bezier easing math and presets.
 *
 * The bezier evaluator is adapted from the pure-TypeScript animation math in
 * OpenCut-app/opencut-classic (MIT). We use the CSS timing-function model
 * (control points `[x1, y1, x2, y2]` between an implicit `(0, 0)` and `(1, 1)`)
 * rather than classic's per-keyframe drag handles, because it maps directly onto
 * our normalized-progress interpolation and onto standard editor presets. See
 * THIRD_PARTY_NOTICES.md for attribution.
 */

const NEWTON_ITERATIONS = 8;
const NEWTON_MIN_SLOPE = 0.001;
const SUBDIVISION_PRECISION = 0.0000001;
const SUBDIVISION_MAX_ITERATIONS = 12;

/**
 * Standard CSS easing presets, expressed as cubic-bezier control points. These
 * match the keywords exposed by browsers so authored curves look familiar.
 */
export const EASING_PRESETS: Record<EasingPresetId, CubicBezierControlPoints> = {
	linear: [0, 0, 1, 1],
	ease: [0.25, 0.1, 0.25, 1],
	"ease-in": [0.42, 0, 1, 1],
	"ease-out": [0, 0, 0.58, 1],
	"ease-in-out": [0.42, 0, 0.58, 1],
};

export interface EasingPresetOption {
	id: EasingPresetId;
	label: string;
}

/** Ordered preset list for pickers (linear first for the "no easing" default). */
export const EASING_PRESET_OPTIONS: EasingPresetOption[] = [
	{ id: "linear", label: "Linear" },
	{ id: "ease", label: "Ease" },
	{ id: "ease-in", label: "Ease In" },
	{ id: "ease-out", label: "Ease Out" },
	{ id: "ease-in-out", label: "Ease In Out" },
];

/** Build a {@link KeyframeEasing} from a named preset (Director-friendly). */
export function easingFromPreset({
	preset,
}: {
	preset: EasingPresetId;
}): KeyframeEasing {
	return { preset, bezier: EASING_PRESETS[preset] };
}

/** Build a {@link KeyframeEasing} from raw control points (Director-friendly). */
export function easingFromBezier({
	bezier,
}: {
	bezier: CubicBezierControlPoints;
}): KeyframeEasing {
	const matchedPreset = matchEasingPreset({ bezier });
	return matchedPreset ? { preset: matchedPreset, bezier } : { bezier };
}

const PRESET_MATCH_TOLERANCE = 0.0001;

/** Return the preset id whose control points equal `bezier`, if any. */
export function matchEasingPreset({
	bezier,
}: {
	bezier: CubicBezierControlPoints;
}): EasingPresetId | null {
	for (const [presetId, presetBezier] of Object.entries(EASING_PRESETS)) {
		const isMatch = presetBezier.every(
			(component, index) =>
				Math.abs(component - bezier[index]) <= PRESET_MATCH_TOLERANCE,
		);
		if (isMatch) {
			return presetId as EasingPresetId;
		}
	}
	return null;
}

function bezierComponent({
	aComponent,
	bComponent,
	cComponent,
	progress,
}: {
	aComponent: number;
	bComponent: number;
	cComponent: number;
	progress: number;
}): number {
	// Horner form of ((a*t + b)*t + c)*t for the 1D cubic bezier with the first
	// and last control points fixed at 0 and 1.
	return ((aComponent * progress + bComponent) * progress + cComponent) *
		progress;
}

function bezierSlope({
	aComponent,
	bComponent,
	cComponent,
	progress,
}: {
	aComponent: number;
	bComponent: number;
	cComponent: number;
	progress: number;
}): number {
	return (
		3 * aComponent * progress * progress + 2 * bComponent * progress + cComponent
	);
}

function solveParametricForX({
	targetX,
	firstControl,
	secondControl,
}: {
	targetX: number;
	firstControl: number;
	secondControl: number;
}): number {
	const cComponent = 3 * firstControl;
	const bComponent = 3 * (secondControl - firstControl) - cComponent;
	const aComponent = 1 - cComponent - bComponent;

	// Newton-Raphson refinement first — fast when the curve is well-behaved.
	let guess = targetX;
	for (let iteration = 0; iteration < NEWTON_ITERATIONS; iteration++) {
		const currentX =
			bezierComponent({ aComponent, bComponent, cComponent, progress: guess }) -
			targetX;
		const currentSlope = bezierSlope({
			aComponent,
			bComponent,
			cComponent,
			progress: guess,
		});
		if (Math.abs(currentSlope) < NEWTON_MIN_SLOPE) {
			break;
		}
		guess -= currentX / currentSlope;
	}

	if (
		Math.abs(
			bezierComponent({ aComponent, bComponent, cComponent, progress: guess }) -
				targetX,
		) <= SUBDIVISION_PRECISION
	) {
		return guess;
	}

	// Fall back to bisection for the ill-conditioned (near-flat) regions.
	let lower = 0;
	let upper = 1;
	let current = targetX;
	for (
		let iteration = 0;
		iteration < SUBDIVISION_MAX_ITERATIONS;
		iteration++
	) {
		const estimate = bezierComponent({
			aComponent,
			bComponent,
			cComponent,
			progress: current,
		});
		if (Math.abs(estimate - targetX) <= SUBDIVISION_PRECISION) {
			return current;
		}
		if (estimate < targetX) {
			lower = current;
		} else {
			upper = current;
		}
		current = (lower + upper) / 2;
	}
	return current;
}

/**
 * Evaluate a CSS-style cubic-bezier timing function.
 *
 * Given normalized segment time `progress` in `[0, 1]` (the x axis), returns the
 * eased progress on the y axis. Output may fall outside `[0, 1]` for overshoot
 * curves, which is intentional so effects like anticipation/overshoot work.
 */
export function evaluateCubicBezier({
	bezier,
	progress,
}: {
	bezier: CubicBezierControlPoints;
	progress: number;
}): number {
	const [x1, y1, x2, y2] = bezier;

	// Linear identity curve — skip the solver entirely.
	if (x1 === y1 && x2 === y2) {
		return progress;
	}

	const clampedProgress = Math.max(0, Math.min(1, progress));
	if (clampedProgress <= 0) {
		return 0;
	}
	if (clampedProgress >= 1) {
		return 1;
	}

	const parametricT = solveParametricForX({
		targetX: clampedProgress,
		firstControl: x1,
		secondControl: x2,
	});

	const cComponent = 3 * y1;
	const bComponent = 3 * (y2 - y1) - cComponent;
	const aComponent = 1 - cComponent - bComponent;
	return bezierComponent({
		aComponent,
		bComponent,
		cComponent,
		progress: parametricT,
	});
}

/** Resolve the control points an easing evaluates to (defaults to linear). */
export function resolveEasingControlPoints({
	easing,
}: {
	easing: KeyframeEasing | undefined;
}): CubicBezierControlPoints {
	if (easing?.bezier) {
		return easing.bezier;
	}
	if (easing?.preset) {
		return EASING_PRESETS[easing.preset];
	}
	return EASING_PRESETS.linear;
}

/**
 * Transform linear segment progress into eased progress. This is the single
 * entry point used by the interpolators: when `easing` is undefined or linear it
 * returns `progress` unchanged, guaranteeing byte-for-byte backward compatibility
 * with pre-easing keyframes.
 */
export function applyEasing({
	easing,
	progress,
}: {
	easing: KeyframeEasing | undefined;
	progress: number;
}): number {
	if (!easing) {
		return progress;
	}
	return evaluateCubicBezier({
		bezier: resolveEasingControlPoints({ easing }),
		progress,
	});
}

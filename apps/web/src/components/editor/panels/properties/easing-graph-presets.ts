import { EASING_PRESETS, EASING_PRESET_OPTIONS } from "@/lib/animation";
import type {
	CubicBezierControlPoints,
	EasingPresetId,
} from "@/types/animation";

/**
 * Builtin curve presets shown in the bezier graph editor's preset grid.
 * Reuses our named `EasingPresetId` presets (so picking one round-trips
 * through `easingFromPreset`/`matchEasingPreset` cleanly) plus one
 * overshoot curve ("Pop") that isn't a named preset — selecting it stores a
 * plain bezier via `easingFromBezier` with no `preset` id, same as any other
 * custom curve.
 */
export interface EasingGraphPreset {
	id: string;
	label: string;
	value: CubicBezierControlPoints;
	presetId?: EasingPresetId;
}

/** Overshoot easing, ported from the pre-rewrite graph editor's preset list. */
const POP_BEZIER: CubicBezierControlPoints = [0.175, 0.885, 0.32, 1.275];

export const EASING_GRAPH_PRESETS: EasingGraphPreset[] = [
	...EASING_PRESET_OPTIONS.map((option) => ({
		id: option.id,
		label: option.label,
		value: EASING_PRESETS[option.id],
		presetId: option.id,
	})),
	{ id: "pop", label: "Pop", value: POP_BEZIER },
];

/** Tolerance for matching a bezier value to a preset when highlighting the
 * active preset in the grid. */
export const EASING_GRAPH_PRESET_MATCH_TOLERANCE = 0.02;

export function findMatchingGraphPreset({
	bezier,
	presets,
}: {
	bezier: CubicBezierControlPoints;
	presets: EasingGraphPreset[];
}): EasingGraphPreset | null {
	return (
		presets.find((preset) =>
			preset.value.every(
				(component, index) =>
					Math.abs(component - bezier[index]) <=
					EASING_GRAPH_PRESET_MATCH_TOLERANCE,
			),
		) ?? null
	);
}

import type { CubicBezierControlPoints } from "@/types/animation";

/**
 * Pure geometry helpers for the draggable bezier value-graph editor (the SVG
 * control-point handles in the properties-panel easing picker). Kept free of
 * SVG/DOM coordinates and React so the handle-drag math is unit-testable in
 * isolation from pointer-event plumbing.
 *
 * Adapted from the pre-rewrite `BezierGraph` component's inline helpers
 * (OpenCut-app/OpenCut, MIT — see THIRD_PARTY_NOTICES.md), factored out into a
 * standalone pure module.
 */

/** A control-point handle's x always spans the segment's normalized time. */
export const BEZIER_HANDLE_X_MIN = 0;
export const BEZIER_HANDLE_X_MAX = 1;

/**
 * A control-point handle's y range is wider than [0, 1]: curves may overshoot
 * past the endpoints (anticipation/overshoot easing like "Pop"), so the handle
 * itself needs room to be dragged there.
 */
export const BEZIER_HANDLE_Y_MIN = -0.5;
export const BEZIER_HANDLE_Y_MAX = 1.5;

export const BEZIER_SNAP_TARGETS: readonly number[] = [0, 1];
export const BEZIER_SNAP_THRESHOLD = 0.06;

export type BezierHandleId = "c1" | "c2";

/**
 * Evaluate one axis of a cubic bezier at parametric progress `t` using the
 * expanded Bernstein-basis form. Unlike {@link evaluateCubicBezier} in
 * `easing.ts` (which *solves* for `t` given a target x, CSS-timing-function
 * style), this directly samples a point on the curve for a given `t` — what
 * the graph needs to draw the curve itself and to place the two control-point
 * handles.
 */
export function getCubicBezierPoint({
	progress,
	p0,
	p1,
	p2,
	p3,
}: {
	progress: number;
	p0: number;
	p1: number;
	p2: number;
	p3: number;
}): number {
	const inverseProgress = 1 - progress;
	return (
		inverseProgress * inverseProgress * inverseProgress * p0 +
		3 * inverseProgress * inverseProgress * progress * p1 +
		3 * inverseProgress * progress * progress * p2 +
		progress * progress * progress * p3
	);
}

/** Clamp a handle's x to the normalized-time domain [0, 1]. */
export function clampBezierHandleX({ value }: { value: number }): number {
	return Math.max(BEZIER_HANDLE_X_MIN, Math.min(BEZIER_HANDLE_X_MAX, value));
}

/** Clamp a handle's y to the allowed overshoot range. */
export function clampBezierHandleY({ value }: { value: number }): number {
	return Math.max(BEZIER_HANDLE_Y_MIN, Math.min(BEZIER_HANDLE_Y_MAX, value));
}

/** Snap a value to the nearest target (0 or 1) when it's within threshold. */
export function snapBezierHandleValue({
	value,
	isSnapEnabled,
	targets = BEZIER_SNAP_TARGETS,
	threshold = BEZIER_SNAP_THRESHOLD,
}: {
	value: number;
	isSnapEnabled: boolean;
	targets?: readonly number[];
	threshold?: number;
}): number {
	if (!isSnapEnabled) {
		return value;
	}
	for (const target of targets) {
		if (Math.abs(value - target) < threshold) {
			return target;
		}
	}
	return value;
}

/**
 * Apply a dragged handle's raw pointer-derived (x, y) to a bezier tuple,
 * clamping x to [0, 1] and clamping+snapping y. Pure and immutable — returns a
 * new tuple, leaving `bezier` untouched.
 */
export function updateBezierHandle({
	bezier,
	handle,
	x,
	y,
	isSnapEnabled,
}: {
	bezier: CubicBezierControlPoints;
	handle: BezierHandleId;
	x: number;
	y: number;
	isSnapEnabled: boolean;
}): CubicBezierControlPoints {
	const clampedX = clampBezierHandleX({ value: x });
	const clampedY = clampBezierHandleY({ value: y });
	const snappedY = snapBezierHandleValue({ value: clampedY, isSnapEnabled });

	return handle === "c1"
		? [clampedX, snappedY, bezier[2], bezier[3]]
		: [bezier[0], bezier[1], clampedX, snappedY];
}

/** Sample `segments + 1` normalized (0..1 domain) points along the curve. */
export function sampleBezierCurvePoints({
	bezier,
	segments,
}: {
	bezier: CubicBezierControlPoints;
	segments: number;
}): Array<{ x: number; y: number }> {
	const points: Array<{ x: number; y: number }> = [];
	for (let i = 0; i <= segments; i++) {
		const progress = i / segments;
		points.push({
			x: getCubicBezierPoint({
				progress,
				p0: 0,
				p1: bezier[0],
				p2: bezier[2],
				p3: 1,
			}),
			y: getCubicBezierPoint({
				progress,
				p0: 0,
				p1: bezier[1],
				p2: bezier[3],
				p3: 1,
			}),
		});
	}
	return points;
}

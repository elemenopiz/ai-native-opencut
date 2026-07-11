import { describe, expect, test } from "bun:test";
import {
	clampBezierHandleX,
	clampBezierHandleY,
	getCubicBezierPoint,
	sampleBezierCurvePoints,
	snapBezierHandleValue,
	updateBezierHandle,
} from "@/lib/animation/bezier-graph-math";

describe("getCubicBezierPoint", () => {
	test("returns p0 and p3 at the endpoints", () => {
		expect(
			getCubicBezierPoint({ progress: 0, p0: 0, p1: 0.2, p2: 0.8, p3: 1 }),
		).toBeCloseTo(0, 6);
		expect(
			getCubicBezierPoint({ progress: 1, p0: 0, p1: 0.2, p2: 0.8, p3: 1 }),
		).toBeCloseTo(1, 6);
	});

	test("midpoint of a linear (identity-slope) curve is 0.5", () => {
		// p1 == p2 == 0.5 with p0=0/p3=1 degenerates to the straight line y = t.
		expect(
			getCubicBezierPoint({ progress: 0.5, p0: 0, p1: 0.5, p2: 0.5, p3: 1 }),
		).toBeCloseTo(0.5, 6);
	});
});

describe("clampBezierHandleX / clampBezierHandleY", () => {
	test("clamps x to [0, 1]", () => {
		expect(clampBezierHandleX({ value: -0.5 })).toBe(0);
		expect(clampBezierHandleX({ value: 1.5 })).toBe(1);
		expect(clampBezierHandleX({ value: 0.42 })).toBe(0.42);
	});

	test("clamps y to the overshoot range [-0.5, 1.5]", () => {
		expect(clampBezierHandleY({ value: -1 })).toBe(-0.5);
		expect(clampBezierHandleY({ value: 2 })).toBe(1.5);
		expect(clampBezierHandleY({ value: 1.275 })).toBe(1.275);
	});
});

describe("snapBezierHandleValue", () => {
	test("snaps values within threshold of a target", () => {
		expect(snapBezierHandleValue({ value: 0.02, isSnapEnabled: true })).toBe(0);
		expect(snapBezierHandleValue({ value: 0.97, isSnapEnabled: true })).toBe(1);
	});

	test("leaves values outside threshold untouched", () => {
		expect(snapBezierHandleValue({ value: 0.5, isSnapEnabled: true })).toBe(
			0.5,
		);
	});

	test("does nothing when snapping is disabled (shift-drag)", () => {
		expect(snapBezierHandleValue({ value: 0.02, isSnapEnabled: false })).toBe(
			0.02,
		);
	});
});

describe("updateBezierHandle", () => {
	const base = [0.25, 0.1, 0.25, 1] as const;

	test("dragging c1 only updates the first control point", () => {
		const next = updateBezierHandle({
			bezier: base,
			handle: "c1",
			x: 0.4,
			y: 0.3,
			isSnapEnabled: false,
		});
		expect(next).toEqual([0.4, 0.3, 0.25, 1]);
	});

	test("dragging c2 only updates the second control point", () => {
		const next = updateBezierHandle({
			bezier: base,
			handle: "c2",
			x: 0.6,
			y: 0.9,
			isSnapEnabled: false,
		});
		expect(next).toEqual([0.25, 0.1, 0.6, 0.9]);
	});

	test("clamps x into [0, 1] regardless of snap", () => {
		const next = updateBezierHandle({
			bezier: base,
			handle: "c1",
			x: -0.3,
			y: 0.1,
			isSnapEnabled: false,
		});
		expect(next[0]).toBe(0);
	});

	test("snaps y near 0/1 when enabled, overshoot still clamps to range", () => {
		const snapped = updateBezierHandle({
			bezier: base,
			handle: "c2",
			x: 0.8,
			y: 1.03,
			isSnapEnabled: true,
		});
		expect(snapped[3]).toBe(1);

		const overshoot = updateBezierHandle({
			bezier: base,
			handle: "c2",
			x: 0.8,
			y: 1.9,
			isSnapEnabled: true,
		});
		expect(overshoot[3]).toBe(1.5);
	});

	test("does not mutate the input tuple", () => {
		const input: readonly [number, number, number, number] = [0, 0, 1, 1];
		const next = updateBezierHandle({
			bezier: input,
			handle: "c1",
			x: 0.5,
			y: 0.5,
			isSnapEnabled: false,
		});
		expect(input).toEqual([0, 0, 1, 1]);
		expect(next).not.toBe(input);
	});
});

describe("sampleBezierCurvePoints", () => {
	test("identity bezier [0,0,1,1] samples the y === x diagonal", () => {
		// The two axes share identical control points (p1=p0, p2=p3), so every
		// parametrically-sampled point falls exactly on the diagonal — even
		// though x(t) itself isn't a linear function of the sample index t
		// (that reparametrization is what `evaluateCubicBezier`'s solve-for-x
		// step in easing.ts is for; this module just samples points on the
		// curve for drawing, by parametric t, not by x).
		const points = sampleBezierCurvePoints({
			bezier: [0, 0, 1, 1],
			segments: 8,
		});
		expect(points).toHaveLength(9);
		for (const point of points) {
			expect(point.x).toBeCloseTo(point.y, 6);
		}
		// Monotonically increasing from (0,0) to (1,1).
		for (let i = 1; i < points.length; i++) {
			expect(points[i].x).toBeGreaterThanOrEqual(points[i - 1].x);
		}
	});

	test("first and last samples are pinned to (0,0) and (1,1) for any curve", () => {
		const points = sampleBezierCurvePoints({
			bezier: [0.175, 0.885, 0.32, 1.275],
			segments: 16,
		});
		expect(points[0].x).toBeCloseTo(0, 6);
		expect(points[0].y).toBeCloseTo(0, 6);
		expect(points.at(-1)?.x).toBeCloseTo(1, 6);
		expect(points.at(-1)?.y).toBeCloseTo(1, 6);
	});
});

import { describe, expect, test } from "bun:test";
import type { MaskPathPoint } from "@/types/rendering";
import {
	buildFreeformSvgPath,
	canvasPointToLocal,
	evaluateCubicBezier,
	flattenFreeformPath,
	getClosedStateAfterPointRemoval,
	getFreeformSegmentCount,
	getRasterTransform,
	insertPointIntoFreeformSegment,
	isPointInPolygon,
	localPointToCanvas,
	removeFreeformPathPoints,
	type FreeformTransform,
} from "../freeform-path";

function corner({
	id,
	x,
	y,
}: {
	id: string;
	x: number;
	y: number;
}): MaskPathPoint {
	return { id, x, y, inX: 0, inY: 0, outX: 0, outY: 0 };
}

/** A 0.5x0.5 (element-fraction) square centered on the element, tangents zero. */
const SQUARE: MaskPathPoint[] = [
	corner({ id: "a", x: -0.25, y: -0.25 }),
	corner({ id: "b", x: 0.25, y: -0.25 }),
	corner({ id: "c", x: 0.25, y: 0.25 }),
	corner({ id: "d", x: -0.25, y: 0.25 }),
];

/** Element-pixel raster transform for a 100x100 element, no offset/rotation. */
const TRANSFORM: FreeformTransform = getRasterTransform({
	centerX: 0,
	centerY: 0,
	rotationDeg: 0,
	scale: 1,
	width: 100,
	height: 100,
});

describe("evaluateCubicBezier", () => {
	const p0 = { x: 0, y: 0 };
	const p1 = { x: 0, y: 0 };
	const p2 = { x: 10, y: 0 };
	const p3 = { x: 10, y: 0 };

	test("hits the endpoints at t=0 and t=1", () => {
		expect(evaluateCubicBezier({ p0, p1, p2, p3, t: 0 })).toEqual({
			x: 0,
			y: 0,
		});
		expect(evaluateCubicBezier({ p0, p1, p2, p3, t: 1 })).toEqual({
			x: 10,
			y: 0,
		});
	});

	test("a zero-tangent segment is geometrically straight (midpoint at t=0.5)", () => {
		const mid = evaluateCubicBezier({ p0, p1, p2, p3, t: 0.5 });
		expect(mid.x).toBeCloseTo(5, 6);
		expect(mid.y).toBeCloseTo(0, 6);
	});
});

describe("localPointToCanvas / canvasPointToLocal", () => {
	test("center maps to the element pixel center", () => {
		const c = localPointToCanvas({
			point: { x: 0, y: 0 },
			transform: TRANSFORM,
		});
		expect(c).toEqual({ x: 50, y: 50 });
	});

	test("a corner maps to the expected element pixel", () => {
		const c = localPointToCanvas({
			point: { x: -0.25, y: -0.25 },
			transform: TRANSFORM,
		});
		expect(c.x).toBeCloseTo(25, 6);
		expect(c.y).toBeCloseTo(25, 6);
	});

	test("round-trips through the inverse, including rotation + scale", () => {
		const transform = getRasterTransform({
			centerX: 0.1,
			centerY: -0.2,
			rotationDeg: 37,
			scale: 1.5,
			width: 200,
			height: 120,
		});
		const original = { x: 0.13, y: -0.08 };
		const canvas = localPointToCanvas({ point: original, transform });
		const back = canvasPointToLocal({ point: canvas, transform });
		expect(back.x).toBeCloseTo(original.x, 6);
		expect(back.y).toBeCloseTo(original.y, 6);
	});
});

describe("flattenFreeformPath + isPointInPolygon (rasterization coverage)", () => {
	const polygon = flattenFreeformPath({ points: SQUARE, transform: TRANSFORM });

	test("the flattened square spans the expected pixel bounds", () => {
		const xs = polygon.map((p) => p.x);
		const ys = polygon.map((p) => p.y);
		expect(Math.min(...xs)).toBeCloseTo(25, 4);
		expect(Math.max(...xs)).toBeCloseTo(75, 4);
		expect(Math.min(...ys)).toBeCloseTo(25, 4);
		expect(Math.max(...ys)).toBeCloseTo(75, 4);
	});

	test("classifies inside / outside / near-edge points", () => {
		expect(isPointInPolygon({ polygon, x: 50, y: 50 })).toBe(true); // center
		expect(isPointInPolygon({ polygon, x: 10, y: 10 })).toBe(false); // far out
		expect(isPointInPolygon({ polygon, x: 74, y: 50 })).toBe(true); // just inside right edge
		expect(isPointInPolygon({ polygon, x: 76, y: 50 })).toBe(false); // just outside right edge
		expect(isPointInPolygon({ polygon, x: 50, y: 26 })).toBe(true); // just inside top edge
		expect(isPointInPolygon({ polygon, x: 50, y: 24 })).toBe(false); // just outside top edge
	});
});

describe("getFreeformSegmentCount", () => {
	test("open paths have one fewer segment than points", () => {
		expect(getFreeformSegmentCount({ points: SQUARE, closed: false })).toBe(3);
	});
	test("closed paths have one segment per point", () => {
		expect(getFreeformSegmentCount({ points: SQUARE, closed: true })).toBe(4);
	});
	test("degenerate paths have no segments", () => {
		expect(getFreeformSegmentCount({ points: [SQUARE[0]], closed: true })).toBe(
			0,
		);
	});
});

describe("insertPointIntoFreeformSegment (de Casteljau split)", () => {
	test("inserts a midpoint anchor without changing point identity ordering", () => {
		const next = insertPointIntoFreeformSegment({
			points: SQUARE,
			segmentIndex: 0,
			pointId: "mid",
			t: 0.5,
			closed: true,
		});
		expect(next).toHaveLength(5);
		// Inserted between index 0 (a) and index 1 (b).
		const inserted = next[1];
		expect(inserted.id).toBe("mid");
		expect(inserted.x).toBeCloseTo(0, 6); // midpoint of the top edge
		expect(inserted.y).toBeCloseTo(-0.25, 6);
	});

	test("preserves the closed path's coverage (curve is unchanged)", () => {
		const next = insertPointIntoFreeformSegment({
			points: SQUARE,
			segmentIndex: 0,
			pointId: "mid",
			t: 0.5,
			closed: true,
		});
		const polygon = flattenFreeformPath({ points: next, transform: TRANSFORM });
		expect(isPointInPolygon({ polygon, x: 50, y: 50 })).toBe(true);
		expect(isPointInPolygon({ polygon, x: 10, y: 10 })).toBe(false);
	});

	test("returns points unchanged for an out-of-range segment index", () => {
		const next = insertPointIntoFreeformSegment({
			points: SQUARE,
			segmentIndex: 99,
			pointId: "mid",
			t: 0.5,
			closed: true,
		});
		expect(next).toBe(SQUARE);
	});
});

describe("removeFreeformPathPoints + getClosedStateAfterPointRemoval", () => {
	test("removes anchors by id", () => {
		const next = removeFreeformPathPoints({ points: SQUARE, pointIds: ["b"] });
		expect(next.map((p) => p.id)).toEqual(["a", "c", "d"]);
	});

	test("a closed triangle stays closed but a 2-point path opens", () => {
		expect(
			getClosedStateAfterPointRemoval({
				wasClosed: true,
				remainingPointCount: 3,
			}),
		).toBe(true);
		expect(
			getClosedStateAfterPointRemoval({
				wasClosed: true,
				remainingPointCount: 2,
			}),
		).toBe(false);
	});
});

describe("buildFreeformSvgPath", () => {
	test("emits a closed cubic path for a closed shape", () => {
		const d = buildFreeformSvgPath({
			points: SQUARE,
			transform: TRANSFORM,
			closed: true,
		});
		expect(d.startsWith("M 25,25")).toBe(true);
		expect(d.endsWith("Z")).toBe(true);
		expect((d.match(/C /g) ?? []).length).toBe(4); // one per closed segment
	});

	test("omits the closing segment for an open path", () => {
		const d = buildFreeformSvgPath({
			points: SQUARE,
			transform: TRANSFORM,
			closed: false,
		});
		expect(d.includes("Z")).toBe(false);
		expect((d.match(/C /g) ?? []).length).toBe(3);
	});
});

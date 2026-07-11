import { describe, expect, test } from "bun:test";
import {
	computeFeatherUpdate,
	getMaskCenterCanvas,
	rotateVector,
	wrapRotationDegrees,
} from "@/hooks/use-mask-handles";

describe("rotateVector", () => {
	test("rotating (1,0) by 90 degrees gives (0,1)", () => {
		const result = rotateVector({ x: 1, y: 0, degrees: 90 });
		expect(result.x).toBeCloseTo(0, 6);
		expect(result.y).toBeCloseTo(1, 6);
	});

	test("rotating by 0 degrees is the identity", () => {
		const result = rotateVector({ x: 3, y: -5, degrees: 0 });
		expect(result.x).toBeCloseTo(3, 6);
		expect(result.y).toBeCloseTo(-5, 6);
	});

	test("rotating by 180 degrees negates both components", () => {
		const result = rotateVector({ x: 2, y: 4, degrees: 180 });
		expect(result.x).toBeCloseTo(-2, 6);
		expect(result.y).toBeCloseTo(-4, 6);
	});
});

describe("getMaskCenterCanvas", () => {
	test("with no element rotation, offsets by centerX/Y * bounds size", () => {
		const center = getMaskCenterCanvas({
			mask: { centerX: 0.5, centerY: -0.25 },
			bounds: { cx: 400, cy: 300, width: 200, height: 100, rotation: 0 },
		});
		expect(center.x).toBeCloseTo(500, 6);
		expect(center.y).toBeCloseTo(275, 6);
	});

	test("the offset rotates with the element's own rotation", () => {
		const center = getMaskCenterCanvas({
			mask: { centerX: 0.5, centerY: 0 },
			bounds: { cx: 400, cy: 300, width: 200, height: 100, rotation: 90 },
		});
		// A local +X offset of 100 becomes a local +Y offset once the element
		// (and therefore the mask's local frame) is rotated 90 degrees.
		expect(center.x).toBeCloseTo(400, 6);
		expect(center.y).toBeCloseTo(400, 6);
	});
});

describe("wrapRotationDegrees", () => {
	test("wraps values above 180 back into range", () => {
		expect(wrapRotationDegrees(370)).toBeCloseTo(10, 6);
	});

	test("wraps values at/below -180 back into range", () => {
		expect(wrapRotationDegrees(-370)).toBeCloseTo(-10, 6);
		expect(wrapRotationDegrees(-180)).toBeCloseTo(180, 6);
	});

	test("leaves values already in range untouched", () => {
		expect(wrapRotationDegrees(45)).toBeCloseTo(45, 6);
		expect(wrapRotationDegrees(180)).toBeCloseTo(180, 6);
	});
});

describe("computeFeatherUpdate", () => {
	test("projects the drag delta onto the feather axis", () => {
		const result = computeFeatherUpdate({
			startFeather: 0.2,
			deltaX: 10,
			deltaY: 0,
			directionX: 1,
			directionY: 0,
			shortSide: 100,
		});
		// scale = max(shortSide,1)*0.5 = 50; projection = 10 -> +0.2 feather.
		expect(result.feather).toBeCloseTo(0.4, 6);
	});

	test("a delta perpendicular to the feather axis has no effect", () => {
		const result = computeFeatherUpdate({
			startFeather: 0.3,
			deltaX: 0,
			deltaY: 50,
			directionX: 1,
			directionY: 0,
			shortSide: 100,
		});
		expect(result.feather).toBeCloseTo(0.3, 6);
	});

	test("a negative projection decreases feather", () => {
		const result = computeFeatherUpdate({
			startFeather: 0.5,
			deltaX: -20,
			deltaY: 0,
			directionX: 1,
			directionY: 0,
			shortSide: 100,
		});
		// scale = max(shortSide,1)*0.5 = 50; projection = -20 -> -0.4 feather.
		expect(result.feather).toBeCloseTo(0.1, 6);
	});

	test("clamps to [0, 1]", () => {
		const clampedHigh = computeFeatherUpdate({
			startFeather: 0.9,
			deltaX: 1000,
			deltaY: 0,
			directionX: 1,
			directionY: 0,
			shortSide: 100,
		});
		expect(clampedHigh.feather).toBe(1);

		const clampedLow = computeFeatherUpdate({
			startFeather: 0.1,
			deltaX: -1000,
			deltaY: 0,
			directionX: 1,
			directionY: 0,
			shortSide: 100,
		});
		expect(clampedLow.feather).toBe(0);
	});
});

// The mask shapes' signed-distance functions live in
// `shape-mask.frag.glsl` (GLSL, not directly runnable under bun:test). These
// helpers are a deliberate line-for-line TS mirror of that shader math, kept
// here purely so the *geometry* (boundary locations, inside/outside sign) can
// be regression-tested. If shape-mask.frag.glsl's sdDiamond/sdHeart* change,
// update these mirrors too.
function sdDiamond({
	x,
	y,
	rx,
	ry,
}: {
	x: number;
	y: number;
	rx: number;
	ry: number;
}): number {
	const k = Math.abs(x) / rx + Math.abs(y) / ry;
	return (k - 1) * Math.min(rx, ry);
}

function sdHeartRaw({ x: rawX, y: py }: { x: number; y: number }): number {
	const x = Math.abs(rawX);
	if (py + x > 1.0) {
		const dx = x - 0.25;
		const dy = py - 0.75;
		return Math.sqrt(dx * dx + dy * dy) - Math.sqrt(2) / 4;
	}
	const d1x = x;
	const d1y = py - 1;
	const term1 = d1x * d1x + d1y * d1y;
	const m = 0.5 * Math.max(x + py, 0);
	const d2x = x - m;
	const d2y = py - m;
	const term2 = d2x * d2x + d2y * d2y;
	return Math.sqrt(Math.min(term1, term2)) * Math.sign(x - py);
}

const HEART_HALF_WIDTH = 0.6035533905932738; // 0.25 + sqrt(2)/4
const HEART_TOP = 1.1035533905932737; // 0.75 + sqrt(2)/4
const HEART_CENTER_Y = HEART_TOP / 2;

function sdHeart({
	x,
	y,
	rx,
	ry,
}: {
	x: number;
	y: number;
	rx: number;
	ry: number;
}): number {
	const qx = (x / rx) * HEART_HALF_WIDTH;
	const qy = HEART_CENTER_Y - (y / ry) * HEART_CENTER_Y;
	return sdHeartRaw({ x: qx, y: qy }) * Math.min(rx, ry);
}

describe("sdDiamond (mirrors shape-mask.frag.glsl)", () => {
	test("the four vertices are exactly on the boundary", () => {
		expect(sdDiamond({ x: 10, y: 0, rx: 10, ry: 6 })).toBeCloseTo(0, 6);
		expect(sdDiamond({ x: -10, y: 0, rx: 10, ry: 6 })).toBeCloseTo(0, 6);
		expect(sdDiamond({ x: 0, y: 6, rx: 10, ry: 6 })).toBeCloseTo(0, 6);
		expect(sdDiamond({ x: 0, y: -6, rx: 10, ry: 6 })).toBeCloseTo(0, 6);
	});

	test("the center is inside (negative)", () => {
		expect(sdDiamond({ x: 0, y: 0, rx: 10, ry: 6 })).toBeLessThan(0);
	});

	test("a point outside the diamond is positive", () => {
		expect(sdDiamond({ x: 10, y: 6, rx: 10, ry: 6 })).toBeGreaterThan(0);
	});
});

describe("sdHeart / sdHeartRaw (mirrors shape-mask.frag.glsl)", () => {
	test("the bottom cusp (0,0) is on the boundary", () => {
		expect(sdHeartRaw({ x: 0, y: 0 })).toBeCloseTo(0, 4);
	});

	test("the notch between the lobes (0,1) is on the boundary", () => {
		expect(sdHeartRaw({ x: 0, y: 1 })).toBeCloseTo(0, 4);
	});

	test("the rightmost point of the right lobe circle is on the boundary", () => {
		expect(sdHeartRaw({ x: HEART_HALF_WIDTH, y: 0.75 })).toBeCloseTo(0, 4);
	});

	test("a point between the tip and the notch is inside (negative)", () => {
		expect(sdHeartRaw({ x: 0, y: 0.5 })).toBeLessThan(0);
	});

	test("a point below the tip is outside (positive)", () => {
		expect(sdHeartRaw({ x: 0, y: -0.5 })).toBeGreaterThan(0);
	});

	test("sdHeart maps the box's bottom edge to the cusp", () => {
		expect(sdHeart({ x: 0, y: 40, rx: 50, ry: 40 })).toBeCloseTo(0, 3);
	});

	test("sdHeart's box center (0,0) is inside (negative)", () => {
		expect(sdHeart({ x: 0, y: 0, rx: 50, ry: 40 })).toBeLessThan(0);
	});
});

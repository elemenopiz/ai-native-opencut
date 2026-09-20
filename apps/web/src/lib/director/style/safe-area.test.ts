import { describe, expect, test } from "bun:test";
import {
	actionSafeBounds,
	insetToPixelBounds,
	SAFE_AREA,
	titleSafeBounds,
} from "./safe-area";
import type { Canvas, Orientation } from "./types";

const CANVASES: Record<string, Canvas> = {
	landscape: { width: 1920, height: 1080 },
	portrait: { width: 1080, height: 1920 },
	square: { width: 1080, height: 1080 },
};

describe("insetToPixelBounds", () => {
	test("cuts the requested fraction from each edge", () => {
		const bounds = insetToPixelBounds(
			{ width: 1000, height: 500 },
			{ top: 0.1, right: 0.2, bottom: 0.1, left: 0.2 },
		);
		expect(bounds).toEqual({ x: 200, y: 50, width: 600, height: 400 });
	});

	test("zero margins return the full canvas", () => {
		const canvas = { width: 640, height: 360 };
		const bounds = insetToPixelBounds(canvas, {
			top: 0,
			right: 0,
			bottom: 0,
			left: 0,
		});
		expect(bounds).toEqual({ x: 0, y: 0, width: 640, height: 360 });
	});
});

describe("SAFE_AREA", () => {
	const orientations: Orientation[] = ["landscape", "portrait", "square"];

	test.each(orientations)("%s: title-safe nests inside action-safe", (o) => {
		const { actionSafe, titleSafe } = SAFE_AREA[o];
		expect(titleSafe.top).toBeGreaterThanOrEqual(actionSafe.top);
		expect(titleSafe.right).toBeGreaterThanOrEqual(actionSafe.right);
		expect(titleSafe.bottom).toBeGreaterThanOrEqual(actionSafe.bottom);
		expect(titleSafe.left).toBeGreaterThanOrEqual(actionSafe.left);
	});

	test.each(orientations)(
		"%s: titleSafeBounds nests inside actionSafeBounds in pixels",
		(o) => {
			const canvas = CANVASES[o];
			const action = actionSafeBounds(canvas, o);
			const title = titleSafeBounds(canvas, o);
			expect(title.x).toBeGreaterThanOrEqual(action.x);
			expect(title.y).toBeGreaterThanOrEqual(action.y);
			expect(title.x + title.width).toBeLessThanOrEqual(
				action.x + action.width,
			);
			expect(title.y + title.height).toBeLessThanOrEqual(
				action.y + action.height,
			);
		},
	);

	test.each(orientations)("%s: safe rects have positive area", (o) => {
		const canvas = CANVASES[o];
		const title = titleSafeBounds(canvas, o);
		expect(title.width).toBeGreaterThan(0);
		expect(title.height).toBeGreaterThan(0);
	});
});

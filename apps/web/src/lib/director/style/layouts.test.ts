import { describe, expect, test } from "bun:test";
import {
	captionBand,
	centerTitle,
	cornerBug,
	lowerThird,
	resolveLayout,
} from "./layouts";
import { actionSafeBounds, titleSafeBounds } from "./safe-area";
import type { Canvas, Orientation, PixelBounds } from "./types";

const CANVASES: Record<string, Canvas> = {
	landscape: { width: 1920, height: 1080 },
	portrait: { width: 1080, height: 1920 },
	square: { width: 1080, height: 1080 },
};
const ORIENTATIONS = Object.keys(CANVASES) as Orientation[];

/** Asserts `inner` is fully contained within `outer` (all four edges), within floating-point slop. */
function expectWithin(inner: PixelBounds, outer: PixelBounds, label: string) {
	const eps = 1e-6;
	expect(inner.x, `${label}.x >= outer.x`).toBeGreaterThanOrEqual(
		outer.x - eps,
	);
	expect(inner.y, `${label}.y >= outer.y`).toBeGreaterThanOrEqual(
		outer.y - eps,
	);
	expect(
		inner.x + inner.width,
		`${label} right edge <= outer right edge`,
	).toBeLessThanOrEqual(outer.x + outer.width + eps);
	expect(
		inner.y + inner.height,
		`${label} bottom edge <= outer bottom edge`,
	).toBeLessThanOrEqual(outer.y + outer.height + eps);
}

describe("lowerThird", () => {
	test.each(ORIENTATIONS)("%s: stays inside title-safe", (o) => {
		const canvas = CANVASES[o];
		expectWithin(
			lowerThird(canvas, o),
			titleSafeBounds(canvas, o),
			"lowerThird",
		);
	});

	test.each(ORIENTATIONS)(
		"%s: actually lands in the lower half of the frame",
		(o) => {
			const canvas = CANVASES[o];
			const geo = lowerThird(canvas, o);
			// The block's top edge sits in the bottom half of the frame — as low as
			// the title-safe bottom margin allows (see layouts.ts's doc comment: the
			// 70%-down anchor point gets pulled up only as far as overflow forces).
			expect(geo.y).toBeGreaterThan(canvas.height / 2);
		},
	);

	test.each(ORIENTATIONS)(
		"%s: suggests title/subtitle-scale type, left-aligned",
		(o) => {
			const geo = lowerThird(CANVASES[o], o);
			expect(geo.typeStep).toBe("title");
			expect(geo.align).toBe("left");
		},
	);
});

describe("centerTitle", () => {
	test.each(ORIENTATIONS)("%s: stays inside title-safe", (o) => {
		const canvas = CANVASES[o];
		expectWithin(
			centerTitle(canvas, o),
			titleSafeBounds(canvas, o),
			"centerTitle",
		);
	});

	test.each(ORIENTATIONS)(
		"%s: is horizontally and vertically centered in title-safe",
		(o) => {
			const canvas = CANVASES[o];
			const safe = titleSafeBounds(canvas, o);
			const geo = centerTitle(canvas, o);
			const safeCenterX = safe.x + safe.width / 2;
			const safeCenterY = safe.y + safe.height / 2;
			const geoCenterX = geo.x + geo.width / 2;
			const geoCenterY = geo.y + geo.height / 2;
			expect(geoCenterX).toBeCloseTo(safeCenterX, 6);
			expect(geoCenterY).toBeCloseTo(safeCenterY, 6);
		},
	);
});

describe("cornerBug", () => {
	test.each(ORIENTATIONS)("%s: stays inside action-safe", (o) => {
		const canvas = CANVASES[o];
		expectWithin(
			cornerBug(canvas, o),
			actionSafeBounds(canvas, o),
			"cornerBug",
		);
	});

	test.each(ORIENTATIONS)(
		"%s: is anchored to the bottom-right of action-safe",
		(o) => {
			const canvas = CANVASES[o];
			const safe = actionSafeBounds(canvas, o);
			const geo = cornerBug(canvas, o);
			expect(geo.x + geo.width).toBeCloseTo(safe.x + safe.width, 6);
			expect(geo.y + geo.height).toBeCloseTo(safe.y + safe.height, 6);
		},
	);
});

describe("captionBand", () => {
	test.each(ORIENTATIONS)("%s: respects action-safe", (o) => {
		const canvas = CANVASES[o];
		expectWithin(
			captionBand(canvas, o),
			actionSafeBounds(canvas, o),
			"captionBand",
		);
	});

	test.each(ORIENTATIONS)(
		"%s: spans the full action-safe width, bottom-anchored",
		(o) => {
			const canvas = CANVASES[o];
			const safe = actionSafeBounds(canvas, o);
			const geo = captionBand(canvas, o);
			expect(geo.width).toBeCloseTo(safe.width, 6);
			expect(geo.y + geo.height).toBeCloseTo(safe.y + safe.height, 6);
		},
	);
});

describe("resolveLayout", () => {
	test("dispatches to the same geometry as calling the preset directly", () => {
		const canvas = CANVASES.landscape;
		expect(resolveLayout("lowerThird", canvas, "landscape")).toEqual(
			lowerThird(canvas, "landscape"),
		);
		expect(resolveLayout("centerTitle", canvas, "landscape")).toEqual(
			centerTitle(canvas, "landscape"),
		);
		expect(resolveLayout("cornerBug", canvas, "landscape")).toEqual(
			cornerBug(canvas, "landscape"),
		);
		expect(resolveLayout("captionBand", canvas, "landscape")).toEqual(
			captionBand(canvas, "landscape"),
		);
	});
});

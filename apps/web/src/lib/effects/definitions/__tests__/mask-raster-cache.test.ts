import { describe, expect, test } from "bun:test";
import { rasterizeCustomMask } from "../custom-mask";
import { rasterizeTextMask } from "../text-mask";
import type { MaskShape } from "@/types/rendering";

// The rasterizers need a real canvas implementation (OffscreenCanvas +
// Path2D / fillText). bun's test runner has no DOM, so these run only in a
// canvas-capable environment (e.g. a browser-backed runner) and skip
// gracefully otherwise; the LRU key logic they exercise is environment-free.
const hasCanvas =
	typeof OffscreenCanvas !== "undefined" || typeof document !== "undefined";
const canvasTest = hasCanvas ? test : test.skip;

function makeCustomMask(overrides: Partial<MaskShape> = {}): MaskShape {
	return {
		type: "custom",
		feather: 0,
		inverted: false,
		centerX: 0,
		centerY: 0,
		rotation: 0,
		scale: 1,
		closed: true,
		points: [
			{ x: -0.25, y: -0.25 },
			{ x: 0.25, y: -0.25 },
			{ x: 0, y: 0.25 },
		],
		...overrides,
	} as MaskShape;
}

function makeTextMask(overrides: Partial<MaskShape> = {}): MaskShape {
	return {
		type: "text",
		feather: 0,
		inverted: false,
		centerX: 0,
		centerY: 0,
		rotation: 0,
		text: "Byorn",
		fontFamily: "Arial",
		fontWeight: "normal",
		fontSize: 48,
		...overrides,
	} as MaskShape;
}

describe("mask raster cache", () => {
	canvasTest(
		"identical custom masks (distinct objects) share one cached canvas",
		() => {
			const first = rasterizeCustomMask({
				mask: makeCustomMask(),
				width: 320,
				height: 180,
			});
			const second = rasterizeCustomMask({
				mask: makeCustomMask(),
				width: 320,
				height: 180,
			});
			expect(first).not.toBeNull();
			expect(second).toBe(first);
		},
	);

	canvasTest("feather is excluded from the custom-mask cache key", () => {
		const base = rasterizeCustomMask({
			mask: makeCustomMask({ feather: 0 }),
			width: 320,
			height: 180,
		});
		const feathered = rasterizeCustomMask({
			mask: makeCustomMask({ feather: 0.5 }),
			width: 320,
			height: 180,
		});
		expect(feathered).toBe(base);
	});

	canvasTest("geometry or size changes miss the custom-mask cache", () => {
		const base = rasterizeCustomMask({
			mask: makeCustomMask(),
			width: 320,
			height: 180,
		});
		const resized = rasterizeCustomMask({
			mask: makeCustomMask(),
			width: 321,
			height: 180,
		});
		const moved = rasterizeCustomMask({
			mask: makeCustomMask({ centerX: 0.1 }),
			width: 320,
			height: 180,
		});
		expect(resized).not.toBe(base);
		expect(moved).not.toBe(base);
	});

	canvasTest(
		"identical text masks (distinct objects) share one cached canvas",
		() => {
			const first = rasterizeTextMask({
				mask: makeTextMask(),
				width: 320,
				height: 180,
			});
			const second = rasterizeTextMask({
				mask: makeTextMask(),
				width: 320,
				height: 180,
			});
			expect(first).not.toBeNull();
			expect(second).toBe(first);
		},
	);

	canvasTest("text content changes miss the text-mask cache", () => {
		const base = rasterizeTextMask({
			mask: makeTextMask(),
			width: 320,
			height: 180,
		});
		const changed = rasterizeTextMask({
			mask: makeTextMask({ text: "Other" }),
			width: 320,
			height: 180,
		});
		expect(changed).not.toBe(base);
	});
});

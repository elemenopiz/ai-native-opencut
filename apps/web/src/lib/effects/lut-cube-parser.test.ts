import { describe, expect, test } from "bun:test";
import { buildCubeText } from "./lut-builtins";
import { parseCubeLut } from "./lut-cube-parser";

/**
 * Regression coverage for the ≥65-point `.cube` acceptance check
 * (palmier-delta-refresh-2026-07-14.md §4.9): DaVinci Resolve's default `.cube`
 * export size is 65 (`LUT_3D_SIZE 65`). A competitor's parser once carried a
 * stale 64-entry cap that silently rejected those exports. This file asserts
 * our parser has no such cap, both at the Resolve-default size and comfortably
 * beyond it.
 */
describe("parseCubeLut — LUT_3D_SIZE acceptance", () => {
	test("accepts a 65-point LUT (DaVinci Resolve's default .cube export size)", () => {
		const text = buildCubeText({
			title: "Resolve Default",
			size: 65,
			transform: (r, g, b) => [r, g, b],
		});
		const lut = parseCubeLut(text);
		expect(lut.size).toBe(65);
		expect(lut.data.length).toBe(65 * 65 * 65 * 3);
	});

	test("identity data round-trips correctly at 65-point resolution", () => {
		const text = buildCubeText({
			title: "Resolve Default",
			size: 65,
			transform: (r, g, b) => [r, g, b],
		});
		const lut = parseCubeLut(text);
		// First entry is black.
		expect(lut.data[0]).toBeCloseTo(0, 5);
		expect(lut.data[1]).toBeCloseTo(0, 5);
		expect(lut.data[2]).toBeCloseTo(0, 5);
		// Last entry is white.
		const last = (65 * 65 * 65 - 1) * 3;
		expect(lut.data[last]).toBeCloseTo(1, 5);
		expect(lut.data[last + 1]).toBeCloseTo(1, 5);
		expect(lut.data[last + 2]).toBeCloseTo(1, 5);
	});

	test("still rejects LUT_3D_SIZE above the parser's upper bound", () => {
		const text = `TITLE "Too Big"\nLUT_3D_SIZE 300\n0 0 0\n`;
		expect(() => parseCubeLut(text)).toThrow(/LUT_3D_SIZE/);
	});

	test("still rejects LUT_3D_SIZE below the parser's lower bound", () => {
		const text = `TITLE "Too Small"\nLUT_3D_SIZE 1\n0 0 0\n`;
		expect(() => parseCubeLut(text)).toThrow(/LUT_3D_SIZE/);
	});
});

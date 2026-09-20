import { describe, expect, test } from "bun:test";
import {
	fontSizePx,
	lineHeightPx,
	TYPE_SCALE,
	type TypeStep,
} from "./type-scale";

const STEPS: TypeStep[] = ["display", "title", "subtitle", "body", "caption"];

describe("TYPE_SCALE", () => {
	test("steps are strictly decreasing from display to caption", () => {
		for (let i = 1; i < STEPS.length; i++) {
			const prev = TYPE_SCALE[STEPS[i - 1]].fontSizeRatio;
			const curr = TYPE_SCALE[STEPS[i]].fontSizeRatio;
			expect(curr).toBeLessThan(prev);
		}
	});

	test.each(STEPS)("%s has a sane line-height and letter-spacing", (step) => {
		const style = TYPE_SCALE[step];
		expect(style.lineHeight).toBeGreaterThan(1);
		expect(style.lineHeight).toBeLessThan(2);
		expect(Math.abs(style.letterSpacing)).toBeLessThan(0.05);
	});
});

describe("fontSizePx", () => {
	test.each(STEPS)("%s scales proportionally with canvas height", (step) => {
		const base = fontSizePx(step, { width: 1000, height: 1000 });
		const doubled = fontSizePx(step, { width: 1000, height: 2000 });
		expect(doubled).toBeCloseTo(base * 2, 6);
	});

	test("is independent of canvas width", () => {
		const narrow = fontSizePx("title", { width: 200, height: 1080 });
		const wide = fontSizePx("title", { width: 4000, height: 1080 });
		expect(narrow).toBe(wide);
	});
});

describe("lineHeightPx", () => {
	test("equals fontSizePx times the step's line-height multiple", () => {
		const canvas = { width: 1920, height: 1080 };
		for (const step of STEPS) {
			expect(lineHeightPx(step, canvas)).toBeCloseTo(
				fontSizePx(step, canvas) * TYPE_SCALE[step].lineHeight,
				6,
			);
		}
	});
});

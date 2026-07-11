import { describe, expect, test } from "bun:test";
import {
	DEFAULT_LINE_HEIGHT,
	FONT_SIZE_SCALE_REFERENCE,
} from "@/constants/text-constants";
import {
	buildTextMaskFontString,
	getTextMaskGlyphPx,
	getTextMaskLineHeightPx,
	getTextMaskLineOffsets,
	getTextMaskLines,
} from "../text-layout";

describe("getTextMaskGlyphPx", () => {
	test("scales fontSize by element height over the shared reference", () => {
		// A text element and a text mask should read at the same proportional size
		// on the same-sized element: fontSize * height / FONT_SIZE_SCALE_REFERENCE.
		expect(getTextMaskGlyphPx({ fontSize: 15, height: 90 })).toBeCloseTo(15, 6);
		expect(
			getTextMaskGlyphPx({ fontSize: 15, height: FONT_SIZE_SCALE_REFERENCE }),
		).toBeCloseTo(15, 6);
		expect(getTextMaskGlyphPx({ fontSize: 30, height: 180 })).toBeCloseTo(
			60,
			6,
		);
	});

	test("is resolution-independent — doubling the element pixels doubles glyphs", () => {
		const small = getTextMaskGlyphPx({ fontSize: 20, height: 200 });
		const large = getTextMaskGlyphPx({ fontSize: 20, height: 400 });
		expect(large).toBeCloseTo(small * 2, 6);
	});

	test("never returns below 1px", () => {
		expect(getTextMaskGlyphPx({ fontSize: 0, height: 100 })).toBe(1);
		expect(getTextMaskGlyphPx({ fontSize: 1, height: 1 })).toBe(1);
	});
});

describe("getTextMaskLines", () => {
	test("returns a single entry for single-line content", () => {
		expect(getTextMaskLines({ text: "Reveal" })).toEqual(["Reveal"]);
	});

	test("splits on hard newlines", () => {
		expect(getTextMaskLines({ text: "one\ntwo\nthree" })).toEqual([
			"one",
			"two",
			"three",
		]);
	});

	test("preserves a trailing blank line", () => {
		expect(getTextMaskLines({ text: "line\n" })).toEqual(["line", ""]);
	});
});

describe("getTextMaskLineHeightPx", () => {
	test("multiplies glyph size by the shared default line height", () => {
		expect(getTextMaskLineHeightPx({ glyphPx: 40 })).toBeCloseTo(
			40 * DEFAULT_LINE_HEIGHT,
			6,
		);
	});
});

describe("getTextMaskLineOffsets", () => {
	test("centers a single line on the origin", () => {
		expect(getTextMaskLineOffsets({ lineCount: 1, lineHeightPx: 50 })).toEqual([
			0,
		]);
	});

	test("centers a two-line block symmetrically around the origin", () => {
		const offsets = getTextMaskLineOffsets({ lineCount: 2, lineHeightPx: 50 });
		expect(offsets).toEqual([-25, 25]);
		// The block's vertical center is the origin (sum of offsets is zero).
		expect(offsets[0] + offsets[1]).toBeCloseTo(0, 6);
	});

	test("puts the middle line of an odd block on the origin", () => {
		const offsets = getTextMaskLineOffsets({ lineCount: 3, lineHeightPx: 30 });
		expect(offsets).toEqual([-30, 0, 30]);
	});

	test("returns nothing for a non-positive line count", () => {
		expect(getTextMaskLineOffsets({ lineCount: 0, lineHeightPx: 50 })).toEqual(
			[],
		);
	});
});

describe("buildTextMaskFontString", () => {
	test('matches the canvas font format: weight px "family", fallback', () => {
		expect(
			buildTextMaskFontString({
				fontWeight: "bold",
				glyphPx: 42,
				fontFamily: "Roboto",
			}),
		).toBe('bold 42px "Roboto", sans-serif');
	});

	test("escapes quotes in the family name", () => {
		expect(
			buildTextMaskFontString({
				fontWeight: "normal",
				glyphPx: 16,
				fontFamily: 'Weird"Font',
			}),
		).toBe('normal 16px "Weird\\"Font", sans-serif');
	});
});

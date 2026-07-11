// Adapted from OpenCut-app/OpenCut (pre-rewrite tag, MIT) —
// apps/web/src/masks/builtin/definitions/text.ts. Their glyph feather is a
// Rust/WASM jump-flood crate (not portable); the portable part is the Canvas2D
// `fillText` glyph rasterization + element-relative sizing, ported here. This
// module holds the *pure* text-mask layout math (no Canvas2D) so it is unit-
// testable under bun, mirroring `freeform-path.ts`'s split of pure geometry from
// the browser-only rasterizer in `definitions/text-mask.ts`.
import {
	DEFAULT_LINE_HEIGHT,
	FONT_SIZE_SCALE_REFERENCE,
} from "@/constants/text-constants";

/**
 * Glyph pixel size for a text mask. Mirrors the text node's `scaleFontSize`
 * (`fontSize * canvasHeight / FONT_SIZE_SCALE_REFERENCE`) but references the
 * element's own pixel height, so a mask's `fontSize` reads at the same
 * proportional size as a text element's font size on the same-sized element —
 * and stays resolution-independent (it scales with the element's pixel bounds).
 * Matches pre-rewrite `text.ts`, which sizes glyphs against `bounds.height`.
 */
export function getTextMaskGlyphPx({
	fontSize,
	height,
}: {
	fontSize: number;
	height: number;
}): number {
	return Math.max(1, (fontSize * height) / FONT_SIZE_SCALE_REFERENCE);
}

/** Split the mask content into lines on hard newlines (no word-wrapping). */
export function getTextMaskLines({ text }: { text: string }): string[] {
	return text.split("\n");
}

/**
 * The vertical center of each line, in pixels, for a block of `lineCount` lines
 * vertically centered on the origin. Used with `textBaseline = "middle"`, so
 * each returned value is the y at which that line's `fillText` is drawn.
 */
export function getTextMaskLineOffsets({
	lineCount,
	lineHeightPx,
}: {
	lineCount: number;
	lineHeightPx: number;
}): number[] {
	if (lineCount <= 0) {
		return [];
	}
	const blockHeight = lineCount * lineHeightPx;
	const start = -blockHeight / 2 + lineHeightPx / 2;
	return Array.from(
		{ length: lineCount },
		(_, index) => start + index * lineHeightPx,
	);
}

/** Line box height in pixels (glyph size times the shared default line height). */
export function getTextMaskLineHeightPx({
	glyphPx,
}: {
	glyphPx: number;
}): number {
	return glyphPx * DEFAULT_LINE_HEIGHT;
}

/**
 * The Canvas2D `ctx.font` string for a text mask, matching the text node's
 * format (`"<weight> <px>px \"<family>\", sans-serif"`). System-font fallback is
 * appended so an unloaded custom family still rasterizes something legible.
 */
export function buildTextMaskFontString({
	fontWeight,
	glyphPx,
	fontFamily,
}: {
	fontWeight: "normal" | "bold";
	glyphPx: number;
	fontFamily: string;
}): string {
	const quoted = `"${fontFamily.replace(/"/g, '\\"')}"`;
	return `${fontWeight} ${glyphPx}px ${quoted}, sans-serif`;
}

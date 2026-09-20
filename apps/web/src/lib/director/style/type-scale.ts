/**
 * Type scale — a small named ramp of font-size steps, expressed as fractions
 * of frame HEIGHT (not pixels) so type scales with the canvas instead of
 * being pinned to a resolution that only happens to match one export preset.
 * Same "ratio, not pixels" discipline `safe-area.ts` uses for margins.
 *
 * Five steps, largest to smallest: `display` (a hero title-card treatment),
 * `title` (a named lower-third/section title), `subtitle` (a secondary line
 * under a title), `body` (on-screen prose/captions-as-paragraph), `caption`
 * (the smallest — burned-in dialogue captions, the tightest legibility
 * budget). Each step also carries a line-height multiplier (of its own font
 * size) and a letter-spacing value (em units, i.e. also of its own font size)
 * — both tuned per step rather than shared, because a big display step reads
 * better tight (less line-height, slightly negative tracking, the common
 * motion-title convention) while a small caption step needs the opposite
 * (more line-height for two-line stacks, slightly open tracking to stay
 * legible with a stroke around it — see `captions.ts`).
 *
 * ARBITRARY, FLAGGED FOR REVIEW: the exact ratios are this module's editorial
 * judgment (grounded in common motion-graphics/caption-design practice, not
 * measured against a specific brand's type spec) — a human with an actual
 * brand type ramp should replace these.
 */

import type { Canvas } from "./types";

export type TypeStep = "display" | "title" | "subtitle" | "body" | "caption";

/** One step's shape. `fontSizeRatio` is a fraction of frame HEIGHT (see file header); `lineHeight`/`letterSpacing` are multiples of that resolved font size. */
export interface TypeStyle {
	/** Font size as a fraction of frame height. */
	fontSizeRatio: number;
	/** Line height, as a multiple of font size (CSS `line-height` unitless convention). */
	lineHeight: number;
	/** Letter spacing, in em (i.e. a multiple of font size — CSS `letter-spacing: <n>em`). */
	letterSpacing: number;
}

export const TYPE_SCALE: Record<TypeStep, TypeStyle> = {
	display: { fontSizeRatio: 0.16, lineHeight: 1.05, letterSpacing: -0.01 },
	title: { fontSizeRatio: 0.1, lineHeight: 1.15, letterSpacing: -0.005 },
	subtitle: { fontSizeRatio: 0.075, lineHeight: 1.25, letterSpacing: 0 },
	body: { fontSizeRatio: 0.055, lineHeight: 1.35, letterSpacing: 0 },
	caption: { fontSizeRatio: 0.045, lineHeight: 1.3, letterSpacing: 0.01 },
};

/** Resolve `step`'s font size to concrete pixels for `canvas`'s height. */
export function fontSizePx(step: TypeStep, canvas: Canvas): number {
	return TYPE_SCALE[step].fontSizeRatio * canvas.height;
}

/** Resolve `step`'s line height to concrete pixels for `canvas`'s height (font size × line-height multiple). */
export function lineHeightPx(step: TypeStep, canvas: Canvas): number {
	return fontSizePx(step, canvas) * TYPE_SCALE[step].lineHeight;
}

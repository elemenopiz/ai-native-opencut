/**
 * Default caption treatment — the concrete recipe for readable burned-in
 * captions over ARBITRARY footage: which type step, how thick a stroke,
 * which scrim, and where (safe-area-aware placement, via `captionBand` —
 * see `layouts.ts`).
 *
 * A stroke (an outlined/outset edge around each glyph) is included alongside
 * the scrim rather than instead of it: a scrim alone can still fail on
 * high-contrast, fast-moving footage right behind a letter's edge, and a
 * stroke alone can still fail on a background that happens to match the
 * stroke color — layering both is standard caption-design practice ("belt and
 * suspenders" legibility) and each is cheap to skip independently if a caller
 * wants to override just one (again, DEFAULTS — see `types.ts`).
 *
 * ARBITRARY, FLAGGED FOR REVIEW: `strokeWidthRatio` (8% of font size) is a
 * common comfortable outline weight for caption-style stroked type — thick
 * enough to read on busy footage, thin enough not to fatten small glyphs into
 * mush. Not measured against real footage.
 */

import type { Canvas, Orientation } from "./types";
import { DEFAULT_PALETTE, type ScrimStyle } from "./palette";
import { captionBand, type LayoutGeometry } from "./layouts";
import { fontSizePx, type TypeStep } from "./type-scale";

/** The caption recipe: type step, stroke, and scrim. Placement is resolved separately (see {@link resolveCaptionTreatment}) since it needs a concrete canvas/orientation. */
export interface CaptionTreatment {
	typeStep: TypeStep;
	/** Stroke width as a fraction of the resolved font size (e.g. 0.08 ⇒ 8% of font size). */
	strokeWidthRatio: number;
	/** Stroke color (hex). */
	strokeColor: string;
	/** Foreground (glyph fill) color — defaults to the palette's `foreground`. */
	color: string;
	/** Background scrim behind the caption band. */
	scrim: ScrimStyle;
}

export const DEFAULT_CAPTION_TREATMENT: CaptionTreatment = {
	typeStep: "caption",
	strokeWidthRatio: 0.08,
	strokeColor: "#000000",
	color: DEFAULT_PALETTE.foreground,
	scrim: DEFAULT_PALETTE.scrimDark,
};

/** A caption treatment resolved to concrete pixel values for one canvas/orientation. */
export interface ResolvedCaptionTreatment extends CaptionTreatment {
	/** Resolved font size, pixels. */
	fontSizePx: number;
	/** Resolved stroke width, pixels (`fontSizePx * strokeWidthRatio`). */
	strokeWidthPx: number;
	/** Where the caption band sits — safe-area-aware, from `layouts.ts`'s `captionBand` preset. */
	placement: LayoutGeometry;
}

/**
 * Resolve {@link DEFAULT_CAPTION_TREATMENT} (or a caller-supplied override)
 * against a concrete canvas/orientation: font size and stroke width in
 * pixels, plus the `captionBand` layout geometry for placement. Pure —
 * ties together `type-scale.ts`, `palette.ts`, and `layouts.ts` without any
 * of them needing to know about the others.
 */
export function resolveCaptionTreatment(
	canvas: Canvas,
	orientation: Orientation,
	treatment: CaptionTreatment = DEFAULT_CAPTION_TREATMENT,
): ResolvedCaptionTreatment {
	const resolvedFontSizePx = fontSizePx(treatment.typeStep, canvas);
	return {
		...treatment,
		fontSizePx: resolvedFontSizePx,
		strokeWidthPx: resolvedFontSizePx * treatment.strokeWidthRatio,
		placement: captionBand(canvas, orientation),
	};
}

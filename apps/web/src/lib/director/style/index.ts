/**
 * Public surface of `lib/director/style/` — the Director's layout/typography
 * DEFAULTS module. See `./types.ts` for the shared contract (`Orientation`,
 * `Canvas`, `PixelBounds`) and its design-principle note: everything exported
 * here is plain data or a pure function over plain data — a default the model
 * reads and may override, never a constraint enforced at a boundary.
 *
 * NOTHING IS WIRED HERE. This directory is library-only, same discipline
 * `craft/index.ts` documents for its own macros: turning a `LayoutGeometry`
 * into an actual timeline text/graphic element is a later phase's job.
 */

export type { Canvas, Orientation, PixelBounds } from "./types";

export {
	actionSafeBounds,
	insetToPixelBounds,
	SAFE_AREA,
	titleSafeBounds,
	type SafeArea,
	type SafeMargins,
} from "./safe-area";

export {
	fontSizePx,
	lineHeightPx,
	TYPE_SCALE,
	type TypeStep,
	type TypeStyle,
} from "./type-scale";

export {
	DEFAULT_PALETTE,
	type Palette,
	type ScrimStyle,
} from "./palette";

export {
	captionBand,
	centerTitle,
	cornerBug,
	lowerThird,
	resolveLayout,
	type LayoutAlign,
	type LayoutGeometry,
	type LayoutPreset,
} from "./layouts";

export {
	DEFAULT_CAPTION_TREATMENT,
	resolveCaptionTreatment,
	type CaptionTreatment,
	type ResolvedCaptionTreatment,
} from "./captions";

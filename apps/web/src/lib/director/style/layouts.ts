/**
 * Named layout presets — the four building blocks a professional video is
 * actually made of: `lowerThird` (a name/title card anchored low-left),
 * `centerTitle` (a full-bleed hero title/statement, dead center), `cornerBug`
 * (a small persistent mark — logo/watermark — tucked in a corner), and
 * `captionBand` (the bottom band burned-in dialogue captions occupy).
 *
 * Each resolver returns plain {@link LayoutGeometry} — position, size, and a
 * SUGGESTED {@link TypeStep} — computed from a concrete {@link Canvas} and
 * {@link Orientation}. "Suggested" is load-bearing: per this directory's
 * design principle (see `types.ts`), nothing here is enforced. A caller is
 * free to render at a different type step or ignore the geometry outright;
 * this module only gives a good-by-default answer.
 *
 * Two of the four (`lowerThird`, `centerTitle`) are TEXT placements and are
 * therefore computed inside the TITLE-safe rect (the tighter of the two safe
 * rects — see `safe-area.ts`). The other two (`cornerBug`, `captionBand`) are
 * computed inside the looser ACTION-safe rect: a bug is a small graphic, not
 * running text, and a caption band is conventionally allowed to sit closer to
 * the true frame edge than a title would (captions are commonly the closest
 * on-screen text to the bottom edge in professional practice — action-safe,
 * not title-safe, is the right bound for it).
 */

import type { Canvas, Orientation, PixelBounds } from "./types";
import { actionSafeBounds, titleSafeBounds } from "./safe-area";
import { lineHeightPx, type TypeStep } from "./type-scale";

export type LayoutPreset =
	| "lowerThird"
	| "centerTitle"
	| "cornerBug"
	| "captionBand";

/** Suggested horizontal text alignment for the geometry — a hint, not a render instruction. */
export type LayoutAlign = "left" | "center" | "right";

/** Plain geometry for one resolved layout preset. Position/size are pixel bounds; `typeStep` is the suggested `type-scale.ts` step for the preset's primary text. */
export interface LayoutGeometry extends PixelBounds {
	typeStep: TypeStep;
	align: LayoutAlign;
}

/**
 * `lowerThird` — a name/title block anchored low and left, the classic
 * broadcast "who is this" card. Sized for two stacked lines (`title` +
 * `subtitle`, the two type steps a lower third conventionally carries) plus
 * 15% padding, and does not span the full safe width — a lower third leaves
 * the right side of the frame clear for the subject.
 *
 * Positioned by anchoring its BOTTOM edge near the bottom of the title-safe
 * rect (a fixed 70%-down starting point, pulled up if the block would
 * overflow past the safe bottom) so it reads as low in the frame as the safe
 * margins allow, never spilling past them.
 */
export function lowerThird(
	canvas: Canvas,
	orientation: Orientation,
): LayoutGeometry {
	const safe = titleSafeBounds(canvas, orientation);
	const width = safe.width * 0.55;
	const height =
		(lineHeightPx("title", canvas) + lineHeightPx("subtitle", canvas)) * 1.15;

	let top = canvas.height * 0.7;
	const safeBottom = safe.y + safe.height;
	if (top + height > safeBottom) top = safeBottom - height;
	if (top < safe.y) top = safe.y;

	return { x: safe.x, y: top, width, height, typeStep: "title", align: "left" };
}

/**
 * `centerTitle` — a full-statement hero title, dead center of the title-safe
 * rect both axes. Sized for a single `display`-step line plus 20% padding;
 * width is 80% of the safe rect, so it never touches the safe boundary even
 * before centering.
 */
export function centerTitle(
	canvas: Canvas,
	orientation: Orientation,
): LayoutGeometry {
	const safe = titleSafeBounds(canvas, orientation);
	const width = safe.width * 0.8;
	const height = lineHeightPx("display", canvas) * 1.2;
	const x = safe.x + (safe.width - width) / 2;
	const y = safe.y + (safe.height - height) / 2;
	return { x, y, width, height, typeStep: "display", align: "center" };
}

/**
 * `cornerBug` — a small persistent mark (logo/watermark, optionally paired
 * with a short label at `caption` size) tucked bottom-right, sized to 10% of
 * the shorter canvas dimension so it stays a fixed visual weight regardless
 * of aspect ratio. Bottom-right rather than top-left/right so it never
 * competes with a `lowerThird` or top-anchored on-screen graphic.
 */
export function cornerBug(
	canvas: Canvas,
	orientation: Orientation,
): LayoutGeometry {
	const safe = actionSafeBounds(canvas, orientation);
	const size = Math.min(canvas.width, canvas.height) * 0.1;
	const x = safe.x + safe.width - size;
	const y = safe.y + safe.height - size;
	return {
		x,
		y,
		width: size,
		height: size,
		typeStep: "caption",
		align: "right",
	};
}

/**
 * `captionBand` — the bottom band burned-in dialogue captions occupy: full
 * action-safe width, bottom-anchored inside the action-safe rect, sized for
 * two stacked `caption`-step lines plus padding (most caption renderers wrap
 * to at most two lines before truncating/re-timing).
 */
export function captionBand(
	canvas: Canvas,
	orientation: Orientation,
): LayoutGeometry {
	const safe = actionSafeBounds(canvas, orientation);
	const height = lineHeightPx("caption", canvas) * 2.2;
	const y = safe.y + safe.height - height;
	return {
		x: safe.x,
		y,
		width: safe.width,
		height,
		typeStep: "caption",
		align: "center",
	};
}

const RESOLVERS: Record<
	LayoutPreset,
	(canvas: Canvas, orientation: Orientation) => LayoutGeometry
> = {
	lowerThird,
	centerTitle,
	cornerBug,
	captionBand,
};

/** Resolve any {@link LayoutPreset} by name — a dispatch convenience over calling the named function directly. */
export function resolveLayout(
	preset: LayoutPreset,
	canvas: Canvas,
	orientation: Orientation,
): LayoutGeometry {
	return RESOLVERS[preset](canvas, orientation);
}

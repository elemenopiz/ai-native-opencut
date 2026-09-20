/**
 * Safe margins — title-safe and action-safe insets, per {@link Orientation}.
 *
 * Broadcast vocabulary: ACTION-safe is the looser bound (graphics/motion may
 * approach it) — the classic 90%-of-frame convention (5% inset each side).
 * TITLE-safe is the tighter bound reserved for text — the classic 80%-of-frame
 * convention (10% inset each side). Title-safe insets are always >= action-safe
 * insets, i.e. the title-safe rect nests INSIDE the action-safe rect.
 *
 * Landscape uses those textbook broadcast numbers unchanged — they're a well
 * established standard this module has no reason to second-guess. Portrait and
 * square have no equivalent broadcast standard (vertical video is a phone-app
 * invention), so their numbers are this module's own judgment call, informed
 * by where short-form platforms (Reels/TikTok/Shorts) put their own chrome:
 * a top status bar/progress rail, and a much heavier bottom zone (caption
 * text, a CTA, the account/description block) plus a right-edge engagement-icon
 * column. ARBITRARY, FLAGGED FOR HUMAN REVIEW: the exact fractions below are
 * this module's best estimate, not measured against a specific platform's
 * current safe-zone kit (those kits also drift over time) — a human who wants
 * pixel-parity with one specific platform should replace these.
 *
 * All margins are FRACTIONS of the corresponding frame dimension (top/bottom
 * as a fraction of height, left/right as a fraction of width) so they hold at
 * any resolution — the same "ratio, not pixels" discipline the type scale
 * uses (see `type-scale.ts`).
 */

import type { Canvas, Orientation, PixelBounds } from "./types";

/** Inset from each edge, as a fraction of that edge's frame dimension (top/bottom ÷ height, left/right ÷ width). */
export interface SafeMargins {
	top: number;
	right: number;
	bottom: number;
	left: number;
}

/** The two nested safe rects for one {@link Orientation}. `titleSafe` always nests inside `actionSafe`. */
export interface SafeArea {
	actionSafe: SafeMargins;
	titleSafe: SafeMargins;
}

/**
 * Default safe area per orientation. See file header for the rationale and
 * the explicit "arbitrary, flag for review" call-out on the portrait/square
 * numbers.
 */
export const SAFE_AREA: Record<Orientation, SafeArea> = {
	landscape: {
		// Classic broadcast 90%/80% action-safe/title-safe.
		actionSafe: { top: 0.05, right: 0.05, bottom: 0.05, left: 0.05 },
		titleSafe: { top: 0.1, right: 0.1, bottom: 0.1, left: 0.1 },
	},
	portrait: {
		// Heavier top (status bar / progress rail) and much heavier bottom
		// (caption/CTA/account block) than landscape; extra right margin for a
		// vertical engagement-icon column most short-form platforms render there.
		actionSafe: { top: 0.08, right: 0.12, bottom: 0.18, left: 0.05 },
		titleSafe: { top: 0.12, right: 0.16, bottom: 0.25, left: 0.08 },
	},
	square: {
		// Between landscape and portrait: feed posts carry some caption/UI
		// overlap (bottom) but nothing like a full vertical-app chrome stack.
		actionSafe: { top: 0.06, right: 0.06, bottom: 0.1, left: 0.06 },
		titleSafe: { top: 0.1, right: 0.1, bottom: 0.16, left: 0.1 },
	},
};

/**
 * Resolve a fractional {@link SafeMargins} inset against a concrete
 * {@link Canvas} size into pixel bounds — the rectangle left over once the
 * margins are cut away from each edge. Pure arithmetic; never clamps or
 * validates the caller's numbers (see file header's design principle) and
 * happily returns a zero/negative-size rect if the margins exceed the canvas.
 */
export function insetToPixelBounds(
	canvas: Canvas,
	margins: SafeMargins,
): PixelBounds {
	const left = margins.left * canvas.width;
	const right = margins.right * canvas.width;
	const top = margins.top * canvas.height;
	const bottom = margins.bottom * canvas.height;
	return {
		x: left,
		y: top,
		width: canvas.width - left - right,
		height: canvas.height - top - bottom,
	};
}

/** Convenience: the action-safe pixel rect for `orientation` at `canvas`'s size. */
export function actionSafeBounds(
	canvas: Canvas,
	orientation: Orientation,
): PixelBounds {
	return insetToPixelBounds(canvas, SAFE_AREA[orientation].actionSafe);
}

/** Convenience: the title-safe pixel rect for `orientation` at `canvas`'s size. */
export function titleSafeBounds(
	canvas: Canvas,
	orientation: Orientation,
): PixelBounds {
	return insetToPixelBounds(canvas, SAFE_AREA[orientation].titleSafe);
}

export interface Transform {
	scale: number;
	position: {
		x: number;
		y: number;
	};
	rotate: number;
}

export interface CropRect {
	top: number;
	right: number;
	bottom: number;
	left: number;
}

export type MaskShapeType =
	| "rectangle"
	| "ellipse"
	| "star"
	| "cinematic-bars"
	| "split"
	| "heart"
	| "diamond"
	// Custom pen-tool freeform bezier path. Unlike the analytic SDF shapes above,
	// a "custom" mask is defined by `points`/`closed` and is rasterized to an
	// alpha texture at render time (see lib/effects/definitions/custom-mask.ts).
	| "custom"
	// Text-reveal mask: footage visible only through glyph shapes. Like "custom",
	// it is non-analytic — glyphs are rasterized (Canvas2D `fillText`) to an alpha
	// texture and fed through the same feather/composite passes as the pen mask
	// (see lib/effects/definitions/text-mask.ts).
	| "text";

/**
 * A single anchor on a custom pen-tool path. Coordinates are element-local
 * fractions (of element width/height) relative to the mask center; `in`/`out`
 * are the incoming/outgoing bezier tangent handles as offsets from the anchor.
 * Mirrors OpenCut pre-rewrite's `FreeformPathPoint`.
 */
export interface MaskPathPoint {
	id: string;
	x: number;
	y: number;
	inX: number;
	inY: number;
	outX: number;
	outY: number;
}

export interface MaskShape {
	type: MaskShapeType;
	/** Feather width as a fraction of the element's short side (0..1). */
	feather: number;
	inverted: boolean;
	/** Center offset from the element center, as a fraction of element width/height. */
	centerX?: number;
	centerY?: number;
	/** Mask size as a fraction of element width/height. */
	width?: number;
	height?: number;
	/** Rotation in degrees, relative to the element. */
	rotation?: number;
	/**
	 * Uniform scale applied to the custom pen-path only (default 1). Unused by
	 * the analytic SDF shapes, which resize via `width`/`height`.
	 */
	scale?: number;
	/** Anchor points for a `"custom"` pen-tool path. Ignored by other shapes. */
	points?: MaskPathPoint[];
	/** Whether a `"custom"` path is closed (only closed paths render a mask). */
	closed?: boolean;
	/**
	 * Content of a `"text"` mask (glyphs the footage shows through). Supports
	 * newlines for multi-line. Ignored by other shapes. An empty/blank string
	 * leaves the element fully visible (the mask is inactive).
	 */
	text?: string;
	/** Font family for a `"text"` mask (default "Arial"). */
	fontFamily?: string;
	/** Font weight for a `"text"` mask (default "normal"). */
	fontWeight?: "normal" | "bold";
	/**
	 * Font size for a `"text"` mask, in the same point-units as text elements
	 * (default 15). Mapped to element pixels via FONT_SIZE_SCALE_REFERENCE, so it
	 * is sized relative to the element like a text element's font size.
	 */
	fontSize?: number;
}

export type BlendMode =
	| "normal"
	| "darken"
	| "multiply"
	| "color-burn"
	| "lighten"
	| "screen"
	| "plus-lighter"
	| "color-dodge"
	| "overlay"
	| "soft-light"
	| "hard-light"
	| "difference"
	| "exclusion"
	| "hue"
	| "saturation"
	| "color"
	| "luminosity";

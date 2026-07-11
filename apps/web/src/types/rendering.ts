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
	| "diamond";

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

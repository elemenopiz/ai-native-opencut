export interface Effect {
	id: string;
	type: string;
	params: EffectParamValues;
	enabled: boolean;
}

export type EffectParamType =
	| "number"
	| "boolean"
	| "select"
	| "color"
	| "wheel"
	| "lut";

export type EffectParamValues = Record<string, number | string | boolean>;

interface BaseEffectParamDefinition {
	key: string;
	label: string;
}

export interface NumberEffectParamDefinition extends BaseEffectParamDefinition {
	type: "number";
	default: number;
	min: number;
	max: number;
	step: number;
}

interface BooleanEffectParamDefinition extends BaseEffectParamDefinition {
	type: "boolean";
	default: boolean;
}

interface SelectEffectParamDefinition extends BaseEffectParamDefinition {
	type: "select";
	default: string;
	options: Array<{ value: string; label: string }>;
}

interface ColorEffectParamDefinition extends BaseEffectParamDefinition {
	type: "color";
	default: string;
}

/**
 * A color-grading wheel. Value is a hex color string; the wheel center
 * (#808080) is neutral, hue/saturation are picked by dragging the puck.
 */
export interface WheelEffectParamDefinition extends BaseEffectParamDefinition {
	type: "wheel";
	default: string;
}

/**
 * A `.cube` LUT slot. The stored value is a serialized LUT atlas string (see
 * `serializeLut` in `lib/color/cube-lut.ts`); the empty string means "no LUT
 * loaded". The UI renders a file picker + the loaded LUT's name.
 */
export interface LutEffectParamDefinition extends BaseEffectParamDefinition {
	type: "lut";
	default: string;
}

export type EffectParamDefinition =
	| NumberEffectParamDefinition
	| BooleanEffectParamDefinition
	| SelectEffectParamDefinition
	| ColorEffectParamDefinition
	| WheelEffectParamDefinition
	| LutEffectParamDefinition;

/**
 * An auxiliary texture bound alongside the pass input. The pass input is always
 * bound to `u_texture` at texture unit 0; auxiliary textures occupy units >= 1
 * (e.g. a 3D-LUT atlas). Keeps single-texture effects untouched.
 */
export interface WebGLPassTexture {
	/** Sampler2D uniform name in the fragment shader (e.g. "u_lut"). */
	uniform: string;
	/** Texture unit index; must be >= 1 (unit 0 is the pass input). */
	unit: number;
	/** Pixel source uploaded to the texture. */
	source: TexImageSource;
	/** Sampling filter (default "linear"). */
	filter?: "linear" | "nearest";
}

/** An extra sampler2D texture (e.g. a baked 3D LUT) an effect pass can bind. */
export interface EffectTextureUniformData {
	width: number;
	height: number;
	/** RGBA8 pixel data, row-major, top row first. */
	data: Uint8Array;
	/** Cache key so the renderer can reuse the uploaded GPU texture across frames instead of re-uploading every draw. Omit to skip caching. */
	cacheKey?: string;
}

export interface WebGLEffectPass {
	fragmentShader: string;
	uniforms(params: {
		effectParams: EffectParamValues;
		width: number;
		height: number;
	}): Record<string, number | number[]>;
	/**
	 * Optional auxiliary textures bound at units >= 1. Either an array of
	 * source-backed textures (e.g. the 2D LUT atlas) or a uniform-name-keyed map
	 * of raw RGBA8 data textures (e.g. the baked 3D LUT). Return `[]` / `{}` /
	 * `undefined` when the pass needs only its input texture.
	 */
	textures?(params: {
		effectParams: EffectParamValues;
		width: number;
		height: number;
	}): WebGLPassTexture[] | Record<string, EffectTextureUniformData>;
}

export interface WebGLEffectRenderer {
	type: "webgl";
	passes: WebGLEffectPass[];
}

export type EffectRenderer = WebGLEffectRenderer;

export interface EffectDefinition {
	type: string;
	name: string;
	keywords: string[];
	params: EffectParamDefinition[];
	renderer: EffectRenderer;
}

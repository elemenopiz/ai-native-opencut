// Adapted from OpenCut-app/opencut-classic (MIT). See THIRD_PARTY_NOTICES.
import type { EffectDefinition, EffectParamValues } from "@/types/effects";
import type { MaskShape, MaskShapeType } from "@/types/rendering";
import shapeMaskShader from "./shape-mask.frag.glsl";

const SHAPE_INDEX: Record<MaskShapeType, number> = {
	rectangle: 0,
	ellipse: 1,
	star: 2,
	"cinematic-bars": 3,
	split: 4,
	heart: 5,
	diamond: 6,
};

export const DEFAULT_MASK_SIZE = 0.8;
export const CINEMATIC_BARS_DEFAULT_WIDTH = 2;
export const CINEMATIC_BARS_DEFAULT_HEIGHT = 0.6;
export const MIN_MASK_DIMENSION = 0.01;
export const MAX_MASK_DIMENSION = 4;

export interface ResolvedMaskShape {
	type: MaskShapeType;
	feather: number;
	inverted: boolean;
	centerX: number;
	centerY: number;
	width: number;
	height: number;
	rotation: number;
}

export function getDefaultMaskShape({
	type,
}: {
	type: MaskShapeType;
}): MaskShape {
	const isBars = type === "cinematic-bars";
	return {
		type,
		feather: 0,
		inverted: false,
		centerX: 0,
		centerY: 0,
		width: isBars ? CINEMATIC_BARS_DEFAULT_WIDTH : DEFAULT_MASK_SIZE,
		height: isBars ? CINEMATIC_BARS_DEFAULT_HEIGHT : DEFAULT_MASK_SIZE,
		rotation: 0,
	};
}

export function resolveMaskShape({
	mask,
}: {
	mask: MaskShape;
}): ResolvedMaskShape {
	const type = mask.type in SHAPE_INDEX ? mask.type : "rectangle";
	return {
		type,
		feather: mask.feather ?? 0,
		inverted: mask.inverted ?? false,
		centerX: mask.centerX ?? 0,
		centerY: mask.centerY ?? 0,
		width: mask.width ?? DEFAULT_MASK_SIZE,
		height: mask.height ?? DEFAULT_MASK_SIZE,
		rotation: mask.rotation ?? 0,
	};
}

/** Maps an element-level MaskShape to the shape-mask effect's param values. */
export function maskShapeToEffectParams({
	mask,
}: {
	mask: MaskShape;
}): EffectParamValues {
	const resolved = resolveMaskShape({ mask });
	return {
		shape: resolved.type,
		centerX: resolved.centerX * 100,
		centerY: resolved.centerY * 100,
		width: resolved.width * 100,
		height: resolved.height * 100,
		rotation: resolved.rotation,
		feather: resolved.feather * 100,
		inverted: resolved.inverted,
	};
}

export const shapeMaskEffectDefinition: EffectDefinition = {
	type: "shape-mask",
	name: "Shape Mask",
	keywords: [
		"mask",
		"shape",
		"ellipse",
		"circle",
		"rectangle",
		"star",
		"cinematic",
		"bars",
		"letterbox",
		"feather",
		"crop",
		"split",
		"wipe",
		"reveal",
		"heart",
		"diamond",
	],
	params: [
		{
			key: "shape",
			label: "Shape",
			type: "select",
			default: "ellipse",
			options: [
				{ value: "rectangle", label: "Rectangle" },
				{ value: "ellipse", label: "Ellipse" },
				{ value: "star", label: "Star" },
				{ value: "cinematic-bars", label: "Cinematic Bars" },
				{ value: "split", label: "Split" },
				{ value: "heart", label: "Heart" },
				{ value: "diamond", label: "Diamond" },
			],
		},
		{
			key: "centerX",
			label: "Center X",
			type: "number",
			default: 0,
			min: -100,
			max: 100,
			step: 1,
		},
		{
			key: "centerY",
			label: "Center Y",
			type: "number",
			default: 0,
			min: -100,
			max: 100,
			step: 1,
		},
		{
			key: "width",
			label: "Width",
			type: "number",
			default: DEFAULT_MASK_SIZE * 100,
			min: MIN_MASK_DIMENSION * 100,
			max: MAX_MASK_DIMENSION * 100,
			step: 1,
		},
		{
			key: "height",
			label: "Height",
			type: "number",
			default: DEFAULT_MASK_SIZE * 100,
			min: MIN_MASK_DIMENSION * 100,
			max: MAX_MASK_DIMENSION * 100,
			step: 1,
		},
		{
			key: "rotation",
			label: "Rotation",
			type: "number",
			default: 0,
			min: -180,
			max: 180,
			step: 1,
		},
		{
			key: "feather",
			label: "Feather",
			type: "number",
			default: 0,
			min: 0,
			max: 100,
			step: 1,
		},
		{
			key: "inverted",
			label: "Invert",
			type: "boolean",
			default: false,
		},
	],
	renderer: {
		type: "webgl",
		passes: [
			{
				fragmentShader: shapeMaskShader,
				uniforms: ({ effectParams }) => {
					const shape =
						typeof effectParams.shape === "string" &&
						effectParams.shape in SHAPE_INDEX
							? SHAPE_INDEX[effectParams.shape as MaskShapeType]
							: SHAPE_INDEX.ellipse;
					const number = (value: unknown, fallback: number) =>
						typeof value === "number" ? value : fallback;
					return {
						u_shape: shape,
						u_center: [
							number(effectParams.centerX, 0) / 100,
							number(effectParams.centerY, 0) / 100,
						],
						u_size: [
							Math.max(number(effectParams.width, DEFAULT_MASK_SIZE * 100), MIN_MASK_DIMENSION * 100) / 100,
							Math.max(number(effectParams.height, DEFAULT_MASK_SIZE * 100), MIN_MASK_DIMENSION * 100) / 100,
						],
						u_rotation: (number(effectParams.rotation, 0) * Math.PI) / 180,
						u_feather: number(effectParams.feather, 0) / 100,
						u_inverted: effectParams.inverted === true ? 1 : 0,
					};
				},
			},
		],
	},
};

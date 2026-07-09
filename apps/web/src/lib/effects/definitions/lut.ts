import type { EffectDefinition, EffectParamValues } from "@/types/effects";
import { deserializeLut } from "@/lib/color/cube-lut";
import lutShader from "./lut.frag.glsl";

/**
 * The `.cube` LUT effect.
 *
 * Storage strategy (see `cube-lut.ts`): the LUT lives inline in the `lut` param
 * as a serialized-atlas **string**, so it survives project save/reload and
 * passes through keyframe param resolution untouched. Decoding that string into
 * an `ImageData` is synchronous, and the module-level `decodeCache` keeps the
 * decoded atlas so we don't re-decode on every rendered frame; it is keyed by
 * the exact serialized string, so editing/replacing the LUT naturally misses
 * the cache and re-decodes.
 */

interface DecodedLut {
	size: number;
	domainMin: [number, number, number];
	domainMax: [number, number, number];
	image: ImageData;
}

const decodeCache = new Map<string, DecodedLut | null>();

function getDecodedLut(serialized: string): DecodedLut | null {
	if (serialized.length === 0) return null;
	if (decodeCache.has(serialized)) {
		return decodeCache.get(serialized) ?? null;
	}
	let decoded: DecodedLut | null = null;
	try {
		const lut = deserializeLut({ serialized });
		const image = new ImageData(lut.pixels, lut.width, lut.height);
		decoded = {
			size: lut.size,
			domainMin: lut.domainMin,
			domainMax: lut.domainMax,
			image,
		};
	} catch {
		// Corrupt / unparseable param — treat as "no LUT" (shader passes through).
		decoded = null;
	}
	decodeCache.set(serialized, decoded);
	return decoded;
}

function getSerializedLut(effectParams: EffectParamValues): string {
	const value = effectParams.lut;
	return typeof value === "string" ? value : "";
}

function getIntensity(effectParams: EffectParamValues): number {
	const value = effectParams.intensity;
	return typeof value === "number" ? value : 1;
}

export const lutEffectDefinition: EffectDefinition = {
	type: "lut",
	name: "LUT (.cube)",
	keywords: [
		"lut",
		"cube",
		"color lookup",
		"lookup table",
		"grade",
		"grading",
		"film",
		"look",
		"davinci",
		"cinematic",
	],
	params: [
		{
			key: "lut",
			label: "LUT File",
			type: "lut",
			default: "",
		},
		{
			key: "intensity",
			label: "Intensity",
			type: "number",
			default: 1,
			min: 0,
			max: 1,
			step: 0.01,
		},
	],
	renderer: {
		type: "webgl",
		passes: [
			{
				fragmentShader: lutShader,
				uniforms: ({ effectParams }) => {
					const decoded = getDecodedLut(getSerializedLut(effectParams));
					if (!decoded) {
						return {
							u_lutSize: 0,
							u_intensity: getIntensity(effectParams),
							u_domainMin: [0, 0, 0],
							u_domainMax: [1, 1, 1],
						};
					}
					return {
						u_lutSize: decoded.size,
						u_intensity: getIntensity(effectParams),
						u_domainMin: decoded.domainMin,
						u_domainMax: decoded.domainMax,
					};
				},
				textures: ({ effectParams }) => {
					const decoded = getDecodedLut(getSerializedLut(effectParams));
					if (!decoded) return [];
					return [
						{
							uniform: "u_lut",
							unit: 1,
							source: decoded.image,
							filter: "linear",
						},
					];
				},
			},
		],
	},
};

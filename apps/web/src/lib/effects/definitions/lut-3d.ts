import type { EffectDefinition } from "@/types/effects";
import { DEFAULT_LUT_ID, getLutTiledTexture } from "../lut-registry";
import lutShader from "./lut-3d.frag.glsl";

/**
 * GPU 3D LUT effect. Parses `.cube` files (`lib/effects/lut-cube-parser.ts`),
 * bakes them into a tiled 2D texture (`lib/effects/lut-texture.ts`), and
 * samples them in the fragment shader with a manual trilinear lookup
 * (`lut-3d.frag.glsl`) — no `three`/`postprocessing` dependency needed.
 *
 * `lutId` is a "lut-select" param: the picker UI reads its options reactively
 * from the LUT registry (`subscribeLutRegistry`/`getLutPresetOptions`), so
 * built-in starter looks (`lut-builtins.ts`) and user `.cube` uploads
 * (`lut-upload.ts` → `registerLutFromCubeText`) show up without this
 * definition holding a static options snapshot. The `intensity` slider is a
 * plain "number" param the generic effect-param-field UI renders as a slider.
 */
export const lut3dEffectDefinition: EffectDefinition = {
	type: "lut-3d",
	name: "3D LUT",
	keywords: [
		"lut",
		"cube",
		"3d lut",
		"color grade",
		"look",
		"grading",
		"film emulation",
	],
	params: [
		{
			key: "lutId",
			label: "LUT",
			type: "lut-select",
			default: DEFAULT_LUT_ID,
		},
		{
			key: "intensity",
			label: "Intensity",
			type: "number",
			default: 100,
			min: 0,
			max: 100,
			step: 1,
		},
	],
	renderer: {
		type: "webgl",
		passes: [
			{
				fragmentShader: lutShader,
				uniforms: ({ effectParams }) => {
					const lutId =
						typeof effectParams.lutId === "string"
							? effectParams.lutId
							: DEFAULT_LUT_ID;
					const intensity =
						typeof effectParams.intensity === "number"
							? effectParams.intensity
							: 100;
					const tiled = getLutTiledTexture(lutId);
					return {
						u_intensity: intensity / 100,
						u_lutSize: tiled.size,
					};
				},
				textures: ({ effectParams }) => {
					const lutId =
						typeof effectParams.lutId === "string"
							? effectParams.lutId
							: DEFAULT_LUT_ID;
					const tiled = getLutTiledTexture(lutId);
					return {
						u_lut: {
							width: tiled.width,
							height: tiled.height,
							data: tiled.data,
							// Cached per LUT id so repeated frames reuse the uploaded GPU texture.
							cacheKey: `lut-3d:${lutId}`,
						},
					};
				},
			},
		],
	},
};

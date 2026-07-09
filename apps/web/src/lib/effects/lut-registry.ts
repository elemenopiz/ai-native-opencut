import { parseCubeLut, type Cube3DLut } from "./lut-cube-parser";
import { buildIdentityLut, buildTiledLutTexture, type TiledLutTexture } from "./lut-texture";

/**
 * In-memory registry of available 3D LUT presets, keyed by id. Each entry is
 * parsed + baked into a tiled GPU-ready texture once, then reused for every
 * frame that references it.
 *
 * WIRING TODO: nothing currently calls `registerLutFromCubeText`. A future
 * LUT file-picker UI should read the uploaded `.cube` file's text, call
 * `registerLutFromCubeText`, and then update the `lut-3d` effect's `lutId`
 * param options (see `definitions/lut-3d.ts`) — today those options are a
 * static snapshot taken at module load, since `EffectParamDefinition`
 * doesn't support dynamically-refreshed `select` options.
 */
interface LutPresetEntry {
	id: string;
	label: string;
	lut: Cube3DLut;
	tiled: TiledLutTexture;
}

const IDENTITY_ID = "identity";
const presets = new Map<string, LutPresetEntry>();

function register({ id, label, lut }: { id: string; label: string; lut: Cube3DLut }): void {
	presets.set(id, { id, label, lut, tiled: buildTiledLutTexture(lut) });
}

register({ id: IDENTITY_ID, label: "None", lut: buildIdentityLut() });

/** Parses `.cube` file text and registers it as a selectable LUT preset. */
export function registerLutFromCubeText({
	id,
	label,
	cubeText,
}: {
	id: string;
	label: string;
	cubeText: string;
}): void {
	const lut = parseCubeLut(cubeText);
	register({ id, label, lut });
}

/** Options for the `lut-3d` effect's `lutId` select param. */
export function getLutPresetOptions(): Array<{ value: string; label: string }> {
	return Array.from(presets.values(), (preset) => ({ value: preset.id, label: preset.label }));
}

/** Tiled GPU texture for a preset id, falling back to the identity LUT. */
export function getLutTiledTexture(id: string): TiledLutTexture {
	return presets.get(id)?.tiled ?? (presets.get(IDENTITY_ID) as LutPresetEntry).tiled;
}

export const DEFAULT_LUT_ID = IDENTITY_ID;

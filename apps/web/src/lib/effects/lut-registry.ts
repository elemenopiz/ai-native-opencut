import { parseCubeLut, type Cube3DLut } from "./lut-cube-parser";
import { generateBuiltinLutCubes } from "./lut-builtins";
import {
	buildIdentityLut,
	buildTiledLutTexture,
	type TiledLutTexture,
} from "./lut-texture";

/**
 * In-memory registry of available 3D LUT presets, keyed by id. Each entry is
 * parsed + baked into a tiled GPU-ready texture once, then reused for every
 * frame that references it.
 *
 * The registry is **reactive**: `subscribeLutRegistry` +
 * `getLutPresetOptions` form a `useSyncExternalStore`-compatible pair, so the
 * `lut-3d` effect's picker (see `effect-param-field.tsx`, param type
 * "lut-select") re-renders when a preset is registered. Presets come from
 * three places:
 *   - the built-in identity ("None") preset plus the programmatically
 *     generated starter looks (`lut-builtins.ts`), registered at module load;
 *   - user uploads via `importLutFile` (`lut-upload.ts`), which calls
 *     `registerLutFromCubeText` and persists the raw `.cube` text to
 *     IndexedDB;
 *   - `hydrateUserLutPresets` (`lut-upload.ts`), which re-registers persisted
 *     uploads on editor boot so saved projects keep rendering after reload.
 */
interface LutPresetEntry {
	id: string;
	label: string;
	lut: Cube3DLut;
	tiled: TiledLutTexture;
}

const IDENTITY_ID = "identity";
const presets = new Map<string, LutPresetEntry>();
const listeners = new Set<() => void>();

/**
 * Cached options array so `getLutPresetOptions` is referentially stable
 * between registrations — required by `useSyncExternalStore`.
 */
let optionsSnapshot: Array<{ value: string; label: string }> | null = null;

function register({
	id,
	label,
	lut,
}: {
	id: string;
	label: string;
	lut: Cube3DLut;
}): void {
	presets.set(id, { id, label, lut, tiled: buildTiledLutTexture(lut) });
	optionsSnapshot = null;
	for (const listener of listeners) listener();
}

register({ id: IDENTITY_ID, label: "None", lut: buildIdentityLut() });
for (const { id, label, cubeText } of generateBuiltinLutCubes()) {
	register({ id, label, lut: parseCubeLut(cubeText) });
}

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

/** Whether a preset id is currently registered. */
export function hasLutPreset(id: string): boolean {
	return presets.has(id);
}

/**
 * Subscribe to registry changes. Returns an unsubscribe function —
 * `useSyncExternalStore`-compatible.
 */
export function subscribeLutRegistry(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Options for the `lut-3d` effect's "lut-select" param (stable snapshot). */
export function getLutPresetOptions(): Array<{ value: string; label: string }> {
	if (optionsSnapshot === null) {
		optionsSnapshot = Array.from(presets.values(), (preset) => ({
			value: preset.id,
			label: preset.label,
		}));
	}
	return optionsSnapshot;
}

/** Tiled GPU texture for a preset id, falling back to the identity LUT. */
export function getLutTiledTexture(id: string): TiledLutTexture {
	return (
		presets.get(id)?.tiled ?? (presets.get(IDENTITY_ID) as LutPresetEntry).tiled
	);
}

export const DEFAULT_LUT_ID = IDENTITY_ID;

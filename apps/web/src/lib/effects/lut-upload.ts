import { storageService } from "@/services/storage/service";
import { generateUUID } from "@/utils/id";
import { hasLutPreset, registerLutFromCubeText } from "./lut-registry";

/**
 * User `.cube` LUT intake for the `lut-3d` effect: validate → parse/register
 * into the in-memory LUT registry → persist the raw text to IndexedDB so the
 * preset survives reload (mirroring how saved sounds persist app-wide).
 *
 * This module is the "LUT file-picker" wiring the registry's old TODO asked
 * for — `importLutFile` is called by the "lut-select" param field
 * (`effect-param-field.tsx`), and `hydrateUserLutPresets` is called once on
 * editor boot (`core/index.ts`) so saved projects that reference an uploaded
 * preset render correctly after a refresh.
 */

/**
 * Upload cap. Real-world `.cube` files are tiny (a 33^3 LUT is ~700 KB, a
 * 65^3 LUT ~6 MB); 32 MB comfortably covers every legitimate size the parser
 * accepts while rejecting absurd files before we read them into memory.
 */
export const MAX_CUBE_FILE_BYTES = 32 * 1024 * 1024;

/** Friendly validation error for a candidate LUT file, or null if it looks OK. */
export function validateCubeFile({
	name,
	size,
}: {
	name: string;
	size: number;
}): string | null {
	if (!/\.cube$/i.test(name)) {
		return "Only .cube LUT files are supported";
	}
	if (size === 0) {
		return "This .cube file is empty";
	}
	if (size > MAX_CUBE_FILE_BYTES) {
		return `LUT file is too large (max ${Math.round(MAX_CUBE_FILE_BYTES / (1024 * 1024))} MB)`;
	}
	return null;
}

/** Display label for an uploaded LUT — the file name without its extension. */
export function lutLabelFromFileName(fileName: string): string {
	const label = fileName.replace(/\.cube$/i, "").trim();
	return label.length > 0 ? label : "Imported LUT";
}

/**
 * Validates, registers, and persists an uploaded `.cube` file. Returns the new
 * preset's id (for the effect's `lutId` param) and display label.
 *
 * @throws {Error} with a user-facing message when the file is rejected or the
 * `.cube` text is malformed (the parser's errors are already friendly).
 */
export async function importLutFile({
	file,
}: {
	file: File;
}): Promise<{ id: string; label: string }> {
	const validationError = validateCubeFile({
		name: file.name,
		size: file.size,
	});
	if (validationError) {
		throw new Error(validationError);
	}

	const cubeText = await file.text();
	const id = `user-${generateUUID()}`;
	const label = lutLabelFromFileName(file.name);

	// Throws on malformed text — nothing is registered or persisted in that case.
	registerLutFromCubeText({ id, label, cubeText });

	try {
		await storageService.saveUserLut({
			lut: { id, label, cubeText, savedAt: new Date().toISOString() },
		});
	} catch (error) {
		// Persistence is best-effort: the preset still works for this session.
		console.error("Failed to persist uploaded LUT (session-only):", error);
	}

	return { id, label };
}

let hydrationPromise: Promise<void> | null = null;

/**
 * Re-registers every persisted user LUT into the in-memory registry. Runs once
 * per app load (idempotent); corrupt entries are skipped, never fatal.
 */
export function hydrateUserLutPresets(): Promise<void> {
	if (hydrationPromise) return hydrationPromise;
	hydrationPromise = (async () => {
		if (typeof indexedDB === "undefined") return;
		const savedLuts = await storageService.loadUserLuts();
		for (const savedLut of savedLuts) {
			if (hasLutPreset(savedLut.id)) continue;
			try {
				registerLutFromCubeText({
					id: savedLut.id,
					label: savedLut.label,
					cubeText: savedLut.cubeText,
				});
			} catch (error) {
				console.warn(`Skipping corrupt saved LUT "${savedLut.label}":`, error);
			}
		}
	})().catch((error) => {
		console.error("Failed to hydrate saved LUTs:", error);
	});
	return hydrationPromise;
}

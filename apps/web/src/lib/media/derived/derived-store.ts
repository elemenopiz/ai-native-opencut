/**
 * IndexedDB-backed store for this task's derived analyses (task B: persist
 * what is already computed) and their `DerivedStatus` readiness (task C).
 *
 * Own database (`byorn-derived-media`), following the same sibling-database
 * convention as `services/search/embedding-store.ts` /
 * `asset-understanding-store.ts` rather than folding this into the
 * versioned project-metadata (`MediaAssetData`) — these payloads are
 * derived, re-computable, and can be sizable (a beat grid's `beats` array
 * for a long musical track), so they don't belong in project version diffs.
 *
 * Four object stores, all keyed by `mediaId`:
 *   - `status`:   the full `AssetDerived` record (all 8 kinds, small)
 *   - `silence`:  `SilenceAnalysisRecord`
 *   - `loudness`: `LoudnessAnalysisRecord`
 *   - `beats`:    `BeatAnalysisRecord`
 *   - `visual`:   `VisualAnalysisRecord` (shots + motion energy + head/tail —
 *                 one record because they share one frame-sampling pass)
 */

import type { AssetDerived } from "./derived-status";
import type {
	BeatAnalysisRecord,
	LoudnessAnalysisRecord,
	SilenceAnalysisRecord,
	VisualAnalysisRecord,
} from "./derived-records";

const DB_NAME = "byorn-derived-media";
const DB_VERSION = 1;
const STATUS_STORE = "status";
const SILENCE_STORE = "silence";
const LOUDNESS_STORE = "loudness";
const BEATS_STORE = "beats";
const VISUAL_STORE = "visual";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
	if (dbPromise) return dbPromise;
	dbPromise = new Promise((resolve, reject) => {
		if (typeof indexedDB === "undefined") {
			reject(new Error("IndexedDB is not available in this environment"));
			return;
		}
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onerror = () => reject(req.error);
		req.onsuccess = () => resolve(req.result);
		req.onupgradeneeded = (event) => {
			const db = (event.target as IDBOpenDBRequest).result;
			for (const name of [
				STATUS_STORE,
				SILENCE_STORE,
				LOUDNESS_STORE,
				BEATS_STORE,
				VISUAL_STORE,
			]) {
				if (!db.objectStoreNames.contains(name)) {
					db.createObjectStore(name, { keyPath: "mediaId" });
				}
			}
		};
	});
	return dbPromise;
}

function tx<T>(
	storeName: string,
	mode: IDBTransactionMode,
	run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
	return openDB().then(
		(db) =>
			new Promise<T>((resolve, reject) => {
				const transaction = db.transaction(storeName, mode);
				const store = transaction.objectStore(storeName);
				const req = run(store);
				req.onerror = () => reject(req.error);
				req.onsuccess = () => resolve(req.result);
			}),
	);
}

// ── Status (task C) ─────────────────────────────────────────────────────────

export interface StoredDerivedStatus {
	mediaId: string;
	derived: AssetDerived;
}

export async function saveDerivedStatus(
	record: StoredDerivedStatus,
): Promise<void> {
	await tx(STATUS_STORE, "readwrite", (store) => store.put(record));
}

export async function getDerivedStatus(
	mediaId: string,
): Promise<StoredDerivedStatus | undefined> {
	return tx<StoredDerivedStatus | undefined>(
		STATUS_STORE,
		"readonly",
		(store) => store.get(mediaId),
	);
}

export async function deleteDerivedStatus(mediaId: string): Promise<void> {
	await tx(STATUS_STORE, "readwrite", (store) => store.delete(mediaId));
}

// ── Silence ──────────────────────────────────────────────────────────────────

export async function saveSilenceAnalysis(
	record: SilenceAnalysisRecord,
): Promise<void> {
	await tx(SILENCE_STORE, "readwrite", (store) => store.put(record));
}

export async function getSilenceAnalysis(
	mediaId: string,
): Promise<SilenceAnalysisRecord | undefined> {
	return tx<SilenceAnalysisRecord | undefined>(
		SILENCE_STORE,
		"readonly",
		(store) => store.get(mediaId),
	);
}

// ── Loudness ─────────────────────────────────────────────────────────────────

export async function saveLoudnessAnalysis(
	record: LoudnessAnalysisRecord,
): Promise<void> {
	await tx(LOUDNESS_STORE, "readwrite", (store) => store.put(record));
}

export async function getLoudnessAnalysis(
	mediaId: string,
): Promise<LoudnessAnalysisRecord | undefined> {
	return tx<LoudnessAnalysisRecord | undefined>(
		LOUDNESS_STORE,
		"readonly",
		(store) => store.get(mediaId),
	);
}

// ── Beats ────────────────────────────────────────────────────────────────────

export async function saveBeatAnalysis(
	record: BeatAnalysisRecord,
): Promise<void> {
	await tx(BEATS_STORE, "readwrite", (store) => store.put(record));
}

export async function getBeatAnalysis(
	mediaId: string,
): Promise<BeatAnalysisRecord | undefined> {
	return tx<BeatAnalysisRecord | undefined>(BEATS_STORE, "readonly", (store) =>
		store.get(mediaId),
	);
}

// ── Visual (shots + motion energy + head/tail) ───────────────────────────────

export async function saveVisualAnalysis(
	record: VisualAnalysisRecord,
): Promise<void> {
	await tx(VISUAL_STORE, "readwrite", (store) => store.put(record));
}

export async function getVisualAnalysis(
	mediaId: string,
): Promise<VisualAnalysisRecord | undefined> {
	return tx<VisualAnalysisRecord | undefined>(
		VISUAL_STORE,
		"readonly",
		(store) => store.get(mediaId),
	);
}

// ── Bulk cleanup (asset delete / clear-all) ──────────────────────────────────

/** Drop every derived record for one media asset (call on media delete). */
export async function deleteDerivedMedia(mediaId: string): Promise<void> {
	await Promise.all([
		tx(STATUS_STORE, "readwrite", (store) => store.delete(mediaId)),
		tx(SILENCE_STORE, "readwrite", (store) => store.delete(mediaId)),
		tx(LOUDNESS_STORE, "readwrite", (store) => store.delete(mediaId)),
		tx(BEATS_STORE, "readwrite", (store) => store.delete(mediaId)),
		tx(VISUAL_STORE, "readwrite", (store) => store.delete(mediaId)),
	]);
}

/** Drop every derived record for every asset (Settings → Clear Indexed Data, mirroring `clearAllEmbeddings`). */
export async function clearAllDerivedMedia(): Promise<void> {
	await Promise.all(
		[
			STATUS_STORE,
			SILENCE_STORE,
			LOUDNESS_STORE,
			BEATS_STORE,
			VISUAL_STORE,
		].map((name) => tx(name, "readwrite", (store) => store.clear())),
	);
}

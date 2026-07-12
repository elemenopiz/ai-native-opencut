/**
 * IndexedDB-backed store for {@link AssetTranscript} records.
 *
 * A SIBLING to the understanding store (`asset-understanding-store.ts`):
 * transcripts are a separate ingest layer (speech, from the audio track) than
 * visual understanding (caption/role/faces, from sampled frames), so they live
 * in their own database (`byorn-asset-transcripts`) — independently clearable,
 * no schema entanglement. Records are local-only, like embeddings: the audio
 * never leaves the device on the local Whisper path, and the transcript
 * doesn't either.
 */

import type { AssetTranscript } from "@/lib/search/asset-transcript";

const DB_NAME = "byorn-asset-transcripts";
const DB_VERSION = 1;
const STORE = "transcripts";

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
			if (!db.objectStoreNames.contains(STORE)) {
				const store = db.createObjectStore(STORE, { keyPath: "mediaId" });
				store.createIndex("createdAt", "createdAt");
			}
		};
	});
	return dbPromise;
}

function tx<T>(
	mode: IDBTransactionMode,
	run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
	return openDB().then(
		(db) =>
			new Promise<T>((resolve, reject) => {
				const transaction = db.transaction(STORE, mode);
				const store = transaction.objectStore(STORE);
				const req = run(store);
				req.onerror = () => reject(req.error);
				req.onsuccess = () => resolve(req.result);
			}),
	);
}

/** Persist (or replace) the transcript record for a media asset. */
export async function saveTranscript(record: AssetTranscript): Promise<void> {
	await tx("readwrite", (store) => store.put(record));
}

/** Fetch the transcript record for a media asset, if any. */
export async function getTranscript(
	mediaId: string,
): Promise<AssetTranscript | undefined> {
	return tx<AssetTranscript | undefined>("readonly", (store) =>
		store.get(mediaId),
	);
}

/** Fetch every transcript record (cache priming on Director mount). */
export async function getAllTranscripts(): Promise<AssetTranscript[]> {
	return tx<AssetTranscript[]>("readonly", (store) => store.getAll());
}

/** Drop the transcript record for one media asset (called on media delete). */
export async function deleteTranscript(mediaId: string): Promise<void> {
	await tx("readwrite", (store) => store.delete(mediaId));
}

/** Drop every transcript record (Settings → Clear Indexed Data). */
export async function clearAllTranscripts(): Promise<void> {
	await tx("readwrite", (store) => store.clear());
}

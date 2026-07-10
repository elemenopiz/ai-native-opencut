/**
 * IndexedDB-backed store for {@link AssetUnderstanding} records.
 *
 * A SIBLING to the CLIP embedding store (`embedding-store.ts`): understanding is
 * a separate, higher-level layer (caption / role / faces / style) than the raw
 * frame vectors, so it lives in its own database (`byorn-asset-understanding`) —
 * no version bump or schema entanglement with the embeddings DB, and it can be
 * cleared independently. Records are local-only, like embeddings.
 *
 * Beyond plain CRUD, this store owns the role BELIEF update paths:
 *  - {@link confirmRole} — a cheap human override (`roleConfirmed`) that WINS over
 *    the inferred role forever after.
 *  - {@link reinforceRole} — the usage-signal path (e.g. the Director dropped this
 *    asset into a hero slot): folds a {@link RoleSignal} into the belief via the
 *    pure {@link applyRoleSignal}. The rule is real and tested; the CALLER that
 *    emits these signals is the documented stub (see the service).
 */

import {
	type AssetRole,
	type AssetUnderstanding,
	applyRoleSignal,
	type RoleSignal,
} from "@/lib/search/asset-understanding";

const DB_NAME = "byorn-asset-understanding";
const DB_VERSION = 1;
const STORE = "understanding";

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

/** Persist (or replace) the understanding record for a media asset. */
export async function saveUnderstanding(
	record: AssetUnderstanding,
): Promise<void> {
	await tx("readwrite", (store) => store.put(record));
}

/** Fetch the understanding record for a media asset, if any. */
export async function getUnderstanding(
	mediaId: string,
): Promise<AssetUnderstanding | undefined> {
	return tx<AssetUnderstanding | undefined>("readonly", (store) =>
		store.get(mediaId),
	);
}

/** Fetch every understanding record (used by the Asset Manifest / Project Bible). */
export async function getAllUnderstandings(): Promise<AssetUnderstanding[]> {
	return tx<AssetUnderstanding[]>("readonly", (store) => store.getAll());
}

/** Drop the understanding record for one media asset (called on media delete). */
export async function deleteUnderstanding(mediaId: string): Promise<void> {
	await tx("readwrite", (store) => store.delete(mediaId));
}

/** Drop every understanding record (Settings → Clear Indexed Data). */
export async function clearAllUnderstandings(): Promise<void> {
	await tx("readwrite", (store) => store.clear());
}

/** List mediaIds that already have an understanding record. */
export async function listUnderstoodMediaIds(): Promise<string[]> {
	return tx<IDBValidKey[]>("readonly", (store) => store.getAllKeys()).then(
		(keys) => keys as string[],
	);
}

/**
 * Human confirmation: set `roleConfirmed`, the override that WINS over the
 * inferred role from here on (and freezes it against usage signals). No-op when
 * there's no record yet. Returns the updated record, or undefined if none.
 */
export async function confirmRole(
	mediaId: string,
	role: AssetRole,
): Promise<AssetUnderstanding | undefined> {
	const record = await getUnderstanding(mediaId);
	if (!record) return undefined;
	const next: AssetUnderstanding = { ...record, roleConfirmed: role };
	await saveUnderstanding(next);
	return next;
}

/** Clear a human confirmation, handing the effective role back to the inferred belief. */
export async function clearRoleConfirmation(
	mediaId: string,
): Promise<AssetUnderstanding | undefined> {
	const record = await getUnderstanding(mediaId);
	if (!record) return undefined;
	const { roleConfirmed: _dropped, ...rest } = record;
	const next = rest as AssetUnderstanding;
	await saveUnderstanding(next);
	return next;
}

/**
 * Usage-signal role update: fold a {@link RoleSignal} into the stored belief via
 * the pure {@link applyRoleSignal} and persist it. This is how the role updates
 * BY USAGE — e.g. the Director promoting an asset into a hero slot is a strong
 * `hero` signal.
 *
 * STUB BOUNDARY: the update RULE (here + `applyRoleSignal`) is real and tested.
 * What is not yet wired is the EMITTER — the Director/timeline code that calls
 * this when it actually uses an asset. Wiring an emitter is a follow-up; the seam
 * is intentionally this one function so that wiring is a one-line call site.
 * No-op when there's no record yet. Returns the updated record, or undefined.
 */
export async function reinforceRole(
	mediaId: string,
	signal: RoleSignal,
): Promise<AssetUnderstanding | undefined> {
	const record = await getUnderstanding(mediaId);
	if (!record) return undefined;
	const next = applyRoleSignal(record, signal);
	if (next === record) return record; // override in place, or zero-weight — nothing to persist.
	await saveUnderstanding(next);
	return next;
}

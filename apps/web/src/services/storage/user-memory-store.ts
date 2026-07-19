/**
 * Local-first user-memory store — the persistence for Flow E's cross-project
 * memory. GLOBAL (NOT per project): a sibling to the saved-sounds store, keyed by
 * nothing but "the user of this machine". Nothing here leaves the device.
 *
 * One IndexedDB database (`byorn-user-memory`) with two object stores:
 *  - `kv` — a small-blob store holding the {@link UserMemory} root (the distilled
 *    {@link UserBibleDefaults}), the Bet-3 behavioral preference-event log, and its
 *    distilled {@link UserPreferenceModel} — one key each, same "one JSON value per
 *    key" shape as the saved-sounds store.
 *  - `media` — a keyed store of {@link UserMediaMemoryEntry} rows (keyPath
 *    `contentHash`), so re-importing the same library media in a new project can
 *    reuse its understanding instead of paying for the pass again.
 *
 * MIGRATION SAFETY / ABSENCE: every read fails soft to "nothing yet" and every
 * write is best-effort. When IndexedDB is unavailable (SSR, tests, private mode),
 * reads resolve to `undefined`/`[]` and writes no-op — so the absence of this
 * layer is a valid state everywhere and never breaks the caller.
 *
 * The pure promotion/seeding rules live in `lib/director/cross-project-memory.ts`;
 * the pure behavioral-distill rules live in `lib/director/preference-learning.ts`.
 * This module is the async glue that reads current state, applies those rules, and
 * persists the result — for both.
 */

import {
	promoteBibleToUserDefaults,
	seedBibleFromUserDefaults,
} from "@/lib/director/cross-project-memory";
import type {
	PreferenceEvent,
	UserPreferenceModel,
} from "@/lib/director/preference-learning";
import type { AssetUnderstanding } from "@/lib/search/asset-understanding";
import type { ProjectBible } from "@/types/project";
import {
	USER_MEMORY_SCHEMA_VERSION,
	type UserBibleDefaults,
	type UserMediaMemoryEntry,
	type UserMemory,
} from "@/types/user-memory";

const DB_NAME = "byorn-user-memory";
const DB_VERSION = 1;
const KV_STORE = "kv";
const MEDIA_STORE = "media";
/** The single key under which the {@link UserMemory} root blob lives in `kv`. */
const ROOT_KEY = "root";
/** The key under which the Bet-3 preference-event log lives in `kv`. */
const PREFERENCE_EVENTS_KEY = "preferenceEvents";
/** The key under which the distilled Bet-3 {@link UserPreferenceModel} lives in `kv`. */
const PREFERENCE_MODEL_KEY = "preferenceModel";
/** Cap on the reusable-media library so it never grows without bound (oldest evicted). */
export const MAX_USER_MEDIA_MEMORY = 500;

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
			if (!db.objectStoreNames.contains(KV_STORE)) {
				db.createObjectStore(KV_STORE);
			}
			if (!db.objectStoreNames.contains(MEDIA_STORE)) {
				const store = db.createObjectStore(MEDIA_STORE, {
					keyPath: "contentHash",
				});
				store.createIndex("updatedAt", "updatedAt");
			}
		};
	});
	return dbPromise;
}

function tx<T>(
	store: string,
	mode: IDBTransactionMode,
	run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
	return openDB().then(
		(db) =>
			new Promise<T>((resolve, reject) => {
				const transaction = db.transaction(store, mode);
				const objectStore = transaction.objectStore(store);
				const req = run(objectStore);
				req.onerror = () => reject(req.error);
				req.onsuccess = () => resolve(req.result);
			}),
	);
}

// ── the UserMemory root (bible defaults) ─────────────────────────────────────

/** A fresh, empty user-memory root. */
function emptyUserMemory(now = Date.now()): UserMemory {
	return { schemaVersion: USER_MEMORY_SCHEMA_VERSION, updatedAt: now };
}

/**
 * Read the user-memory root, or `undefined` when there is none / storage is
 * unavailable. Never throws — absence is a valid state.
 */
export async function getUserMemory(): Promise<UserMemory | undefined> {
	try {
		const value = await tx<UserMemory | undefined>(
			KV_STORE,
			"readonly",
			(store) => store.get(ROOT_KEY),
		);
		return value ?? undefined;
	} catch {
		return undefined;
	}
}

/** The distilled cross-project creative defaults, if any. Never throws. */
export async function getUserBibleDefaults(): Promise<
	UserBibleDefaults | undefined
> {
	return (await getUserMemory())?.bibleDefaults;
}

/** Persist the user-memory root (best-effort; no-op when storage is unavailable). */
async function putUserMemory(memory: UserMemory): Promise<void> {
	try {
		await tx(KV_STORE, "readwrite", (store) => store.put(memory, ROOT_KEY));
	} catch {
		// Best-effort: a persistence hiccup must never break the verb that triggered it.
	}
}

/** Replace just the bible defaults on the root, stamping `updatedAt`. Best-effort. */
export async function saveUserBibleDefaults(
	defaults: UserBibleDefaults,
	now: number = Date.now(),
): Promise<void> {
	const current = (await getUserMemory()) ?? emptyUserMemory(now);
	await putUserMemory({
		...current,
		schemaVersion: USER_MEMORY_SCHEMA_VERSION,
		bibleDefaults: defaults,
		updatedAt: now,
	});
}

/** Clear only the distilled bible defaults, leaving the media library intact. Best-effort. */
export async function clearUserBibleDefaults(
	now: number = Date.now(),
): Promise<void> {
	const current = await getUserMemory();
	if (!current) return;
	const { bibleDefaults: _dropped, ...rest } = current;
	await putUserMemory({ ...rest, updatedAt: now });
}

// ── promotion / seeding glue (the pure rules + persistence) ──────────────────

/**
 * Distill a project's {@link ProjectBible} into the user defaults and persist the
 * result (best-effort). No-op when the bible adds nothing new (the pure rule
 * returns the prior defaults unchanged) or when storage is unavailable. Called on
 * project close/save. Returns the promoted defaults for callers/tests.
 */
export async function promoteBibleToUserMemory(
	bible: ProjectBible | undefined,
	now: number = Date.now(),
): Promise<UserBibleDefaults | undefined> {
	const prev = await getUserBibleDefaults();
	const next = promoteBibleToUserDefaults(prev, bible, now);
	if (next && next !== prev) {
		await saveUserBibleDefaults(next, now);
	}
	return next;
}

/**
 * Build a fresh, seeded {@link ProjectBible} from the current user defaults, or
 * `undefined` when there is nothing to seed (defaults empty/absent, or storage
 * unavailable). Called when a new project is created. Non-destructive and clearly
 * overridable — see `seedBibleFromUserDefaults`.
 */
export async function seedProjectBibleFromUserMemory(
	now: number = Date.now(),
): Promise<ProjectBible | undefined> {
	const defaults = await getUserBibleDefaults();
	return seedBibleFromUserDefaults(defaults, now);
}

// ── Bet-3 preference-event log + distilled model (behavioral memory) ─────────

/**
 * Read the raw preference-event log, or `[]` when there is none / storage is
 * unavailable. Never throws — absence is a valid state (mirrors every other
 * read in this module).
 */
export async function getPreferenceEventLog(): Promise<PreferenceEvent[]> {
	try {
		const value = await tx<PreferenceEvent[] | undefined>(
			KV_STORE,
			"readonly",
			(store) => store.get(PREFERENCE_EVENTS_KEY),
		);
		return value ?? [];
	} catch {
		return [];
	}
}

/**
 * Persist the (already capped) preference-event log verbatim. Best-effort;
 * no-op when storage is unavailable. Callers should cap the log themselves
 * (see `appendPreferenceEvent` in `lib/director/preference-learning.ts`) —
 * this function does not re-cap.
 */
export async function savePreferenceEventLog(
	events: PreferenceEvent[],
): Promise<void> {
	try {
		await tx(KV_STORE, "readwrite", (store) =>
			store.put(events, PREFERENCE_EVENTS_KEY),
		);
	} catch {
		// Best-effort: a persistence hiccup must never break the verb that triggered it.
	}
}

/**
 * Read the distilled {@link UserPreferenceModel}, or `undefined` when none has
 * been distilled yet / storage is unavailable. Never throws.
 */
export async function getUserPreferenceModel(): Promise<
	UserPreferenceModel | undefined
> {
	try {
		const value = await tx<UserPreferenceModel | undefined>(
			KV_STORE,
			"readonly",
			(store) => store.get(PREFERENCE_MODEL_KEY),
		);
		return value ?? undefined;
	} catch {
		return undefined;
	}
}

/** Persist the distilled preference model. Best-effort; no-op when storage is unavailable. */
export async function saveUserPreferenceModel(
	model: UserPreferenceModel,
): Promise<void> {
	try {
		await tx(KV_STORE, "readwrite", (store) =>
			store.put(model, PREFERENCE_MODEL_KEY),
		);
	} catch {
		// Best-effort.
	}
}

/** Drop the preference-event log and its distilled model. Best-effort. */
export async function clearPreferenceMemory(): Promise<void> {
	try {
		await tx(KV_STORE, "readwrite", (store) =>
			store.delete(PREFERENCE_EVENTS_KEY),
		);
	} catch {
		// Best-effort.
	}
	try {
		await tx(KV_STORE, "readwrite", (store) =>
			store.delete(PREFERENCE_MODEL_KEY),
		);
	} catch {
		// Best-effort.
	}
}

// ── reusable-media understanding library (keyed by content identity) ─────────

/**
 * Look up a cached understanding for a piece of media by its stable content
 * identity (see `lib/search/media-identity.ts`). `undefined` when unseen / storage
 * unavailable. Never throws.
 */
export async function getUserMediaMemory(
	contentHash: string,
): Promise<UserMediaMemoryEntry | undefined> {
	try {
		const value = await tx<UserMediaMemoryEntry | undefined>(
			MEDIA_STORE,
			"readonly",
			(store) => store.get(contentHash),
		);
		return value ?? undefined;
	} catch {
		return undefined;
	}
}

/**
 * Cache an understanding for a piece of media under its content identity, so a
 * future project that references the same media reuses it. Best-effort; evicts the
 * oldest entries past {@link MAX_USER_MEDIA_MEMORY}. The stored understanding's
 * `mediaId` is left as-is — consumers RE-KEY it to the new asset before use.
 */
export async function saveUserMediaMemory(
	contentHash: string,
	understanding: AssetUnderstanding,
	opts: { name?: string; now?: number } = {},
): Promise<void> {
	const now = opts.now ?? Date.now();
	const entry: UserMediaMemoryEntry = {
		contentHash,
		understanding,
		...(opts.name ? { name: opts.name } : {}),
		updatedAt: now,
	};
	try {
		await tx(MEDIA_STORE, "readwrite", (store) => store.put(entry));
		await evictOldestMediaMemory();
	} catch {
		// Best-effort.
	}
}

/** Evict the oldest reusable-media entries once the library exceeds its cap. */
async function evictOldestMediaMemory(): Promise<void> {
	try {
		const all = await getAllUserMediaMemory();
		if (all.length <= MAX_USER_MEDIA_MEMORY) return;
		const sorted = [...all].sort((a, b) => a.updatedAt - b.updatedAt);
		const toDrop = sorted.slice(0, all.length - MAX_USER_MEDIA_MEMORY);
		await Promise.all(
			toDrop.map((entry) =>
				tx(MEDIA_STORE, "readwrite", (store) =>
					store.delete(entry.contentHash),
				).catch(() => undefined),
			),
		);
	} catch {
		// Best-effort — a full library that isn't trimmed is harmless.
	}
}

/** Every cached reusable-media entry (consent UI listing / manifest reuse). Never throws. */
export async function getAllUserMediaMemory(): Promise<UserMediaMemoryEntry[]> {
	try {
		return await tx<UserMediaMemoryEntry[]>(MEDIA_STORE, "readonly", (store) =>
			store.getAll(),
		);
	} catch {
		return [];
	}
}

/** Drop every cached reusable-media entry. Best-effort. */
export async function clearUserMediaMemory(): Promise<void> {
	try {
		await tx(MEDIA_STORE, "readwrite", (store) => store.clear());
	} catch {
		// Best-effort.
	}
}

// ── consent / control ────────────────────────────────────────────────────────

/** A compact, human-facing summary of what the machine remembers across projects. */
export interface UserMemorySummary {
	hasBibleDefaults: boolean;
	/** Number of reusable-media understanding records cached. */
	mediaCount: number;
	/** Epoch ms of the last write to the bible defaults, when present. */
	bibleUpdatedAt?: number;
}

/** Read a summary of the cross-project memory for the consent/control surface. Never throws. */
export async function getUserMemorySummary(): Promise<UserMemorySummary> {
	const [defaults, media] = await Promise.all([
		getUserBibleDefaults(),
		getAllUserMediaMemory(),
	]);
	return {
		hasBibleDefaults: !!defaults,
		mediaCount: media.length,
		...(defaults?.updatedAt ? { bibleUpdatedAt: defaults.updatedAt } : {}),
	};
}

/**
 * Wipe ALL cross-project memory — bible defaults, the reusable-media library,
 * and the Bet-3 behavioral preference log + distilled model. Best-effort.
 */
export async function clearAllUserMemory(): Promise<void> {
	try {
		await tx(KV_STORE, "readwrite", (store) => store.delete(ROOT_KEY));
	} catch {
		// Best-effort.
	}
	await clearUserMediaMemory();
	await clearPreferenceMemory();
}

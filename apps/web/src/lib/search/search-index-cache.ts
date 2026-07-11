/**
 * React-free cache of the visual-search embedding index.
 *
 * `use-visual-search` keeps ranked search synchronous by holding every
 * current-model vector in memory; this module owns that cache plus the
 * staleness signal that decides when to re-read IndexedDB. Extracted from the
 * hook so the drift logic is testable in bun (no React renderer available).
 *
 * Why the digest is over STATUSES, not the record count: the migration
 * re-index rewrites retired-model records IN PLACE (`saveEmbedding` is a keyed
 * put), so completing a re-index never changes the store count — a count-based
 * drift check misses it and the cache would serve stale (empty) results until
 * remount. Every completion DOES write an "indexed" status with a fresh
 * `createdAt`, so a digest over terminal statuses catches first indexes,
 * re-indexes, and deletions alike.
 */

import { embeddings, filterToCurrentModel } from "@/lib/local-ai/embeddings";
import type {
	EmbeddingStatus,
	MediaEmbedding,
} from "@/lib/search/embedding-types";
import {
	getAllEmbeddings,
	getAllStatuses,
} from "@/services/search/embedding-store";

/**
 * Order-independent digest of terminal "indexed" statuses — changes exactly
 * when the set of searchable vectors changes (asset indexed, re-indexed into
 * the current space, or deleted). Deliberately ignores in-flight "indexing"
 * progress rows: they mutate on every embed batch, and reacting to them would
 * force a full vector re-read per keystroke while a background pass runs.
 */
export function indexDigest(statuses: EmbeddingStatus[]): string {
	return (
		statuses
			.filter((s) => s.state === "indexed")
			// frameCount hardens the tuple against same-millisecond rewrites where
			// only the sampled-frame set changed (e.g. trimmed media re-indexed).
			.map((s) => `${s.mediaId}:${s.createdAt}:${s.frameCount}`)
			.sort()
			.join("|")
	);
}

export interface SearchIndexSnapshot {
	/** Current-model embedding records only (stale vector spaces filtered). */
	records: MediaEmbedding[];
	/** All per-asset statuses, for the hook's in-flight indexing UI. */
	statuses: EmbeddingStatus[];
}

export function createSearchIndexCache() {
	let records: MediaEmbedding[] = [];
	// null = never loaded, so the first isStale() always reports stale.
	let digest: string | null = null;

	return {
		/** The cached current-model records (empty until the first refresh). */
		get records(): MediaEmbedding[] {
			return records;
		},

		/** Re-read vectors + statuses from IndexedDB and recompute the digest. */
		async refresh(): Promise<SearchIndexSnapshot> {
			const [all, statuses] = await Promise.all([
				getAllEmbeddings(),
				getAllStatuses(),
			]);
			// Records from a retired vector space (pre-migration "ViT-B-32") rank
			// meaninglessly against current-model query vectors — hide them until
			// the background re-index rewrites them.
			records = filterToCurrentModel(all);
			digest = indexDigest(statuses);
			return { records, statuses };
		},

		/**
		 * Cheap pre-search check: has the searchable set changed since the last
		 * refresh? Reads only the tiny status store — never the vectors.
		 */
		async isStale(): Promise<boolean> {
			if (digest === null) return true;
			return digest !== indexDigest(await getAllStatuses());
		},

		/** Provenance tag the cache filters on (exposed for assertions/debug). */
		get modelName(): string {
			return embeddings.modelName;
		},
	};
}

export type SearchIndexCache = ReturnType<typeof createSearchIndexCache>;

/**
 * Should the hook keep polling the index after this refresh?
 *
 * The search-time isStale() check only runs when a search fires, but the
 * Visual Search panel DISABLES its input while nothing is searchable — so a
 * background pass (first index or migration re-index) would finish silently
 * and the panel would stay dead until remount. Poll while the window is open:
 * a pass is in flight (indexing/pending rows), or nothing is searchable yet
 * despite indexable assets existing (covers the gap before the auto-indexer's
 * first status write lands, ~500ms after mount). Each poll tick is a tiny
 * status-store read gated by isStale(); vectors are only re-read on change.
 */
export function shouldPollForIndex(
	snapshot: SearchIndexSnapshot,
	hasIndexableAssets: boolean,
): boolean {
	const inflight = snapshot.statuses.some(
		(s) => s.state === "indexing" || s.state === "pending",
	);
	return inflight || (snapshot.records.length === 0 && hasIndexableAssets);
}

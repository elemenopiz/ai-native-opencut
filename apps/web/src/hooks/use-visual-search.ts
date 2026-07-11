/**
 * Visual / semantic media search.
 *
 * Loads all CLIP embeddings from IndexedDB, embeds the user's natural-language
 * query through the in-browser embedding seam, then ranks frames by cosine
 * similarity — entirely on-device, end to end. Neither the query text nor any
 * media data ever leaves the user's machine.
 *
 * Debounced (300ms) like `useSoundSearch`. Returns ranked SearchHit[].
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useEditor } from "@/hooks/use-editor";
import { embeddings } from "@/lib/local-ai/embeddings";
import { createSearchIndexCache } from "@/lib/search/search-index-cache";
import type { SearchHit } from "@/lib/search/embedding-types";

export interface VisualSearchState {
	hits: SearchHit[];
	isSearching: boolean;
	error: string | null;
	indexedCount: number;
	/** Assets currently being indexed (mediaId → phase). */
	indexing: Record<string, { phase: string; progress: number }>;
	/** True if at least one media asset has been indexed. */
	hasIndex: boolean;
}

const DEBOUNCE_MS = 300;
const MIN_QUERY_LEN = 2;

/**
 * Cosine similarity for two L2-normalized Float32Arrays == dot product.
 * Vectors from CLIP are already normalized on the backend, so this is a
 * tight inner-product loop — fast enough to run across thousands of frames
 * synchronously without dropping a frame.
 */
function dotProduct(a: Float32Array, b: Float32Array): number {
	let sum = 0;
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) sum += a[i] * b[i];
	return sum;
}

export function useVisualSearch() {
	const editor = useEditor();
	const [hits, setHits] = useState<SearchHit[]>([]);
	const [isSearching, setIsSearching] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [indexedCount, setIndexedCount] = useState(0);
	const [indexing, setIndexing] = useState<
		Record<string, { phase: string; progress: number }>
	>({});
	const [hasIndex, setHasIndex] = useState(false);
	// React-free vector cache + staleness signal (see search-index-cache.ts for
	// why staleness keys off indexed STATUSES, not the store count — the
	// migration re-index rewrites records in place without changing the count).
	const [cache] = useState(createSearchIndexCache);
	const lastQueryRef = useRef<string>("");
	// Monotonic token so a slower search/findSimilar response can't overwrite the
	// results of a newer one issued after it.
	const searchSeqRef = useRef(0);

	/** Refresh the cached embedding index from IndexedDB. */
	const refreshIndex = useCallback(async () => {
		const { records, statuses } = await cache.refresh();
		// Count searchable (current-model) records only, matching what hits can
		// actually surface — stale-space records awaiting re-index don't count.
		setIndexedCount(records.length);
		setHasIndex(records.length > 0);
		const inflight: Record<string, { phase: string; progress: number }> = {};
		for (const s of statuses) {
			if (s.state === "indexing") {
				inflight[s.mediaId] = { phase: s.phase, progress: s.progress };
			}
		}
		setIndexing(inflight);
	}, [cache]);

	/** Run a search query against the cached embedding index. */
	const search = useCallback(
		async (query: string, opts?: { limit?: number; threshold?: number }) => {
			const seq = ++searchSeqRef.current;
			const trimmed = query.trim();
			if (trimmed.length < MIN_QUERY_LEN) {
				setHits([]);
				setError(null);
				lastQueryRef.current = "";
				return;
			}

			setIsSearching(true);
			setError(null);
			try {
				// Pick up assets indexed (or migration re-indexed) since the last
				// refresh. isStale reads only the tiny status store — vectors are
				// re-read solely when the searchable set actually changed.
				if (await cache.isStale()) {
					await refreshIndex();
				}
				// Embed the query in-browser through the seam; vectors come back
				// L2-normalized, so dotProduct below is still cosine similarity.
				const [queryVec] = await embeddings.embedTexts([trimmed]);

				const limit = opts?.limit ?? 30;
				// 0.18 was tuned against the retired server backend (laion2b
				// ViT-B-32); pending empirical retune for clip-vit-b32-web (Task 5).
				const threshold = opts?.threshold ?? 0.18;
				const assets = editor.media.getAssets();
				const byId = new Map(assets.map((a) => [a.id, a]));

				const candidates: SearchHit[] = [];
				for (const media of cache.records) {
					const asset = byId.get(media.mediaId);
					if (!asset) continue;
					let bestScore = -Infinity;
					let bestTs = 0;
					for (const frame of media.frames) {
						const score = dotProduct(queryVec, frame.vector);
						if (score > bestScore) {
							bestScore = score;
							bestTs = frame.timestampSec;
						}
					}
					if (bestScore >= threshold) {
						candidates.push({
							mediaId: media.mediaId,
							timestampSec: bestTs,
							score: bestScore,
							mediaName: asset.name,
							mediaType: asset.type,
							thumbnailUrl: asset.thumbnailUrl,
						});
					}
				}
				candidates.sort((a, b) => b.score - a.score);
				if (seq !== searchSeqRef.current) return; // superseded by a newer search
				setHits(candidates.slice(0, limit));
				lastQueryRef.current = trimmed;
			} catch (err) {
				if (seq !== searchSeqRef.current) return;
				setError(err instanceof Error ? err.message : "Search failed");
				setHits([]);
			} finally {
				if (seq === searchSeqRef.current) setIsSearching(false);
			}
		},
		[editor.media, refreshIndex, cache],
	);

	/** Debounced search driven by a query string (use in an input's onChange). */
	const debouncedSearch = useCallback(
		(query: string) => {
			const timeoutId = setTimeout(() => search(query), DEBOUNCE_MS);
			return () => clearTimeout(timeoutId);
		},
		[search],
	);

	/** "Find more like this": search by an existing media asset's frames. */
	const findSimilar = useCallback(
		async (mediaId: string, opts?: { limit?: number; threshold?: number }) => {
			const seq = ++searchSeqRef.current;
			setIsSearching(true);
			setError(null);
			try {
				if (await cache.isStale()) await refreshIndex();
				const source = cache.records.find((m) => m.mediaId === mediaId);
				if (!source || source.frames.length === 0) {
					if (seq === searchSeqRef.current) setHits([]);
					return;
				}
				// Average all source frames into a single query vector.
				const dim = source.frames[0].vector.length;
				const queryVec = new Float32Array(dim);
				for (const f of source.frames) {
					for (let i = 0; i < dim; i++) queryVec[i] += f.vector[i];
				}
				const inv = 1 / source.frames.length;
				let norm = 0;
				for (let i = 0; i < dim; i++) {
					queryVec[i] *= inv;
					norm += queryVec[i] * queryVec[i];
				}
				norm = Math.sqrt(norm) || 1;
				for (let i = 0; i < dim; i++) queryVec[i] /= norm;

				const limit = opts?.limit ?? 30;
				// Like search()'s 0.18, tuned against the retired server backend;
				// pending empirical retune for clip-vit-b32-web (Task 5).
				const threshold = opts?.threshold ?? 0.7;
				const assets = editor.media.getAssets();
				const byId = new Map(assets.map((a) => [a.id, a]));
				const candidates: SearchHit[] = [];
				for (const media of cache.records) {
					if (media.mediaId === mediaId) continue;
					const asset = byId.get(media.mediaId);
					if (!asset) continue;
					let bestScore = -Infinity;
					let bestTs = 0;
					for (const frame of media.frames) {
						const score = dotProduct(queryVec, frame.vector);
						if (score > bestScore) {
							bestScore = score;
							bestTs = frame.timestampSec;
						}
					}
					if (bestScore >= threshold) {
						candidates.push({
							mediaId: media.mediaId,
							timestampSec: bestTs,
							score: bestScore,
							mediaName: asset.name,
							mediaType: asset.type,
							thumbnailUrl: asset.thumbnailUrl,
						});
					}
				}
				candidates.sort((a, b) => b.score - a.score);
				if (seq !== searchSeqRef.current) return; // superseded by a newer query
				setHits(candidates.slice(0, limit));
				lastQueryRef.current = `similar:${mediaId}`;
			} catch (err) {
				if (seq !== searchSeqRef.current) return;
				setError(err instanceof Error ? err.message : "Find similar failed");
				setHits([]);
			} finally {
				if (seq === searchSeqRef.current) setIsSearching(false);
			}
		},
		[editor.media, refreshIndex, cache],
	);

	/** Keep the cached index fresh whenever media changes (imports, deletions). */
	useEffect(() => {
		refreshIndex();
		const unsubscribe = editor.media.subscribe(() => {
			// Defer so we don't run during React commit phase.
			setTimeout(refreshIndex, 200);
		});
		return unsubscribe;
	}, [editor.media, refreshIndex]);

	return {
		hits,
		isSearching,
		error,
		indexedCount,
		indexing,
		hasIndex,
		search,
		debouncedSearch,
		findSimilar,
		refreshIndex,
	} satisfies VisualSearchState & {
		search: typeof search;
		debouncedSearch: typeof debouncedSearch;
		findSimilar: typeof findSimilar;
		refreshIndex: typeof refreshIndex;
	};
}

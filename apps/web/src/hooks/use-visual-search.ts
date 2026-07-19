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
import {
	createSearchIndexCache,
	shouldPollForIndex,
} from "@/lib/search/search-index-cache";
import type { SearchHit, ZeroShotTag } from "@/lib/search/embedding-types";

export interface VisualSearchState {
	hits: SearchHit[];
	isSearching: boolean;
	error: string | null;
	indexedCount: number;
	/** Assets currently being indexed (mediaId → phase). */
	indexing: Record<string, { phase: string; progress: number }>;
	/** True if at least one media asset has been indexed. */
	hasIndex: boolean;
	/**
	 * True when the current `hits` are a near-miss backfill — nothing cleared
	 * the strong-match threshold, so the panel is showing its best guesses
	 * instead of a blank "no matches" state. UI should hint at the lower
	 * confidence rather than presenting these as equal to a normal result set.
	 */
	isNearMiss: boolean;
}

const DEBOUNCE_MS = 300;
const MIN_QUERY_LEN = 2;
// Slow poll while the index window is open (see shouldPollForIndex): fast
// enough that the panel un-disables shortly after a background pass lands,
// slow enough that the tiny status-store read is negligible.
const INDEX_POLL_MS = 1500;

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

/** Lowercase alnum tokens — deliberately simple, this only feeds string matching. */
function tokenize(text: string): string[] {
	return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/**
 * Ranking-only bonus that blends in lexical signal already sitting in memory:
 * the asset's filename and the zero-shot tags computed once at index time
 * (`embedding-service.ts`'s `indexMedia`, scored against `ZERO_SHOT_LABELS`).
 * No extra embedding calls, no IndexedDB reads — just string matching.
 *
 * This catches cases pure CLIP similarity tends to miss: camera-generated
 * filenames a user later searches for verbatim ("DJI_0043"), or a query that
 * happens to name one of the fixed zero-shot labels exactly ("b-roll",
 * "interview"). It's capped well under a typical strong-match cosine score so
 * text alone can never manufacture a "strong" hit on its own — it only
 * nudges ranking order and widens the near-miss backfill below.
 */
function lexicalBonus(
	queryTokens: string[],
	name: string,
	tags: ZeroShotTag[],
): number {
	if (queryTokens.length === 0) return 0;
	const nameTokens = tokenize(name);
	let bonus = 0;
	for (const qt of queryTokens) {
		if (qt.length < 3) continue; // skip short/stopword-ish tokens ("a", "of")
		if (nameTokens.includes(qt)) bonus += 0.06;
		else if (
			nameTokens.some(
				(nt) => nt.length >= 3 && (nt.includes(qt) || qt.includes(nt)),
			)
		)
			bonus += 0.03;
	}
	for (const tag of tags) {
		const tagTokens = tokenize(tag.label);
		if (queryTokens.some((qt) => tagTokens.includes(qt))) {
			bonus += 0.05 * Math.max(tag.score, 0);
		}
	}
	return Math.min(bonus, LEXICAL_BONUS_CAP);
}

/** Ceiling on {@link lexicalBonus} — see its doc comment for why. */
const LEXICAL_BONUS_CAP = 0.15;

/**
 * How far below the strong-match threshold a near-miss backfill is allowed
 * to reach. Only used when NOTHING clears the strong threshold — genuine
 * strong matches always win outright; this is purely a "don't show a blank
 * empty state when there's plausible signal" backstop, per query.
 */
const NEAR_MISS_FLOOR_RATIO = 0.5;
/** Cap on backfilled near-miss candidates — a long list of low-confidence
 *  guesses is worse than a short, honestly-labeled one. */
const NEAR_MISS_MAX = 12;

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
	const [isNearMiss, setIsNearMiss] = useState(false);
	// React-free vector cache + staleness signal (see search-index-cache.ts for
	// why staleness keys off indexed STATUSES, not the store count — the
	// migration re-index rewrites records in place without changing the count).
	const [cache] = useState(createSearchIndexCache);
	// While true, a slow interval watches for background indexing to land —
	// the panel disables its input when nothing is searchable, so the
	// search-time isStale() check alone can never revive it.
	const [pollActive, setPollActive] = useState(false);
	const lastQueryRef = useRef<string>("");
	// Monotonic token so a slower search/findSimilar response can't overwrite the
	// results of a newer one issued after it.
	const searchSeqRef = useRef(0);

	/** Refresh the cached embedding index from IndexedDB. */
	const refreshIndex = useCallback(async () => {
		const snapshot = await cache.refresh();
		const { records, statuses } = snapshot;
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
		const hasIndexableAssets = editor.media
			.getAssets()
			.some((a) => a.type === "video" || a.type === "image");
		setPollActive(shouldPollForIndex(snapshot, hasIndexableAssets));
	}, [cache, editor.media]);

	// Poll the (tiny) status store while the index window is open, refreshing
	// only when the searchable set actually changed. Closes itself: once a
	// refresh sees searchable records and no in-flight work, pollActive flips
	// false and the interval is torn down.
	useEffect(() => {
		if (!pollActive) return;
		const id = setInterval(() => {
			cache
				.isStale()
				.then((stale) => (stale ? refreshIndex() : undefined))
				.catch(() => undefined);
		}, INDEX_POLL_MS);
		return () => clearInterval(id);
	}, [pollActive, cache, refreshIndex]);

	/** Run a search query against the cached embedding index. */
	const search = useCallback(
		async (query: string, opts?: { limit?: number; threshold?: number }) => {
			const seq = ++searchSeqRef.current;
			const trimmed = query.trim();
			if (trimmed.length < MIN_QUERY_LEN) {
				setHits([]);
				setError(null);
				setIsNearMiss(false);
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
				const queryTokens = tokenize(trimmed);

				const limit = opts?.limit ?? 30;
				// 0.18 was tuned against the retired server backend (laion2b
				// ViT-B-32); pending empirical retune for clip-vit-b32-web (Task 5).
				const threshold = opts?.threshold ?? 0.18;
				const assets = editor.media.getAssets();
				const byId = new Map(assets.map((a) => [a.id, a]));

				// Score every indexed asset once. `hit.score` stays a pure cosine
				// similarity (unchanged contract — see SearchHit's doc comment);
				// `hybridScore` folds in the lexical bonus and is used only to pick
				// and order results below, never surfaced directly. Deferring the
				// threshold cut until after scoring lets a query with zero strong
				// hits still offer its best near-misses instead of going blank.
				const allCandidates: { hit: SearchHit; hybridScore: number }[] = [];
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
					const hybridScore =
						bestScore + lexicalBonus(queryTokens, asset.name, media.tags);
					allCandidates.push({
						hit: {
							mediaId: media.mediaId,
							timestampSec: bestTs,
							score: bestScore,
							mediaName: asset.name,
							mediaType: asset.type,
							thumbnailUrl: asset.thumbnailUrl,
						},
						hybridScore,
					});
				}
				allCandidates.sort((a, b) => b.hybridScore - a.hybridScore);

				const strong = allCandidates.filter((c) => c.hybridScore >= threshold);
				let nearMiss = false;
				let selected = strong;
				if (strong.length === 0) {
					// Nothing cleared the bar — relax it and see if there's anything
					// plausible worth showing instead of an empty state. Bounded on
					// both ends: a floor well below "strong" so obvious non-matches
					// stay excluded, and a small max count so this reads as "a few
					// weak guesses," not a full result page.
					const floor = threshold * NEAR_MISS_FLOOR_RATIO;
					const backfill = allCandidates.filter((c) => c.hybridScore >= floor);
					if (backfill.length > 0) {
						nearMiss = true;
						selected = backfill.slice(0, NEAR_MISS_MAX);
					}
				}

				if (seq !== searchSeqRef.current) return; // superseded by a newer search
				setHits(selected.slice(0, limit).map((c) => c.hit));
				setIsNearMiss(nearMiss);
				lastQueryRef.current = trimmed;
			} catch (err) {
				if (seq !== searchSeqRef.current) return;
				setError(err instanceof Error ? err.message : "Search failed");
				setHits([]);
				setIsNearMiss(false);
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
			// findSimilar has no query text to apply a lexical bonus to, and its
			// higher threshold (0.7) already targets "highly similar," where a
			// near-miss backfill would be more surprising than useful — but the
			// flag from a prior text search must still be cleared so its hint
			// banner doesn't linger over these results.
			setIsNearMiss(false);
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
		isNearMiss,
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

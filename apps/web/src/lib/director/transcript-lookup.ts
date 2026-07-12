/**
 * The sync seam between the per-asset transcript store and the Director.
 *
 * SYNC over ASYNC, same shape as `understanding-lookup.ts`: `getProjectInfo`
 * rebuilds the library manifest every turn synchronously, and the Director's
 * `getTranscript` verb handler is synchronous too — but the transcript store is
 * async IndexedDB. So we keep a small in-memory cache, prime it on Director
 * mount ({@link primeTranscriptCache}), upsert on every fresh transcription
 * ({@link cacheTranscript}), and expose the synchronous
 * {@link assetTranscriptLookup} both consumers read. With nothing transcribed
 * yet the lookup returns `undefined` everywhere and the manifest simply omits
 * its speech facet — the designed degraded mode.
 */

import type { AssetTranscript } from "@/lib/search/asset-transcript";
import { hasSpeech } from "@/lib/search/asset-transcript";
import { getAllTranscripts } from "@/services/search/asset-transcript-store";

/** Synchronous per-asset transcript lookup handed to `createDirectorApi({ transcripts })`. */
export type AssetTranscriptLookup = (
	mediaId: string,
) => AssetTranscript | undefined;

const cache = new Map<string, AssetTranscript>();

/** The one synchronous read-through the manifest + `getTranscript` verb share. */
export const assetTranscriptLookup: AssetTranscriptLookup = (mediaId) =>
	cache.get(mediaId);

/**
 * The manifest's speech facet: `true` ⇒ transcribed with real speech, `false` ⇒
 * transcribed and silent, `undefined` ⇒ not transcribed yet. Kept as its own
 * tiny adapter so the manifest never learns the full transcript shape.
 */
export function assetHasSpeech(mediaId: string): boolean | undefined {
	const t = cache.get(mediaId);
	return t ? hasSpeech(t) : undefined;
}

/**
 * Load every persisted transcript into the sync cache. Called on Director
 * mount. Fails soft: if IndexedDB is unavailable (SSR, tests) the cache is
 * left as-is and consumers see "not transcribed yet".
 */
export async function primeTranscriptCache(): Promise<void> {
	try {
		const rows = await getAllTranscripts();
		cache.clear();
		for (const t of rows) cache.set(t.mediaId, t);
	} catch {
		// no IndexedDB here — leave the cache empty; consumers degrade.
	}
}

/** Upsert one record so a freshly-transcribed asset is visible without a re-prime. */
export function cacheTranscript(t: AssetTranscript): void {
	cache.set(t.mediaId, t);
}

/** Drop everything (Director unmount / project switch). */
export function clearTranscriptCache(): void {
	cache.clear();
}

/**
 * The reconciliation seam between the "Understanding Pass" (`@/lib/search/
 * asset-understanding`) and the Asset Manifest (`./asset-manifest`).
 *
 * The two were built in parallel against slightly different shapes: the
 * Understanding Pass owns the CANONICAL per-asset record (required fields,
 * `roleConfirmed` carrying the OVERRIDE role, an `effectiveRole` helper, a
 * `screen-rec` role, richer `faces`), while the Manifest consumes a minimal
 * display-side mirror with optional fields. This module is the single adapter
 * that bridges them, so neither had to depend on the other while in flight.
 *
 * THE ROLE BELIEF: the Manifest reads `u.role` directly, so the adapter must
 * resolve the override HERE — {@link adaptUnderstandingForManifest} sets the
 * manifest's `role` to {@link effectiveRole} (`roleConfirmed ?? role`), which is
 * the whole point of the override existing. A human/usage confirmation therefore
 * wins in the digest, not just in the store.
 *
 * SYNC over ASYNC: `getProjectInfo` rebuilds the manifest every turn and is
 * synchronous, but the understanding store is async IndexedDB. So we keep a
 * small in-memory cache, {@link primeUnderstandingCache} it on editor mount, and
 * expose a synchronous {@link manifestUnderstandingLookup} the manifest reads.
 * With the Understanding Pass autorun gated off by default the store is usually
 * empty, in which case the lookup returns `undefined` and the manifest degrades
 * to media-type counts — exactly its designed fallback.
 */

import {
	type AssetUnderstanding as CanonicalUnderstanding,
	effectiveRole,
	normalizeMotion,
	type StyleProbe,
} from "@/lib/search/asset-understanding";
import { getAllUnderstandings } from "@/services/search/asset-understanding-store";
import type {
	AssetUnderstanding as ManifestUnderstanding,
	AssetUnderstandingLookup,
} from "./asset-manifest";

/** Synchronous per-asset style-probe lookup (palette / lens-mood / setting). */
export type StyleProbeLookup = (mediaId: string) => StyleProbe | undefined;

/**
 * Project a CANONICAL understanding record onto the Manifest's display-side
 * shape. Pure. Resolves the role via {@link effectiveRole} so a `roleConfirmed`
 * override wins, collapses `roleConfirmed` to the boolean the Manifest wants,
 * and carries only the face fields the digest names. `screen-rec` passes through
 * unchanged now that the Manifest's role vocabulary includes it.
 *
 * Also carries `styleProbe` (palette/lensMood/setting) through — this used to
 * be dropped here, which meant the Director never saw a look the Insights
 * panel already showed a human. Restored so `buildLibraryManifest` can surface
 * it on named heroes (see `asset-manifest.ts`'s `ManifestHero.styleProbe`).
 */
export function adaptUnderstandingForManifest(
	u: CanonicalUnderstanding,
): ManifestUnderstanding {
	// `motion` runs through `normalizeMotion` rather than passing straight
	// through: a record persisted before motion was narrowed to the measured
	// three-class vocabulary can still carry `pan`/`handheld`, and the store is
	// schema-less with no migration. Normalizing on READ is the migration.
	const motion = normalizeMotion(u.motion);
	return {
		mediaId: u.mediaId,
		caption: u.caption,
		role: effectiveRole(u),
		roleConfidence: u.roleConfidence,
		roleConfirmed: u.roleConfirmed != null,
		tags: u.tags,
		faces: u.faces.map((f) => ({
			personaMatch: f.personaMatch,
			score: f.score,
			isNew: f.isNew,
		})),
		...(u.styleProbe
			? {
					styleProbe: {
						palette: u.styleProbe.palette,
						lensMood: u.styleProbe.lensMood,
						setting: u.styleProbe.setting,
					},
				}
			: {}),
		// Deepened perception (Bet 1 — director-intelligence architecture): carried
		// through when present, same "spread only when set" discipline as
		// styleProbe above. A SHALLOW canonical record (predates the widening, or
		// degraded) simply has none of these — the manifest side degrades silently.
		...(motion ? { motion } : {}),
		...(u.shotType ? { shotType: u.shotType } : {}),
		...(u.composition
			? {
					composition: {
						subjectPosition: u.composition.subjectPosition,
						headroom: u.composition.headroom,
						ruleOfThirds: u.composition.ruleOfThirds,
					},
				}
			: {}),
		...(u.emotion ? { emotion: u.emotion } : {}),
		...(u.audio
			? { audio: { hasSpeech: u.audio.hasSpeech, energy: u.audio.energy } }
			: {}),
		...(u.continuityFingerprint
			? {
					continuityFingerprint: {
						lighting: u.continuityFingerprint.lighting,
						whiteBalance: u.continuityFingerprint.whiteBalance,
						wardrobe: u.continuityFingerprint.wardrobe,
						colorSignature: u.continuityFingerprint.colorSignature,
					},
				}
			: {}),
	};
}

// ── sync cache the manifest reads each turn ──────────────────────────────────

const cache = new Map<string, ManifestUnderstanding>();

/**
 * Parallel sync cache of the canonical {@link StyleProbe} per asset — the manifest
 * shape drops it, but the Project Bible's styleBible seam (Flow-D follow-up B,
 * `seedStyleBibleFromProbe`) needs it. Primed/updated/cleared in lockstep with
 * {@link cache} so the two never drift.
 */
const probeCache = new Map<string, StyleProbe>();

/** Synchronous per-asset lookup handed to `createDirectorApi({ understanding })`. */
export const manifestUnderstandingLookup: AssetUnderstandingLookup = (
	mediaId,
) => cache.get(mediaId);

/** Synchronous per-asset style-probe lookup handed to `createDirectorApi({ styleProbe })`. */
export const styleProbeLookup: StyleProbeLookup = (mediaId) =>
	probeCache.get(mediaId);

/**
 * Load every persisted understanding record into the sync cache. Called on
 * editor mount / project switch. Fails soft: if IndexedDB is unavailable (SSR,
 * tests) the cache is simply left as-is and the manifest degrades gracefully.
 */
export async function primeUnderstandingCache(): Promise<void> {
	try {
		const rows = await getAllUnderstandings();
		cache.clear();
		probeCache.clear();
		for (const u of rows) {
			cache.set(u.mediaId, adaptUnderstandingForManifest(u));
			if (u.styleProbe) probeCache.set(u.mediaId, u.styleProbe);
		}
	} catch {
		// no IndexedDB here — leave the cache empty; the manifest falls back.
	}
}

/**
 * Upsert a single record into the cache — the seam the Understanding Pass
 * indexer can call after a `saveUnderstanding` so a freshly-understood asset
 * shows up in the digest without a full re-prime. (Wiring the indexer call site
 * is a follow-up; the pure path is here and tested.)
 */
export function cacheUnderstanding(u: CanonicalUnderstanding): void {
	cache.set(u.mediaId, adaptUnderstandingForManifest(u));
	if (u.styleProbe) probeCache.set(u.mediaId, u.styleProbe);
	else probeCache.delete(u.mediaId);
}

/**
 * Up to `limit` non-empty asset captions from the primed cache — a cheap, sync
 * read (no IndexedDB, no fetch) for surfaces that want a compact "what's in this
 * project" grounding blurb (e.g. the prompt-enhance context payload). Returns
 * `[]` when nothing has been understood yet.
 */
export function getUnderstandingCaptions(limit = 10): string[] {
	const out: string[] = [];
	for (const u of cache.values()) {
		const caption = u.caption?.trim();
		if (!caption) continue;
		out.push(caption);
		if (out.length >= limit) break;
	}
	return out;
}

/** Drop everything from the cache (on editor unmount / project switch). */
export function clearUnderstandingCache(): void {
	cache.clear();
	probeCache.clear();
}

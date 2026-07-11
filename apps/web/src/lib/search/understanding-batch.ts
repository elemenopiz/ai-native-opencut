/**
 * Pure batch-selection logic for the Understanding Pass — which assets a batch
 * run should actually send to the paid VLM relay, and how many at once.
 *
 * Two callers share this (so their eligibility rules can never drift):
 *  - the DEMAND-DRIVEN path (`use-director`): when the Director mounts, every
 *    project asset without an understanding record is queued, uncapped — the
 *    user just asked for the Director, so grounding the manifest is the point.
 *  - the IMPORT-TIME autorun (`use-embedding-indexer`, opt-in via
 *    NEXT_PUBLIC_UNDERSTANDING_AUTORUN=1): capped per tick so a bulk import
 *    can't fire hundreds of relay calls; whatever the cap skips is picked up
 *    by the demand-driven path later.
 *
 * Selection is a FILTER, not a scheduler: callers own de-dupe state (what's
 * already understood / already attempted / inflight) and pass it as `exclude`.
 * The paid-call safety net stays in `understandAsset` itself, which checks the
 * persisted store before ever touching the relay — so over-selecting here can
 * waste a store read, never a billed call.
 */

import type { MediaAsset } from "@/types/assets";

/**
 * Per-tick cap for the IMPORT-TIME autorun prefetch (assets per indexer tick).
 * The autorun fires on every media-manager change, so without a cap a bulk
 * import of a large library would burst the paid relay with one call per
 * asset. 20 keeps a typical import fully prefetched in one tick while bounding
 * the worst case; anything beyond the cap is left for a later tick or for the
 * demand-driven Director path.
 */
export const UNDERSTANDING_AUTORUN_TICK_CAP = 20;

export interface SelectUnderstandingCandidatesOptions {
	/**
	 * Media ids to skip — already understood (sync cache hit), already
	 * attempted this session, or currently inflight. Caller-owned.
	 */
	exclude?: ReadonlySet<string>;
	/** Max assets returned (in input order). Omit for "all eligible". */
	cap?: number;
}

/**
 * Filter `assets` down to the ones an understanding batch should process:
 * visual media (video/image — audio has no frames to caption), with a loaded
 * `url` to sample from, not excluded — capped at `cap`, preserving input
 * order so earlier-imported assets are understood first.
 */
export function selectUnderstandingCandidates(
	assets: readonly MediaAsset[],
	options: SelectUnderstandingCandidatesOptions = {},
): MediaAsset[] {
	const { exclude, cap } = options;
	const out: MediaAsset[] = [];
	for (const asset of assets) {
		if (cap !== undefined && out.length >= cap) break;
		if (asset.type !== "video" && asset.type !== "image") continue;
		if (!asset.url) continue;
		if (exclude?.has(asset.id)) continue;
		out.push(asset);
	}
	return out;
}

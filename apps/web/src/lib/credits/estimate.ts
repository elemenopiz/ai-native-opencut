/**
 * Client-safe credits estimator — mirrors `cost-table.ts`'s per-backend billing
 * rates exactly, so a pre-generation UI estimate never drifts from what the
 * server will actually charge (`costFor`, called again server-side at dispatch
 * time, is the final word). `cost-table.ts` is pure data/functions (no secret
 * env, no server-only imports) so it's imported directly here rather than
 * duplicated — there is exactly ONE table of rates in the codebase.
 *
 * Backend-aware when the caller knows which backend will run (an exact
 * `costFor()` call); falls back to a min–max range across every registered
 * backend of that modality when it doesn't (e.g. a batch of not-yet-routed
 * slots, or a form before a backend is picked) — an honest "could cost this
 * much" estimate rather than a guess.
 */

import {
	costFor,
	imageCreditsRange,
	videoCreditsRange,
	audioCreditsRange,
	DEFAULT_CLIP_SECONDS,
	type VideoResolution,
} from "@/lib/credits/cost-table";
import { DEFAULT_BACKEND_ID } from "@/lib/studio/backends/registry";

export type { VideoResolution };

export interface CreditRange {
	low: number;
	high: number;
}

/**
 * Credits for one video clip of `seconds`[/`resolution`]. Exact
 * (`low === high`) when `backendId` is the routed/selected backend; otherwise
 * a min–max range across every registered video backend's rate. `resolution`
 * matters for Seedance (its sale rate is resolution-degressive) — pass it
 * whenever the UI knows it, even without a pinned backend, so the range
 * narrows to the right tier instead of spanning all three.
 */
export function estimateVideoCredits(
	seconds: number = DEFAULT_CLIP_SECONDS,
	backendId?: string,
	resolution?: VideoResolution,
): CreditRange {
	if (backendId) {
		try {
			const credits = costFor(backendId, "video", { seconds, resolution });
			return { low: credits, high: credits };
		} catch {
			// Unregistered/unknown id (e.g. a stale pin) — fall through to the range.
		}
	}
	return videoCreditsRange(seconds, resolution);
}

/**
 * Credits for `count` images. Defaults to the registry's default image
 * backend (the one the per-shot-still path actually renders through) when
 * `backendId` isn't supplied, so this is exact in the common case rather than
 * a range.
 */
export function estimateImageCredits(
	count = 1,
	backendId: string = DEFAULT_BACKEND_ID.image,
): CreditRange {
	try {
		const credits = costFor(backendId, "image", { count });
		return { low: credits, high: credits };
	} catch {
		return imageCreditsRange(count);
	}
}

/**
 * Credits for one audio job (score or music) of `seconds`. Exact when
 * `backendId` is the routed/selected backend (the Audio tab always knows
 * this — it picks the backend per action, not from an open catalog), else a
 * min–max range across `fal-mmaudio` and `elevenlabs-music`'s very different
 * per-second rates.
 */
export function estimateAudioCredits(
	seconds: number,
	backendId?: string,
): CreditRange {
	if (backendId) {
		try {
			const credits = costFor(backendId, "audio", { seconds });
			return { low: credits, high: credits };
		} catch {
			// Unregistered/unknown id — fall through to the range.
		}
	}
	return audioCreditsRange(seconds);
}

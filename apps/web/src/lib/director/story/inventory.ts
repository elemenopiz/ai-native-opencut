/**
 * Story Engine, stage 2 — the deterministic Inventory build
 * (`docs/plans/2026-07-20-story-engine-design.md` §2).
 *
 * Walks the project's media assets and produces a {@link FootageInventory}:
 * per-asset facts (duration, kind, whether a transcript/beat-grid/
 * understanding/silence-map is available) plus the aggregate `speechShare`
 * metric that later picks the assembly strategy (SE-3).
 *
 * PURE / DETERMINISTIC, same discipline `edit-critic.ts` and
 * `asset-manifest.ts` use for their planning cores: no React, no store, no
 * IndexedDB, no network, NO MODEL CALL anywhere in this file. Every external
 * fact (transcript presence, beat grid, understanding depth, silence-map
 * availability) arrives through an INJECTED per-asset lookup — same
 * "own copy, not import" / "sync read-through" pattern as
 * `AssetUnderstandingLookup`/`AssetSpeechLookup`/`AssetBeatGridLookup` in
 * `asset-manifest.ts` and `AssetTranscriptLookup` in `transcript-lookup.ts`.
 * `buildFootageInventory` reads only what's handed to it in `input` — same
 * input twice (including the SAME lookup functions, which must themselves be
 * deterministic for a given mediaId) ⇒ deep-equal output.
 */

import type { AssetUnderstanding } from "@/lib/search/asset-understanding";
import { isDeepUnderstanding } from "@/lib/search/asset-understanding";
import { hasSpeech } from "@/lib/search/asset-transcript";
import type { AssetBeatGridLookup } from "../asset-manifest";
import type { AssetTranscriptLookup } from "../transcript-lookup";
import type {
	FootageInventory,
	FootageInventoryAsset,
	InventoryMediaAsset,
} from "./types";

/**
 * Injected read-through to per-asset UNDERSTANDING, at the CANONICAL
 * `@/lib/search/asset-understanding` shape (not the manifest's minimal
 * mirror) — `buildFootageInventory` needs the real record so it can call
 * {@link isDeepUnderstanding} on it directly, per the design's explicit
 * requirement. Returns `undefined` when the asset has no understanding row.
 * ABSENT (the whole lookup) ⇒ every asset's `hasUnderstanding`/
 * `hasDeepUnderstanding` are `false` — never a crash, never a guess.
 */
export type AssetUnderstandingCanonicalLookup = (
	mediaId: string,
) => AssetUnderstanding | undefined;

/**
 * Injected read-through to per-asset SILENCE/FILLER analysis availability
 * (the `lib/auto-cut` engines' output). `true` ⇒ an analysis is
 * cached/available for this asset; `false`/`undefined` ⇒ none yet — the
 * common case, since these analyses are computed on-demand from decoded
 * audio and (as of this writing) have no persisted per-asset store, same
 * "deliberately sparse" posture the beat-grid lookup already has. Deliberately
 * a boolean facet, not the analysis itself — mirrors `AssetSpeechLookup`'s own
 * "digest names THAT it exists; a verb/caller fetches the real thing" shape.
 */
export type SilenceMapLookup = (mediaId: string) => boolean | undefined;

/** Media kinds that can carry speech — mirrors `selectTranscriptionCandidates`'s own kind filter in `@/lib/search/asset-transcript` (video + audio; never image). */
function isSpeechBearingKind(kind: InventoryMediaAsset["kind"]): boolean {
	return kind === "video" || kind === "audio";
}

/** A non-negative, finite duration in seconds, or `0` for anything unprobed/invalid. Never propagates `undefined`/`NaN` into the inventory's aggregate math. */
function resolveDurationSec(durationSec: number | undefined): number {
	return Number.isFinite(durationSec) && (durationSec as number) > 0
		? (durationSec as number)
		: 0;
}

/**
 * Build a {@link FootageInventory} from the project's media assets + optional
 * injected lookups. Pure and deterministic — see this module's doc comment
 * for the full discipline. Every lookup is OPTIONAL and independently
 * absent-able: an asset whose id no lookup resolves anything for still
 * produces a fully-typed row (every presence flag `false`/`undefined`, never
 * a thrown error) — mirrors `buildLibraryManifest`'s own graceful-degradation
 * contract for a missing understanding/speech/beat-grid lookup.
 *
 * See {@link FootageInventory.speechShare}'s doc comment (in `types.ts`) for
 * the exact `speechShare` formula and its edge cases (empty library,
 * untranscribed speech-bearing media, transcribed-but-silent assets) — this
 * function is that formula's one implementation.
 */
export function buildFootageInventory(input: {
	assets: readonly InventoryMediaAsset[];
	/** Per-asset transcript lookup (see `transcript-lookup.ts`'s `AssetTranscriptLookup`). Absent ⇒ every `hasTranscriptSegments` is `undefined` and every speech-bearing asset is `possiblyUntranscribed`. */
	transcripts?: AssetTranscriptLookup;
	/** Per-asset CANONICAL understanding lookup (see {@link AssetUnderstandingCanonicalLookup}). Absent ⇒ every `hasUnderstanding`/`hasDeepUnderstanding` is `false`. */
	understanding?: AssetUnderstandingCanonicalLookup;
	/** Per-asset beat-grid lookup (see `asset-manifest.ts`'s `AssetBeatGridLookup`). Absent ⇒ every `hasBeatGrid` is `false`. */
	beatGrid?: AssetBeatGridLookup;
	/** Per-asset silence/filler-map availability lookup (see {@link SilenceMapLookup}). Absent ⇒ every `hasSilenceMap` is `false`. */
	silenceMap?: SilenceMapLookup;
}): FootageInventory {
	const { assets, transcripts, understanding, beatGrid, silenceMap } = input;

	let totalDurationSec = 0;
	let speechDurationSec = 0;
	let untranscribedCount = 0;

	const inventoryAssets: FootageInventoryAsset[] = assets.map((asset) => {
		const durationSec = resolveDurationSec(asset.durationSec);
		totalDurationSec += durationSec;

		const transcript = transcripts?.(asset.id);
		// `hasSpeech` distinguishes "transcribed, real speech" (true) from
		// "transcribed, silent" (false) — both are REAL, checked answers.
		// `undefined` (no transcript record at all) is the third, distinct
		// state: "not checked yet".
		const hasTranscriptSegments = transcript
			? hasSpeech(transcript)
			: undefined;
		if (hasTranscriptSegments === true) speechDurationSec += durationSec;

		const possiblyUntranscribed =
			isSpeechBearingKind(asset.kind) && hasTranscriptSegments === undefined;
		if (possiblyUntranscribed) untranscribedCount += 1;

		const understandingRow = understanding?.(asset.id);
		const hasUnderstanding = understandingRow != null;
		const hasDeepUnderstanding =
			understandingRow != null && isDeepUnderstanding(understandingRow);

		const hasBeatGrid = beatGrid?.(asset.id) != null;
		const hasSilenceMap = silenceMap?.(asset.id) === true;

		return {
			id: asset.id,
			kind: asset.kind,
			durationSec,
			hasTranscriptSegments,
			hasBeatGrid,
			hasUnderstanding,
			hasDeepUnderstanding,
			hasSilenceMap,
			possiblyUntranscribed,
		};
	});

	// Empty library ⇒ speechShare = 0 by definition (see types.ts doc comment),
	// never a 0/0 fallback.
	const speechShare =
		totalDurationSec > 0 ? speechDurationSec / totalDurationSec : 0;

	return {
		assets: inventoryAssets,
		totalDurationSec,
		speechShare,
		untranscribedCount,
	};
}

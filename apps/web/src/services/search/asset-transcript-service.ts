/**
 * Asset transcription orchestrator — the ingest-time pass that turns a media
 * asset's audio into a persisted {@link AssetTranscript}.
 *
 * The RUNTIME half of `lib/search/asset-transcript.ts`: extract the asset's
 * audio → MAI-Transcribe-2 via `/api/transcribe` → persist + upsert the
 * Director's sync cache.
 *
 * COST NOTE: this used to be free, because it ran on-device Whisper. It is now
 * a PAID cloud call billed per hour of audio, and it fires for every ingested
 * audio/video asset. The `getTranscript` short-circuit below is therefore a
 * spend guard, not just a speed one: an asset is transcribed exactly once and
 * the result is persisted, so re-mounting a project costs nothing.
 *
 * Triggers: ingest (every uploaded audio/video asset transcribes immediately)
 * and `use-director`, which runs {@link transcribeAssetBatch} over any asset
 * that slipped through — that's the moment the agent needs speech grounding
 * for sentence-aligned cuts. Failures are per-asset and soft (nothing
 * persisted, so a later run retries).
 */

import {
	type AssetTranscript,
	fromTranscriptionResult,
} from "@/lib/search/asset-transcript";
import { transcribeWithMai } from "@/lib/transcription/mai-transcribe";
import { cacheTranscript } from "@/lib/director/transcript-lookup";
import {
	getTranscript,
	saveTranscript,
} from "@/services/search/asset-transcript-store";
import type { MediaAsset } from "@/types/assets";

export interface TranscribeAssetOptions {
	/** The transcription call (default: MAI-Transcribe-2); tests inject a stub. */
	transcribe?: (
		file: File,
	) => Promise<Parameters<typeof fromTranscriptionResult>[1]>;
	/** Re-run even if a record already exists. */
	force?: boolean;
}

/**
 * Transcribe ONE media asset and persist the record. Returns the transcript,
 * or `null` when the asset can't be transcribed here (no file, unsupported
 * browser, or the decode/model failed — nothing is persisted on failure, so a
 * later retry can still succeed). A successful run over silent footage DOES
 * persist an empty-segments record — that's a real "no speech here" answer,
 * which stops the batch from re-attempting the asset every mount.
 */
export async function transcribeAsset(
	media: MediaAsset,
	options?: TranscribeAssetOptions,
): Promise<AssetTranscript | null> {
	if (!options?.force) {
		const existing = await getTranscript(media.id).catch(() => undefined);
		if (existing) return existing;
	}

	if (!media.file || (media.type !== "video" && media.type !== "audio")) {
		return null; // nothing to decode.
	}
	// Background pass: never ask for diarization (it doubles provider work for
	// a label the search index doesn't use).
	//
	// STYLE — VERBATIM, and this is load-bearing. It used to be "clean" so that
	// filler words wouldn't pollute transcript search. That traded away more
	// than it bought:
	//   - "clean" asks the PROVIDER to delete every "um"/"uh" before we ever
	//     see it, which makes mid-sentence filler removal impossible by
	//     construction — there is nothing left in the text to find, and the
	//     honest-limitation counter in `lib/auto-cut/filler-detect.ts` would
	//     report a confident zero for the wrong reason.
	//   - Verbatim is the SUPERSET: clean can be derived from verbatim (drop
	//     known filler tokens — we already have the list), but verbatim cannot
	//     be recovered from clean without paying for the transcription twice.
	//     Since an asset is transcribed exactly once (see the spend guard
	//     above), the stored record has to be the recoverable one.
	// The search it was protecting does not exist yet, and the consumers that
	// do read this text either ignore content entirely
	// (`director/story/assembly.ts` only checks for non-empty) or render it for
	// an agent, where a few fillers cost a rounding error in tokens.
	const style = "verbatim" as const;
	const transcribe =
		options?.transcribe ??
		((file: File) => transcribeWithMai(file, { diarize: false, style }));

	let record: AssetTranscript;
	try {
		const result = await transcribe(media.file);
		// Stamp the style we ASKED for onto the record. A reader can then tell
		// "no fillers in this speech" from "fillers were stripped before
		// storage" — see `supportsFillerRemoval`.
		record = fromTranscriptionResult(media.id, { style, ...result });
	} catch {
		return null; // decode/model failure — leave un-transcribed for a retry.
	}

	await saveTranscript(record).catch(() => undefined);
	// Refresh the live sync cache the manifest + getTranscript verb read, so a
	// freshly-transcribed asset is visible mid-session without a re-prime.
	cacheTranscript(record);
	return record;
}

/**
 * Assets a batch is CURRENTLY processing, across every batch on the page —
 * the same concurrency window the understanding batch closes (there it's
 * double-billing; here it's double-work): two concurrent batches would both
 * pass the store check and both spin the Whisper worker on the same asset.
 */
const inflightIds = new Set<string>();

export interface TranscribeBatchSummary {
	/** Assets this run attempted (excludes inflight-elsewhere skips). */
	processed: number;
	/** Attempts that yielded a persisted transcript record. */
	transcribed: number;
	/** Of those, how many contain real speech. */
	withSpeech: number;
}

/**
 * Transcribe many assets sequentially. Sequential on purpose: one warm Whisper
 * worker, and the user is editing — we don't want N decodes competing for the
 * GPU. No credit gate (free/local); per-asset failures are soft and logged.
 */
export async function transcribeAssetBatch(
	mediaList: MediaAsset[],
	options?: TranscribeAssetOptions & {
		/** Per-asset progress callback (record is null when the asset failed/skipped). */
		onAssetComplete?: (mediaId: string, record: AssetTranscript | null) => void;
		/** Checked before each asset — return false to stop (e.g. hook unmounted). */
		shouldContinue?: () => boolean;
		/** The per-asset pass (default {@link transcribeAsset}); tests inject a stub. */
		transcribeOne?: typeof transcribeAsset;
	},
): Promise<TranscribeBatchSummary> {
	const transcribeOne = options?.transcribeOne ?? transcribeAsset;
	const summary: TranscribeBatchSummary = {
		processed: 0,
		transcribed: 0,
		withSpeech: 0,
	};
	for (const media of mediaList) {
		if (options?.shouldContinue && !options.shouldContinue()) break;
		if (inflightIds.has(media.id)) continue; // another batch owns it
		inflightIds.add(media.id);
		try {
			const record = await transcribeOne(media, options);
			summary.processed += 1;
			if (record) {
				summary.transcribed += 1;
				if (record.segments.some((s) => s.text.trim())) {
					summary.withSpeech += 1;
				}
			}
			options?.onAssetComplete?.(media.id, record);
		} catch (err) {
			summary.processed += 1;
			options?.onAssetComplete?.(media.id, null);
			console.warn(`[asset-transcript] failed for ${media.id}:`, err);
		} finally {
			inflightIds.delete(media.id);
		}
	}
	return summary;
}

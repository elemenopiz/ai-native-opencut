/**
 * Asset transcription orchestrator — the ingest-time pass that turns a media
 * asset's audio into a persisted {@link AssetTranscript}.
 *
 * The RUNTIME half of `lib/search/asset-transcript.ts`: decode the asset's
 * File → on-device Whisper (Transformers.js worker; audio never leaves the
 * device) → persist + upsert the Director's sync cache. FREE and LOCAL, so —
 * unlike the paid VLM Understanding Pass — there is no credit gate and no
 * relay: the only costs are CPU/GPU time and the one-time model download.
 *
 * The PRIMARY trigger mirrors the Understanding Pass: `use-director` runs
 * {@link transcribeAssetBatch} over not-yet-transcribed assets when the user
 * engages the Director — that's the moment the agent needs speech grounding
 * for sentence-aligned cuts. Unsupported browsers (no Worker/WebAudio) skip
 * the whole pass; failures are per-asset and soft (nothing persisted, so a
 * later run retries).
 */

import {
	type AssetTranscript,
	fromTranscriptionResult,
} from "@/lib/search/asset-transcript";
import {
	isLocalWhisperSupported,
	transcribeLocally,
} from "@/lib/transcription/local-whisper";
import { cacheTranscript } from "@/lib/director/transcript-lookup";
import {
	getTranscript,
	saveTranscript,
} from "@/services/search/asset-transcript-store";
import type { MediaAsset } from "@/types/assets";

export interface TranscribeAssetOptions {
	/** The transcription call (default: on-device Whisper); tests inject a stub. */
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
	const transcribe =
		options?.transcribe ?? ((file: File) => transcribeLocally(file));
	if (!options?.transcribe && !isLocalWhisperSupported()) return null;

	let record: AssetTranscript;
	try {
		const result = await transcribe(media.file);
		record = fromTranscriptionResult(media.id, result);
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

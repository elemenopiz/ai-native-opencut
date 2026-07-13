/**
 * Auto-cut (silence removal) public API — see ./types.ts for the contract.
 *
 * `detectSilenceSegments` is the pure core (unit-testable with synthetic
 * curves, lives in ./engine.ts); `analyzeMediaSilence` is the browser adapter
 * that decodes a media file to mono PCM (reusing the transcription decode path)
 * and runs the core.
 */

export type {
	AutoCutAnalysis,
	AutoCutOptions,
	EditSegment,
	ResolvedAutoCutOptions,
	SegmentAction,
} from "./types";

import { DECODE_SAMPLE_RATE, decodeToMono16k } from "@/lib/media/decode-audio";
import type { AutoCutAnalysis, AutoCutOptions } from "./types";

export {
	boolOps,
	chunkify,
	computeLoudness,
	detectSilenceSegments,
	mutMargin,
	resolveOptions,
	secondsToTicks,
	smoothing,
	thresholdLevels,
} from "./engine";

import { detectSilenceSegments } from "./engine";

/**
 * Browser adapter: decode `file`'s audio track to mono PCM and run
 * `detectSilenceSegments`. Rejects if the file has no decodable audio.
 *
 * Decoding is delegated to the shared `decodeToMono16k` helper (the same path
 * on-device Whisper uses) — 16 kHz mono is fine for loudness because max-abs is
 * robust to resampling and downmix.
 */
export async function analyzeMediaSilence(
	file: File,
	options?: AutoCutOptions,
): Promise<AutoCutAnalysis> {
	const samples = await decodeToMono16k(file);
	return detectSilenceSegments(samples, DECODE_SAMPLE_RATE, options);
}

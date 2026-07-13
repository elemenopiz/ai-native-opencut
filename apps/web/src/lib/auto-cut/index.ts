/**
 * Auto-cut (silence removal) public API — see ./types.ts for the contract.
 *
 * `detectSilenceSegments` is the pure core (unit-testable with synthetic
 * curves); `analyzeMediaSilence` is the browser adapter that decodes a media
 * file to mono PCM (reusing the transcription decode path) and runs the core.
 */

export type {
	AutoCutAnalysis,
	AutoCutOptions,
	EditSegment,
	ResolvedAutoCutOptions,
	SegmentAction,
} from "./types";

import type { AutoCutAnalysis, AutoCutOptions } from "./types";

/**
 * Pure core: mono PCM samples → labeled segments.
 * threshold → margin → smoothing → chunkify (auto-editor pipeline order).
 */
export function detectSilenceSegments(
	_samples: Float32Array,
	_sampleRate: number,
	_options?: AutoCutOptions,
): AutoCutAnalysis {
	throw new Error("auto-cut: not implemented yet (contract stub)");
}

/**
 * Browser adapter: decode `file`'s audio track to mono PCM and run
 * `detectSilenceSegments`. Rejects if the file has no decodable audio.
 */
export function analyzeMediaSilence(
	_file: File,
	_options?: AutoCutOptions,
): Promise<AutoCutAnalysis> {
	return Promise.reject(
		new Error("auto-cut: not implemented yet (contract stub)"),
	);
}

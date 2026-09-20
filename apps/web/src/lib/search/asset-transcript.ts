/**
 * Asset Transcripts — the ingest-time "what is SAID in this asset?" pass.
 *
 * THE GAP THIS CLOSES: the Understanding Pass gives the Director eyes (captions,
 * roles, faces) but no ears — the agent had zero awareness of speech, so a trim
 * of a talking-head clip could land mid-sentence. This module supplies the pure
 * pieces of a per-asset speech transcript the Director can cut against:
 *
 *  - {@link AssetTranscript} — the stable per-asset contract sibling systems
 *    (the Asset Manifest speech facet, the `getTranscript` verb) code against:
 *    timestamped sentence-level segments in ASSET-RELATIVE seconds — the same
 *    timebase as a clip's `trimStart`/`trimEnd`, so segment boundaries ARE
 *    valid cut points with no conversion.
 *  - {@link fromTranscriptionResult} adapts the shared `TranscriptionResult`
 *    shape into a lean stored record, INCLUDING per-word timings.
 *
 *    Words used to be dropped here, and that was right at the time: the only
 *    engine was on-device Whisper, whose `onnx-community/whisper-*` exports
 *    carry no cross-attentions, so the pipeline synthesized word times by
 *    splitting a phrase's span evenly across its tokens — fake precision that
 *    would have put cuts on invented boundaries. MAI-Transcribe-2 returns
 *    REAL per-word alignment (`modelOptions.timestamps: "word"`, see
 *    `app/api/transcribe/route.ts`), so the timings are now worth keeping:
 *    they are what lets auto-cut remove a filler word from the MIDDLE of a
 *    sentence instead of only cutting whole filler-only segments (WORD MODE
 *    in `lib/auto-cut/filler-detect.ts`).
 *
 *    COST: words are the bulk of a stored record — roughly 6x the segment
 *    payload (see `asset-transcript.test.ts`, which measures it rather than
 *    assuming). `confidence` is deliberately NOT stored: Azure reports it per
 *    PHRASE and the route copies that one value onto every word, so per-word
 *    confidence carries no information a segment-level field wouldn't.
 *  - {@link selectTranscriptionCandidates} — which assets an auto-transcribe
 *    batch should process (speech-bearing media: video + audio, with a File).
 *  - {@link windowSegments} / {@link renderTranscriptDigest} shape a transcript
 *    for the agent observation: windowed to a time range and capped so a
 *    2-hour podcast can't flood the prompt.
 *
 * PURE LOGIC: no Whisper, no IndexedDB, no DOM. The runtime half (decode +
 * worker + persistence) lives in `services/search/asset-transcript-*`.
 */

import type { MediaAsset } from "@/types/assets";
import type { TranscriptionResult } from "@/types/ai";

/**
 * One word with REAL provider alignment, in ASSET-RELATIVE seconds — the same
 * timebase as its parent segment. Structurally identical to `TimedWord` in
 * `lib/auto-cut/filler-detect.ts` on purpose: a stored segment satisfies that
 * module's `DetectableSegment` with no adapter in between.
 */
export interface TranscriptWordLite {
	word: string;
	/** Word start, seconds from the start of the SOURCE media. */
	start: number;
	/** Word end, seconds from the start of the SOURCE media. */
	end: number;
}

/** One spoken segment (roughly a sentence/phrase) in ASSET-RELATIVE seconds. */
export interface TranscriptSegmentLite {
	/** Segment start, seconds from the start of the SOURCE media. */
	start: number;
	/** Segment end, seconds from the start of the SOURCE media. */
	end: number;
	text: string;
	/**
	 * Per-word timings, when the engine supplied them. Absent on records
	 * written before word persistence landed, and on any engine that doesn't
	 * align words — consumers MUST treat this as optional and degrade (see
	 * {@link isWordTimed}).
	 */
	words?: TranscriptWordLite[];
}

/**
 * The per-asset transcript record — the stable contract the Director's
 * `getTranscript` verb and the manifest speech facet consume. An EMPTY
 * `segments` array is a real answer ("transcribed, no speech found"), distinct
 * from the asset having no record at all (not yet transcribed).
 */
export interface AssetTranscript {
	/** Foreign key to `MediaAsset.id` (and this record's primary key in the store). */
	mediaId: string;
	/** Sentence-level segments in asset-relative seconds, time-ordered. */
	segments: TranscriptSegmentLite[];
	/** ISO language code the engine detected/was told. */
	language: string;
	/** Duration of the decoded audio in seconds. */
	durationSec: number;
	/** Which engine produced this ("whisper-local" or a server engine name). */
	engine: string;
	/**
	 * Which transcription style the provider was asked for.
	 *
	 * MATTERS FOR AUTO-CUT: a "clean" transcript has had its filler words
	 * removed by the provider, so there is no "um" left in `text` to find —
	 * filler detection over one reports zero fillers, which reads as "this
	 * speaker has none" when it actually means "we never asked for them".
	 * Absent on records written before this field existed (treat as unknown).
	 */
	style?: "clean" | "verbatim";
	/** When the transcript was produced (epoch ms). */
	createdAt: number;
}

/**
 * True when every non-empty segment carries real per-word timings — i.e. this
 * record can drive WORD MODE filler detection rather than degrading to
 * whole-segment cuts. False for records written before word persistence.
 */
export function isWordTimed(t: AssetTranscript): boolean {
	const speech = t.segments.filter((s) => s.text.trim().length > 0);
	return speech.length > 0 && speech.every((s) => !!s.words?.length);
}

/**
 * True when this record can support mid-sentence filler removal: it needs word
 * timings to localize a cut AND a verbatim style, because a "clean" transcript
 * has no fillers in it to localize. Records predating {@link AssetTranscript.style}
 * report `undefined` style and are treated as unusable here rather than
 * silently producing a confident "no fillers found".
 */
export function supportsFillerRemoval(t: AssetTranscript): boolean {
	return t.style === "verbatim" && isWordTimed(t);
}

/** True when the transcript contains any real speech. */
export function hasSpeech(t: AssetTranscript): boolean {
	return t.segments.some((s) => s.text.trim().length > 0);
}

/** Round a time to whole milliseconds — finer than any cut needs, and it keeps
 *  stored values (and therefore test expectations) free of float dust. */
const toMs = (t: number) => Math.round(t * 1000) / 1000;

/**
 * Normalize one segment's provider words into the stored shape.
 *
 * Drops empty tokens, and CLAMPS every word into its parent segment's span.
 * Clamping shrinks rather than expands on purpose: a word that claims to run
 * past its phrase is bad provider data, and the safe reading of bad data here
 * is the narrower one — {@link fromTranscriptionResult}'s output feeds cut
 * ranges, so over-reaching would eat a neighbouring word's audio, while
 * under-reaching only leaves a few ms of filler behind.
 *
 * Returns `undefined` (not `[]`) when nothing survives, so "engine gave no
 * words" and "engine gave words" stay distinguishable downstream.
 */
function normalizeWords(
	words: readonly { word?: string; start?: number; end?: number }[] | undefined,
	segStart: number,
	segEnd: number,
): TranscriptWordLite[] | undefined {
	if (!words?.length) return undefined;
	const out: TranscriptWordLite[] = [];
	for (const w of words) {
		const word = (w.word ?? "").trim();
		if (!word) continue;
		const start = Math.min(Math.max(w.start ?? segStart, segStart), segEnd);
		const end = Math.min(Math.max(w.end ?? start, start), segEnd);
		out.push({ word, start: toMs(start), end: toMs(end) });
	}
	return out.length > 0 ? out : undefined;
}

/**
 * Adapt the shared {@link TranscriptionResult} into the lean stored record:
 * keep segment timings + text + per-word timings (see module doc), drop empty
 * segments, clamp negative/inverted spans.
 */
export function fromTranscriptionResult(
	mediaId: string,
	result: TranscriptionResult & {
		engine?: string;
		style?: "clean" | "verbatim";
	},
	now: number = Date.now(),
): AssetTranscript {
	const segments: TranscriptSegmentLite[] = [];
	for (const seg of result.segments ?? []) {
		const text = (seg.text ?? "").trim();
		if (!text) continue;
		const start = toMs(Math.max(0, seg.start ?? 0));
		const end = toMs(Math.max(start, seg.end ?? start));
		const words = normalizeWords(seg.words, start, end);
		segments.push(words ? { start, end, text, words } : { start, end, text });
	}
	return {
		mediaId,
		segments,
		language: result.language ?? "en",
		durationSec: result.duration ?? segments.at(-1)?.end ?? 0,
		engine: result.engine ?? "unknown",
		...(result.style ? { style: result.style } : {}),
		createdAt: now,
	};
}

/**
 * Ceiling on the SOURCE duration the AUTO pass will transcribe (seconds).
 * On-device Whisper decodes the whole file to PCM in memory; a feature-length
 * source is an explicit-user-action job (the Captions panel), not something a
 * background pass should silently start. 20 minutes covers essentially every
 * reel-making source while bounding the worst case.
 */
export const AUTO_TRANSCRIBE_MAX_DURATION_SEC = 20 * 60;

export interface SelectTranscriptionCandidatesOptions {
	/** Media ids to skip — already transcribed, attempted, or inflight. Caller-owned. */
	exclude?: ReadonlySet<string>;
	/** Max assets returned (in input order). Omit for "all eligible". */
	cap?: number;
	/** Duration ceiling in seconds (default {@link AUTO_TRANSCRIBE_MAX_DURATION_SEC}). */
	maxDurationSec?: number;
}

/**
 * Filter `assets` down to the ones an auto-transcribe batch should process:
 * speech-bearing media (video/audio — images have nothing to say), with a
 * `file` to decode, under the duration ceiling (an asset with UNKNOWN duration
 * passes — the decode itself is the authority), not excluded — capped at
 * `cap`, preserving input order. Mirrors `selectUnderstandingCandidates` so
 * the two ingest passes share a selection idiom.
 */
export function selectTranscriptionCandidates(
	assets: readonly MediaAsset[],
	options: SelectTranscriptionCandidatesOptions = {},
): MediaAsset[] {
	const { exclude, cap } = options;
	const maxDuration =
		options.maxDurationSec ?? AUTO_TRANSCRIBE_MAX_DURATION_SEC;
	const out: MediaAsset[] = [];
	for (const asset of assets) {
		if (cap !== undefined && out.length >= cap) break;
		if (asset.type !== "video" && asset.type !== "audio") continue;
		if (!asset.file) continue;
		if (asset.duration !== undefined && asset.duration > maxDuration) continue;
		if (exclude?.has(asset.id)) continue;
		out.push(asset);
	}
	return out;
}

/**
 * Segments overlapping the [startSec, endSec] window (either bound optional).
 * A segment counts when any part of it is inside the window — the caller wants
 * "what is being said around here", so partial overlaps matter.
 */
export function windowSegments(
	segments: readonly TranscriptSegmentLite[],
	startSec?: number,
	endSec?: number,
): TranscriptSegmentLite[] {
	const from = startSec ?? Number.NEGATIVE_INFINITY;
	const to = endSec ?? Number.POSITIVE_INFINITY;
	return segments.filter((s) => s.end > from && s.start < to);
}

/** Cap on segments rendered into one agent observation. */
export const DIGEST_SEGMENT_CAP = 120;

export interface TranscriptDigest {
	/** The rendered `[start–end] text` lines, one per included segment. */
	lines: string[];
	/** Segments included (≤ {@link DIGEST_SEGMENT_CAP}). */
	included: number;
	/** Total segments in the (windowed) input. */
	total: number;
	/** True when the cap dropped segments — the agent should re-query a window. */
	truncated: boolean;
}

/**
 * Render segments as compact `[12.4–15.8] text` lines for the agent
 * observation, capped at {@link DIGEST_SEGMENT_CAP}. Timestamps keep one
 * decimal — sentence boundaries don't need more, and stable formatting keeps
 * observations byte-predictable.
 */
export function renderTranscriptDigest(
	segments: readonly TranscriptSegmentLite[],
	cap: number = DIGEST_SEGMENT_CAP,
): TranscriptDigest {
	const included = segments.slice(0, cap);
	return {
		lines: included.map(
			(s) => `[${s.start.toFixed(1)}–${s.end.toFixed(1)}] ${s.text}`,
		),
		included: included.length,
		total: segments.length,
		truncated: segments.length > included.length,
	};
}

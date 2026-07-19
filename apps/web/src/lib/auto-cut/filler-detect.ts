/**
 * Transcript-aware smart-cleanup detectors — filler words and false starts.
 *
 * GRANULARITY (verified against the shipped transcript pipeline before writing
 * this): the persisted per-asset transcript (`AssetTranscript`, see
 * `lib/search/asset-transcript.ts`) carries SENTENCE/PHRASE-level segments
 * ONLY. `fromTranscriptionResult` deliberately drops word-level timings before
 * storage — and even the in-memory `TranscriptionWord[]` the local Whisper path
 * produces (`lib/transcription/local-whisper.ts`) is *synthetic*: phrase text
 * split evenly across the phrase's span, not real per-word ASR alignment
 * (`onnx-community/whisper-*` exports don't carry the cross-attentions word
 * alignment needs). So in practice this module runs in SEGMENT MODE: it can
 * confidently cut a segment whose ENTIRE text is filler ("Um." / "You know,
 * uh...") because its start/end are real timestamps, but it will NOT invent a
 * word boundary inside a longer sentence that isn't backed by real alignment.
 * Mid-sentence filler matches are counted in `undetectableFillerCount`
 * (diagnostic only, never a cut) so the UI can be honest about the limit
 * instead of silently doing nothing.
 *
 * If a caller DOES have real per-word timing for a segment (`words` on the
 * `DetectableSegment`), detection upgrades to WORD MODE for that segment and
 * cuts individual filler words precisely, still never crossing into a
 * neighboring word (see `prePad`/`postPad` clamping below).
 *
 * TIMEBASE: both `AssetTranscript` segments and this module's output ranges
 * are ASSET-RELATIVE seconds — the SAME timebase as a clip's
 * `trimStart`/`trimEnd` and as `EditSegment` (see `./types.ts`'s
 * "SOURCE-relative" doc). No conversion happens here or is needed: a range's
 * `[start, end]` can be handed straight into `./smart-cleanup.ts` or
 * `planAutoCut`/`applyAutoCut` unmodified.
 */

/** Sub-second slop for boundary comparisons (matches engine.ts/apply.ts). */
const EPSILON = 1e-4;

/** Filler words/phrases cut by default. "like" is deliberately NOT here — too
 *  many legitimate (non-filler) uses; see {@link OPTIONAL_FILLER_WORDS}. */
export const DEFAULT_FILLER_WORDS: readonly string[] = [
	"um",
	"uh",
	"erm",
	"you know",
];

/** Opt-in filler words a caller can add via `wordList` — dangerous by default
 *  because they collide with ordinary usage ("like" as a verb/preposition). */
export const OPTIONAL_FILLER_WORDS: readonly string[] = ["like"];

export type CutSource = "filler" | "false-start";
export type CutConfidence = "high" | "low";

/** One proposed cut, in ASSET-RELATIVE seconds — same shape family as
 *  `EditSegment` but carries provenance for UI narration and merge tests. */
export interface FillerCutRange {
	start: number;
	end: number;
	source: CutSource;
	confidence: CutConfidence;
	/** The matched word/phrase (word mode) or whole segment text (segment
	 *  mode / false-start), for UI display and debugging. */
	label: string;
}

export interface FillerDetectOptions {
	/** Filler tokens/phrases to match, case-insensitive. Multi-word phrases
	 *  (e.g. "you know") match as a run of consecutive words. Default
	 *  {@link DEFAULT_FILLER_WORDS}. */
	wordList?: string[];
	/** Seconds of kept padding BEFORE a filler cut. Clamped so it never eats
	 *  into the previous word/segment. Default 0.08 (80ms). */
	prePad?: number;
	/** Seconds of kept padding AFTER a filler cut. Clamped so it never eats
	 *  into the next word/segment. Default 0.08 (80ms). */
	postPad?: number;
	/** Detect false starts (a segment restarted verbatim shortly after).
	 *  Default true. */
	detectFalseStarts?: boolean;
	/** Max gap (seconds) between a false-start attempt and its correction for
	 *  the pair to count. Default 2. */
	falseStartWindowSec?: number;
}

export type ResolvedFillerOptions = Required<FillerDetectOptions>;

const FILLER_DEFAULTS: ResolvedFillerOptions = {
	wordList: [...DEFAULT_FILLER_WORDS],
	prePad: 0.08,
	postPad: 0.08,
	detectFalseStarts: true,
	falseStartWindowSec: 2,
};

/**
 * Merge caller options over the defaults. Keys explicitly present but
 * `undefined` (e.g. a verb/UI passing optional knobs through) must NOT clobber
 * defaults — same idiom as `engine.ts`'s `resolveOptions` (BUG31: strip
 * undefined before spread).
 */
export function resolveFillerOptions(
	options: FillerDetectOptions | undefined,
): ResolvedFillerOptions {
	const resolved: ResolvedFillerOptions = {
		...FILLER_DEFAULTS,
		wordList: [...FILLER_DEFAULTS.wordList],
	};
	if (options) {
		for (const [key, value] of Object.entries(options)) {
			if (value !== undefined) {
				(resolved as Record<string, unknown>)[key] = value;
			}
		}
	}
	return resolved;
}

/** One word with real or synthetic per-word timing (a la `TranscriptionWord`). */
export interface TimedWord {
	word: string;
	start: number;
	end: number;
}

/**
 * One transcript segment as seen by the detector. Shape-compatible with
 * `TranscriptSegmentLite` (segment mode, no `words`) and with a richer
 * `TranscriptionSegment` (word mode, `words` present) — see module doc.
 */
export interface DetectableSegment {
	start: number;
	end: number;
	text: string;
	/** Present only when per-word timing is available for this segment. */
	words?: readonly TimedWord[];
}

export interface FillerDetectionResult {
	ranges: FillerCutRange[];
	/** Filler-token matches found in segment mode that could NOT be safely
	 *  localized to a cut (embedded mid-sentence, no word timing available).
	 *  Diagnostic only — never turned into a cut. */
	undetectableFillerCount: number;
}

function normalizeToken(raw: string): string {
	return raw.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
}

function tokenize(text: string): string[] {
	return text
		.split(/\s+/)
		.map(normalizeToken)
		.filter((t) => t.length > 0);
}

/** A filler phrase as a normalized token sequence, longest-first so greedy
 *  matching prefers multi-word phrases over their single-word prefixes. */
function compilePhrases(wordList: readonly string[]): string[][] {
	return wordList
		.map((phrase) => tokenize(phrase))
		.filter((tokens) => tokens.length > 0)
		.sort((a, b) => b.length - a.length);
}

/** Does `tokens` starting at `i` match `phrase`? */
function matchesAt(tokens: string[], i: number, phrase: string[]): boolean {
	if (i + phrase.length > tokens.length) return false;
	for (let k = 0; k < phrase.length; k++) {
		if (tokens[i + k] !== phrase[k]) return false;
	}
	return true;
}

/** Clamp a padded [start, end] so it never crosses into `floor`/`ceil`. */
function clampPad(
	start: number,
	end: number,
	prePad: number,
	postPad: number,
	floor: number,
	ceil: number,
): { start: number; end: number } {
	const paddedStart = Math.max(start - prePad, floor);
	const paddedEnd = Math.min(end + postPad, ceil);
	return { start: Math.min(paddedStart, end), end: Math.max(paddedEnd, start) };
}

/**
 * WORD MODE for one segment: greedy longest-phrase match over `words`,
 * emitting a high-confidence cut per match, padded but clamped to never touch
 * a neighboring word.
 */
function detectFillerWordsInSegment(
	segment: DetectableSegment,
	words: readonly TimedWord[],
	phrases: string[][],
	opts: ResolvedFillerOptions,
): FillerCutRange[] {
	const tokens = words.map((w) => normalizeToken(w.word));
	const out: FillerCutRange[] = [];
	let i = 0;
	while (i < tokens.length) {
		const phrase = phrases.find((p) => matchesAt(tokens, i, p));
		if (!phrase) {
			i++;
			continue;
		}
		const firstWord = words[i];
		const lastWord = words[i + phrase.length - 1];
		const floor = i > 0 ? words[i - 1].end : segment.start;
		const ceilIdx = i + phrase.length;
		const ceil = ceilIdx < words.length ? words[ceilIdx].start : segment.end;
		const { start, end } = clampPad(
			firstWord.start,
			lastWord.end,
			opts.prePad,
			opts.postPad,
			floor,
			ceil,
		);
		if (end - start > EPSILON) {
			out.push({
				start,
				end,
				source: "filler",
				confidence: "high",
				label: words
					.slice(i, i + phrase.length)
					.map((w) => w.word)
					.join(" "),
			});
		}
		i += phrase.length;
	}
	return out;
}

/**
 * SEGMENT MODE for one segment (no word timing): only cuts when the segment's
 * ENTIRE text reduces to filler phrases (real, unambiguous start/end). Any
 * filler match that leaves non-filler text behind is counted as
 * "undetectable" rather than guessed at.
 */
function detectFillerSegmentWhole(
	segment: DetectableSegment,
	phrases: string[][],
	opts: ResolvedFillerOptions,
	floor: number,
	ceil: number,
): { range: FillerCutRange | null; undetectableCount: number } {
	const tokens = tokenize(segment.text);
	if (tokens.length === 0) return { range: null, undetectableCount: 0 };

	let i = 0;
	let anyMatch = false;
	let allFiller = true;
	while (i < tokens.length) {
		const phrase = phrases.find((p) => matchesAt(tokens, i, p));
		if (phrase) {
			anyMatch = true;
			i += phrase.length;
		} else {
			allFiller = false;
			i++;
		}
	}

	if (!anyMatch) return { range: null, undetectableCount: 0 };

	if (allFiller) {
		const { start, end } = clampPad(
			segment.start,
			segment.end,
			opts.prePad,
			opts.postPad,
			floor,
			ceil,
		);
		return {
			range:
				end - start > EPSILON
					? {
							start,
							end,
							source: "filler",
							confidence: "high",
							label: segment.text.trim(),
						}
					: null,
			undetectableCount: 0,
		};
	}

	// Filler word(s) present but embedded in otherwise-real speech: cannot
	// safely localize a cut at this granularity. Count each filler token run
	// as one undetectable occurrence.
	let occurrences = 0;
	i = 0;
	while (i < tokens.length) {
		const phrase = phrases.find((p) => matchesAt(tokens, i, p));
		if (phrase) {
			occurrences++;
			i += phrase.length;
		} else {
			i++;
		}
	}
	return { range: null, undetectableCount: occurrences };
}

/**
 * Detect filler-word cut candidates across a transcript's segments. Segments
 * with real per-word timing (`words` present, non-empty) use WORD MODE;
 * everything else degrades to SEGMENT MODE (see module doc for what that
 * means in practice on this codebase's stored transcripts).
 */
export function detectFillers(
	segments: readonly DetectableSegment[],
	options?: FillerDetectOptions,
): FillerDetectionResult {
	const opts = resolveFillerOptions(options);
	const phrases = compilePhrases(opts.wordList);
	const ranges: FillerCutRange[] = [];
	let undetectableFillerCount = 0;

	for (let s = 0; s < segments.length; s++) {
		const segment = segments[s];
		if (segment.words && segment.words.length > 0) {
			ranges.push(
				...detectFillerWordsInSegment(segment, segment.words, phrases, opts),
			);
			continue;
		}
		const floor = s > 0 ? segments[s - 1].end : segment.start;
		const ceil = s < segments.length - 1 ? segments[s + 1].start : segment.end;
		const { range, undetectableCount } = detectFillerSegmentWhole(
			segment,
			phrases,
			opts,
			floor,
			ceil,
		);
		if (range) ranges.push(range);
		undetectableFillerCount += undetectableCount;
	}

	return { ranges, undetectableFillerCount };
}

/**
 * Detect false starts: a segment whose words are a strict, shorter prefix of
 * the very next segment's words, within `falseStartWindowSec` of it — i.e.
 * "I want to— I want to go home" where the first attempt is abandoned and
 * restarted verbatim. The aborted attempt is cut; always LOW confidence (this
 * is a text heuristic, not a semantic judgment) so the UI/Director can gate it
 * behind an explicit opt-in or a review step.
 */
export function detectFalseStarts(
	segments: readonly DetectableSegment[],
	options?: FillerDetectOptions,
): FillerCutRange[] {
	const opts = resolveFillerOptions(options);
	if (!opts.detectFalseStarts) return [];

	const out: FillerCutRange[] = [];
	for (let i = 0; i < segments.length - 1; i++) {
		const attempt = segments[i];
		const retry = segments[i + 1];
		const gap = retry.start - attempt.end;
		if (gap < 0 || gap > opts.falseStartWindowSec) continue;

		const attemptTokens = tokenize(attempt.text);
		const retryTokens = tokenize(retry.text);
		if (attemptTokens.length < 2) continue; // avoid 1-word false positives
		if (attemptTokens.length >= retryTokens.length) continue; // must be shorter

		let isPrefix = true;
		for (let k = 0; k < attemptTokens.length; k++) {
			if (attemptTokens[k] !== retryTokens[k]) {
				isPrefix = false;
				break;
			}
		}
		if (!isPrefix) continue;

		const floor = i > 0 ? segments[i - 1].end : attempt.start;
		const { start, end } = clampPad(
			attempt.start,
			attempt.end,
			opts.prePad,
			opts.postPad,
			floor,
			retry.start,
		);
		if (end - start > EPSILON) {
			out.push({
				start,
				end,
				source: "false-start",
				confidence: "low",
				label: attempt.text.trim(),
			});
		}
	}
	return out;
}

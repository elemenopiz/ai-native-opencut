/**
 * Auto-cut (silence / dead-air removal) — shared contract.
 *
 * Algorithm ported from auto-editor (github.com/WyattBlue/auto-editor,
 * Unlicense / public domain): per-timebase-chunk loudness → threshold →
 * asymmetric margin padding → min-run smoothing → labeled segments.
 * TypeScript reimplementation of the algorithm design, not a code port
 * (upstream is Nim).
 *
 * Pipeline order matters and mirrors upstream `conductor.nim`:
 *   threshold → margin (mutMargin) → smoothing (minclip/mincut) → chunkify.
 */

/** What to do with a segment of the source. */
export type SegmentAction =
	| { type: "keep" }
	| { type: "cut" }
	/** Multi-label output: play the segment at `speed` instead of cutting it. */
	| { type: "speed"; speed: number };

/**
 * One labeled span of the analyzed source, in SOURCE-relative seconds
 * (i.e. relative to the start of the media file, ignoring any timeline
 * trims — callers map source→timeline themselves). Segments are
 * contiguous, sorted, and cover the full analyzed range.
 */
export interface EditSegment {
	/** Inclusive start, seconds from source start. */
	start: number;
	/** Exclusive end, seconds from source start. */
	end: number;
	action: SegmentAction;
}

export interface AutoCutOptions {
	/**
	 * Analysis chunks per second (upstream "timebase"). Default 30.
	 * Loudness is max(|sample|) per chunk, normalized to [0, 1].
	 */
	timebase?: number;
	/** Loudness threshold in [0, 1]; chunk is "loud" when level >= threshold. Default 0.04 (upstream default). */
	threshold?: number;
	/**
	 * Seconds of kept padding added BEFORE each loud region (upstream
	 * startMargin — protects speech onsets). Default 0.2. Negative shrinks.
	 */
	marginBefore?: number;
	/**
	 * Seconds of kept padding added AFTER each loud region (upstream
	 * endMargin — protects trailing speech). Default 0.3. Negative shrinks.
	 */
	marginAfter?: number;
	/** Drop kept runs shorter than this many seconds (upstream minclip). Default 0.26. */
	minKeep?: number;
	/** Fill (un-cut) silent runs shorter than this many seconds (upstream mincut). Default 0.4. */
	minCut?: number;
	/**
	 * What to do with silence: hard cut (default) or a speed-up label
	 * (multi-label output; upstream --silent-speed).
	 */
	silentAction?: "cut" | "speed";
	/** Playback speed for silent segments when silentAction === "speed". Default 4. */
	silentSpeed?: number;
}

/** AutoCutOptions with every field required — post-defaulting shape. */
export type ResolvedAutoCutOptions = Required<AutoCutOptions>;

export interface AutoCutAnalysis {
	segments: EditSegment[];
	/** Normalized [0,1] per-chunk loudness curve the decision was made from. */
	loudness: Float32Array;
	/** Chunks per second actually used. */
	timebase: number;
	/** Total analyzed duration, seconds. */
	duration: number;
	options: ResolvedAutoCutOptions;
}

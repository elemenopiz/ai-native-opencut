/**
 * `readMix` — a read-only audio analysis the Director can reason over instead
 * of guessing (`docs/plans/2026-09-18-director-autonomy-architecture.md` §4:
 * "the agent cannot see its own work" / "Read the mix — loudness curve,
 * speech/music overlap — rather than assuming."). Audio sibling of
 * `watchBack` (the visual half of the same "give it eyes" pillar, §7 of that
 * doc) — this module feeds `edit-critic.ts`'s judgement so it accounts for
 * the mix, not just the picture.
 *
 * WIRED AS THE `readMix` VERB (polish phase). This module stays pure — it
 * takes already-decoded PCM and returns a reading — and `director-api.ts`
 * owns the decode seam (`mixAudio.decode`) that feeds it. Polish is where it
 * lives because every remedy a reading can point at (`duckMusicUnderSpeech`,
 * `removeSilence`, `tightenToLength`) is polish-only; diagnosis and remedy
 * have to be reachable in the same bucket or the read is a dead end.
 *
 * REUSE, NOT REIMPLEMENT — every figure here composes an existing module:
 *  - The loudness curve reuses `lib/auto-cut/engine.ts`'s `computeLoudness`
 *    VERBATIM (same max(|sample|)-per-chunk analysis `detectSilenceSegments`
 *    already runs for auto-cut), just called at a coarser, mix-scale interval
 *    instead of its 30-chunks/sec cut-detection default — see
 *    {@link DEFAULT_LOUDNESS_SAMPLE_INTERVAL_SEC} for why.
 *  - Dead air reuses `detectSilenceSegments` (same module) directly: its
 *    non-"keep" segments (auto-editor's own silence/dead-air algorithm —
 *    threshold → margin → smoothing → chunkify) ARE the dead-air stretches
 *    reported here, just relabeled and merged across action-type boundaries.
 *  - Speech/music overlap is scored against THIS CODEBASE'S OWN definition of
 *    "properly ducked" — `craft/duck-music-under-speech.ts`'s
 *    `DEFAULT_DUCK_AMOUNT_DB` — and consumes the exact SAME
 *    `SpeechInterval[]`/`DuckMusicElement[]` shapes that macro takes (and, in
 *    production, the same `director-api.ts` gatherers —
 *    `gatherSpeechIntervals`/`gatherMusicElements` — feed both), so a future
 *    verb wiring can share one gather pass across `duckMusicUnderSpeech` and
 *    `readMix`.
 *  - The integrated, LUFS-style figure re-derives the SAME gated-block
 *    algorithm `hooks/use-loudness-normalization.ts`'s `measureLUFS` already
 *    ships (400ms blocks, absolute -70 gate, -10LU relative gate) as a pure
 *    `Float32Array` function. That hook's version takes a browser
 *    `AudioBuffer` and decodes via `AudioContext` — out of this module's
 *    "no browser" contract, and `use-loudness-normalization.ts` is out of
 *    this task's file scope — so the FORMULA is ported here, not imported.
 *    Returns the same `LUFSMeasurement` shape (`lib/audio/loudness-types.ts`)
 *    so a caller can show it next to the panel's own numbers with no units
 *    mismatch.
 *
 * UNITS (chosen once, everything else composes on it — see the repo's own
 * "if they disagree on units, normalize and say which you picked" ask):
 *  - `loudnessCurve[].levelDb` and every `*Db` figure on a
 *    {@link MusicSpeechOverlap} are plain dBFS amplitude ratios
 *    (`20*log10(|sample|)`), derived from `computeLoudness`'s max-abs-per-
 *    chunk signal — cheap enough to run at every curve/overlap sample point.
 *  - `integratedLoudness` (the `LUFSMeasurement`) is LUFS-STYLE (gated
 *    mean-square blocks) — a DIFFERENT scale than the dBFS figures above
 *    (LUFS approximates perceived loudness from signal ENERGY; the dBFS
 *    figures here are raw PEAK-per-chunk ratios). Paid for once, as the
 *    headline integrated figure, not per sample point. Never compare a
 *    `levelDb`/`competingDb` number directly against `integratedLoudness`'s
 *    fields as if they were the same scale.
 *
 * DETERMINISTIC + PURE: no network, no React, no browser decode, no model
 * call — same discipline `lib/auto-cut/engine.ts` and `craft/*.ts` use.
 * Caller supplies already-decoded PCM (mirrors `detectSilenceSegments`'s own
 * `samples`/`sampleRate` contract); real browser decode (`AudioContext` /
 * `decodeAudioData`) is a separate, later wiring concern — same "pure plan
 * here, decode at the call site" split `director-api.ts`'s `critiqueEdit`
 * already keeps for frame decode (`options.frames?.decode`).
 */

import type { LUFSMeasurement } from "@/lib/audio/loudness-types";
import { computeLoudness, detectSilenceSegments } from "@/lib/auto-cut/engine";
import type { AutoCutOptions } from "@/lib/auto-cut/types";
import {
	CRAFT_EPSILON,
	DEFAULT_DUCK_AMOUNT_DB,
	DEFAULT_MERGE_GAP_SEC,
	roundSec,
	type DuckMusicElement,
	type SpeechInterval,
} from "./craft";

// ── shared small range helpers (local — see duck-music-under-speech.ts's own
//    mergeIntervals for the sibling "sort + merge touching/overlapping
//    ranges" pattern this mirrors; not exported there, so reimplemented here
//    at the same small scale rather than widening that module's exports) ───

interface RangeSec {
	startSec: number;
	endSec: number;
}

function clamp(value: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, value));
}

/** Sort + merge touching/overlapping ranges. Assumes nothing about input order. */
/**
 * Sort and merge ranges, bridging any gap of `maxGapSec` or less.
 *
 * The gap is a PARAMETER rather than `CRAFT_EPSILON` because the two are
 * different ideas: `CRAFT_EPSILON` (1e-4) answers "are these two floats the
 * same number?", while bridging asks "are these two speech bursts one
 * passage?". Callers measuring against a duck pass that verb's own
 * `DEFAULT_MERGE_GAP_SEC` so both segment the timeline identically; see the
 * call site in `computeSpeechMusicOverlaps`.
 */
function mergeRanges(ranges: RangeSec[], maxGapSec: number): RangeSec[] {
	if (ranges.length === 0) return [];
	const sorted = [...ranges].sort((a, b) => a.startSec - b.startSec);
	const merged: RangeSec[] = [{ ...sorted[0] }];
	for (let i = 1; i < sorted.length; i++) {
		const last = merged[merged.length - 1];
		const cur = sorted[i];
		if (cur.startSec - last.endSec <= maxGapSec) {
			last.endSec = Math.max(last.endSec, cur.endSec);
		} else {
			merged.push({ ...cur });
		}
	}
	return merged;
}

/** The complement of already-sorted/merged `holes` within `whole`. */
function subtractRanges(whole: RangeSec, holes: RangeSec[]): RangeSec[] {
	const out: RangeSec[] = [];
	let cursor = whole.startSec;
	for (const hole of holes) {
		if (hole.startSec > cursor + CRAFT_EPSILON) {
			out.push({ startSec: cursor, endSec: hole.startSec });
		}
		cursor = Math.max(cursor, hole.endSec);
	}
	if (whole.endSec > cursor + CRAFT_EPSILON) {
		out.push({ startSec: cursor, endSec: whole.endSec });
	}
	return out;
}

// ── loudness curve (dBFS, sampled — not per-frame) ──────────────────────────

/** Normalized-amplitude floor treated as silence, in dBFS (`level === 0` would otherwise be `-Infinity`). */
export const DB_FLOOR = -90;

function amplitudeToDb(level: number): number {
	return level > 0 ? 20 * Math.log10(level) : DB_FLOOR;
}

/**
 * Default loudness-curve sample interval, seconds (2 samples/sec).
 *
 * WHY 0.5s, not per-frame: a video frame is ~0.017–0.042s (24–60fps) —
 * sampling every frame would mostly encode video-frame-rate noise, not audio
 * dynamics, and would blow up the point count (and therefore the critic's
 * context budget) for anything longer than a few seconds. 0.5s is still
 * finer than `duckMusicUnderSpeech`'s own ramp durations
 * (`DEFAULT_ATTACK_SEC`/`DEFAULT_RELEASE_SEC` in
 * `craft/duck-music-under-speech.ts` — 0.15s/0.4s), so a ducking move's
 * SHAPE (recede → hold → recover) still reads as a trend across a handful of
 * points, while keeping a 3-minute cut to ~360 curve points — the same
 * token-economy discipline this file's sibling `edit-critic.ts` applies via
 * its own `MAX_*` caps.
 */
export const DEFAULT_LOUDNESS_SAMPLE_INTERVAL_SEC = 0.5;

/** One sampled point on the loudness curve. */
export interface LoudnessSamplePoint {
	/** Timeline-absolute seconds (sample midpoint). */
	atSec: number;
	/** dBFS, `20*log10(|sample|)` — see the module docblock's UNITS note. */
	levelDb: number;
}

/**
 * Sample the mix's loudness curve every `intervalSec` seconds by calling
 * `lib/auto-cut/engine.ts`'s `computeLoudness` at `1/intervalSec` chunks per
 * second (that function's own `timebase` parameter), then converting its
 * normalized-amplitude output to dBFS. Reuses the exact chunking/rounding-
 * error-tracking algorithm auto-cut's silence detection runs — just at a
 * coarser rate.
 */
export function computeLoudnessCurveDb(
	samples: Float32Array,
	sampleRate: number,
	intervalSec: number = DEFAULT_LOUDNESS_SAMPLE_INTERVAL_SEC,
): LoudnessSamplePoint[] {
	if (samples.length === 0 || sampleRate <= 0 || intervalSec <= 0) return [];
	const chunksPerSecond = 1 / intervalSec;
	const levels = computeLoudness(samples, sampleRate, chunksPerSecond);
	const points: LoudnessSamplePoint[] = new Array(levels.length);
	for (let i = 0; i < levels.length; i++) {
		points[i] = {
			atSec: roundSec((i + 0.5) * intervalSec),
			levelDb: amplitudeToDb(levels[i]),
		};
	}
	return points;
}

/** Power-domain (not arithmetic-mean-of-dB) average of the curve's points falling in any of `windows` — the correct way to average dB ratios. `undefined` when no point falls in any window. */
function averageDbAcrossWindows(
	curve: LoudnessSamplePoint[],
	windows: RangeSec[],
): number | undefined {
	let sumPower = 0;
	let count = 0;
	for (const p of curve) {
		for (const w of windows) {
			if (p.atSec >= w.startSec && p.atSec < w.endSec) {
				sumPower += 10 ** (p.levelDb / 10);
				count++;
				break;
			}
		}
	}
	if (count === 0) return undefined;
	const avgPower = sumPower / count;
	return avgPower > 0 ? 10 * Math.log10(avgPower) : DB_FLOOR;
}

function round1(value: number): number {
	return Math.round(value * 10) / 10;
}

// ── integrated LUFS-style figure (ported from measureLUFS, pure PCM in) ────

const LUFS_BLOCK_SEC = 0.4;
const LUFS_ABSOLUTE_GATE_DB = -70;
const LUFS_RELATIVE_GATE_OFFSET_DB = -10;

/**
 * Integrated (+ short-term/momentary/true-peak/range) loudness, same gated-
 * block algorithm `use-loudness-normalization.ts`'s `measureLUFS` ships
 * (400ms blocks, mean-square → dB, absolute -70dB gate, then a second pass
 * gated at `shortTerm - 10`), ported to take raw mono PCM (`Float32Array` +
 * `sampleRate`) instead of a browser `AudioBuffer` so it runs without
 * `AudioContext`/`decodeAudioData`. NOT true K-weighted ITU-R BS.1770 LUFS —
 * same simplification the existing panel already ships (see the module
 * docblock's UNITS note) — but the same figure, computed the same way, so
 * the two are comparable if ever shown together.
 */
export function computeIntegratedLoudness(
	samples: Float32Array,
	sampleRate: number,
): LUFSMeasurement {
	if (samples.length === 0 || sampleRate <= 0) {
		return {
			integrated: LUFS_ABSOLUTE_GATE_DB,
			shortTerm: LUFS_ABSOLUTE_GATE_DB,
			momentary: LUFS_ABSOLUTE_GATE_DB,
			truePeak: DB_FLOOR,
			range: 0,
		};
	}

	const blockSize = Math.max(1, Math.round(sampleRate * LUFS_BLOCK_SEC));
	const blockLoudness: number[] = [];
	let maxMomentary = -Infinity;
	let maxTruePeak = 0;

	for (let i = 0; i < samples.length; i += blockSize) {
		const end = Math.min(i + blockSize, samples.length);
		let sum = 0;
		let peak = 0;
		for (let j = i; j < end; j++) {
			const s = samples[j];
			sum += s * s;
			const abs = Math.abs(s);
			if (abs > peak) peak = abs;
		}
		const rms = sum / (end - i);
		const loudness = 10 * Math.log10(rms + 1e-10);
		blockLoudness.push(loudness);
		if (loudness > maxMomentary) maxMomentary = loudness;
		if (peak > maxTruePeak) maxTruePeak = peak;
	}

	const validBlocks = blockLoudness.filter((l) => l > LUFS_ABSOLUTE_GATE_DB);
	const gatedLoudness =
		validBlocks.length > 0
			? validBlocks.reduce((a, b) => a + b, 0) / validBlocks.length
			: LUFS_ABSOLUTE_GATE_DB;

	const threshold = gatedLoudness + LUFS_RELATIVE_GATE_OFFSET_DB;
	const finalBlocks = validBlocks.filter((l) => l > threshold);
	const integrated =
		finalBlocks.length > 0
			? finalBlocks.reduce((a, b) => a + b, 0) / finalBlocks.length
			: LUFS_ABSOLUTE_GATE_DB;

	return {
		integrated: round1(integrated),
		shortTerm: round1(gatedLoudness),
		momentary: round1(
			maxMomentary === -Infinity ? LUFS_ABSOLUTE_GATE_DB : maxMomentary,
		),
		truePeak: round1(20 * Math.log10(maxTruePeak + 1e-10)),
		range: round1(
			finalBlocks.length > 0
				? Math.max(...finalBlocks) - Math.min(...finalBlocks)
				: 0,
		),
	};
}

// ── dead air / silence (reuses detectSilenceSegments verbatim) ─────────────

/** One stretch of the timeline with no meaningful audio content (auto-cut's non-"keep" segments). */
export interface DeadAirStretch {
	startSec: number;
	endSec: number;
	durationSec: number;
}

/**
 * Dead-air stretches, straight from `lib/auto-cut/engine.ts`'s
 * `detectSilenceSegments` — the same silence/margin/smoothing algorithm
 * `removeSilence`'s auto-cut pipeline already runs (POACH-LEDGER.md row for
 * the auto-editor port). Every non-"keep" segment (cut, or speed-up when
 * `options.silence?.silentAction === "speed"`) IS a dead-air stretch here;
 * adjacent non-"keep" segments of DIFFERENT action types (e.g. a cut run
 * right up against a speed-up run) are merged too, since both read as "no
 * meaningful audio" regardless of the silence-handling policy behind them —
 * `detectSilenceSegments` itself only merges adjacent SAME-action segments.
 */
export function computeDeadAirStretches(
	samples: Float32Array,
	sampleRate: number,
	durationSec: number,
	options?: AutoCutOptions,
): DeadAirStretch[] {
	const analysis = detectSilenceSegments(samples, sampleRate, options);
	const stretches: DeadAirStretch[] = [];
	for (const seg of analysis.segments) {
		if (seg.action.type === "keep") continue;
		if (seg.end - seg.start <= CRAFT_EPSILON) continue;
		const last = stretches[stretches.length - 1];
		if (last && seg.start - last.endSec <= CRAFT_EPSILON) {
			last.endSec = Math.min(seg.end, durationSec);
			last.durationSec = last.endSec - last.startSec;
		} else {
			const end = Math.min(seg.end, durationSec);
			stretches.push({
				startSec: seg.start,
				endSec: end,
				durationSec: end - seg.start,
			});
		}
	}
	return stretches;
}

// ── speech/music overlap ("how much is the music competing") ───────────────

/**
 * One stretch where a music-bed element and speech overlap, and how loud the
 * mix measures there relative to what a PROPER duck would look like.
 */
export interface MusicSpeechOverlap {
	musicElementId: string;
	/** Timeline-absolute seconds. */
	startSec: number;
	endSec: number;
	durationSec: number;
	/** Measured average level (dBFS) during this overlap window. */
	avgLevelDb: number;
	/** This music element's own "resting" level (dBFS) outside any speech overlap within its span — the reference `duckMusicUnderSpeech` would duck FROM. */
	musicBaselineDb: number;
	/**
	 * `avgLevelDb - (musicBaselineDb + DEFAULT_DUCK_AMOUNT_DB)` — positive
	 * means the mix is measured LOUDER than this codebase's own "properly
	 * ducked" target during this overlap (music is plausibly competing with
	 * speech); near-zero or negative reads as already ducked (or naturally
	 * quiet) here. A HEURISTIC, not a stem-separated measurement — see the
	 * function doc below for why.
	 */
	competingDb: number;
}

/** Analysis interval used internally to average level across an overlap window — finer than the headline curve (not itself returned in bulk), coarse enough to be cheap. */
export const DEFAULT_OVERLAP_ANALYSIS_INTERVAL_SEC = 0.1;

/**
 * Find every stretch where a `musicElements` span and a `speechIntervals`
 * span overlap, and estimate how much the music is competing with speech
 * there.
 *
 * APPROXIMATION, clearly labeled: this module has ONE mixed-down PCM buffer,
 * not isolated stems (per-source separation is still a `HUNT`, not built —
 * `POACH-LEDGER.md`'s "Stem separation" row), so "how loud is the music
 * ALONE" can't be measured directly during an overlap. Instead each music
 * element's own baseline is measured from ITS OWN non-overlapping stretch
 * (where nothing sourced from `speechIntervals` plays over it) as a proxy
 * for "what this bed sits at when nobody's talking", and `competingDb`
 * compares the overlap's measured level against that baseline shifted by
 * `DEFAULT_DUCK_AMOUNT_DB` — the SAME dB amount `duckMusicUnderSpeech`
 * itself plans as "properly ducked" (`craft/duck-music-under-speech.ts`).
 * When an element overlaps speech for its ENTIRE span (no unmixed stretch to
 * measure), the baseline falls back to the whole timeline's average level —
 * a coarser proxy, but still a number rather than a gap.
 */
export function computeSpeechMusicOverlaps(input: {
	samples: Float32Array;
	sampleRate: number;
	durationSec: number;
	speechIntervals: SpeechInterval[];
	musicElements: DuckMusicElement[];
	/** Override {@link DEFAULT_OVERLAP_ANALYSIS_INTERVAL_SEC}. */
	analysisIntervalSec?: number;
}): MusicSpeechOverlap[] {
	const { samples, sampleRate, durationSec, speechIntervals, musicElements } =
		input;
	if (musicElements.length === 0 || speechIntervals.length === 0) return [];

	const intervalSec = Math.max(
		CRAFT_EPSILON,
		input.analysisIntervalSec ?? DEFAULT_OVERLAP_ANALYSIS_INTERVAL_SEC,
	);
	const curve = computeLoudnessCurveDb(samples, sampleRate, intervalSec);
	if (curve.length === 0) return [];

	const wholeTimelineDb = averageDbAcrossWindows(curve, [
		{ startSec: 0, endSec: durationSec },
	]);

	const overlaps: MusicSpeechOverlap[] = [];
	for (const music of musicElements) {
		const elStart = clamp(music.startSec, 0, durationSec);
		const elEnd = clamp(music.startSec + music.durationSec, 0, durationSec);
		if (elEnd - elStart <= CRAFT_EPSILON) continue;

		const rawOverlaps: RangeSec[] = [];
		for (const speech of speechIntervals) {
			const os = Math.max(speech.startSec, elStart);
			const oe = Math.min(speech.endSec, elEnd);
			if (oe - os > CRAFT_EPSILON)
				rawOverlaps.push({ startSec: os, endSec: oe });
		}
		if (rawOverlaps.length === 0) continue;
		// Merge with the DUCK VERB's gap, not a float epsilon: this function
		// reports how far the mix sits from what `duckMusicUnderSpeech` would
		// produce, so it has to group speech into the same windows that verb
		// would duck. Two bursts a breath apart are one duck — releasing and
		// re-ducking across a 50ms gap is the pumping artifact `mergeGapSec`
		// exists to prevent.
		const merged = mergeRanges(rawOverlaps, DEFAULT_MERGE_GAP_SEC);

		const nonOverlap = subtractRanges(
			{ startSec: elStart, endSec: elEnd },
			merged,
		);
		const musicBaselineDb =
			averageDbAcrossWindows(curve, nonOverlap) ?? wholeTimelineDb ?? DB_FLOOR;

		for (const window of merged) {
			const avgLevelDb = averageDbAcrossWindows(curve, [window]) ?? DB_FLOOR;
			overlaps.push({
				musicElementId: music.elementId,
				startSec: roundSec(window.startSec),
				endSec: roundSec(window.endSec),
				durationSec: roundSec(window.endSec - window.startSec),
				avgLevelDb: round1(avgLevelDb),
				musicBaselineDb: round1(musicBaselineDb),
				competingDb: round1(
					avgLevelDb - (musicBaselineDb + DEFAULT_DUCK_AMOUNT_DB),
				),
			});
		}
	}

	overlaps.sort((a, b) => a.startSec - b.startSec);
	return overlaps;
}

// ── readMix — the composed report ───────────────────────────────────────────

export interface MixReadInput {
	/** Already-decoded mono PCM for the mixed timeline (or the best-available proxy) — same contract `detectSilenceSegments` takes. */
	samples: Float32Array;
	sampleRate: number;
	/** Total timeline duration, seconds — every reported range is within `[0, durationSec]`. */
	durationSec: number;
	/** TIMELINE-absolute speech intervals — same shape `duckMusicUnderSpeech` takes (production gatherer: `director-api.ts`'s `gatherSpeechIntervals`). */
	speechIntervals: SpeechInterval[];
	/** Music-bed elements — same shape `duckMusicUnderSpeech` takes (production gatherer: `director-api.ts`'s `gatherMusicElements`). */
	musicElements: DuckMusicElement[];
	/** Override {@link DEFAULT_LOUDNESS_SAMPLE_INTERVAL_SEC}. */
	loudnessSampleIntervalSec?: number;
	/** Override {@link DEFAULT_OVERLAP_ANALYSIS_INTERVAL_SEC}. */
	overlapAnalysisIntervalSec?: number;
	/** Forwarded unchanged to `detectSilenceSegments` for dead-air detection. */
	silence?: AutoCutOptions;
}

/** The composed, plain-serializable mix read. */
export interface MixRead {
	loudnessCurve: LoudnessSamplePoint[];
	/** The interval actually used for `loudnessCurve` (echoes back the resolved default/override). */
	loudnessSampleIntervalSec: number;
	/** LUFS-style figure — see the module docblock's UNITS note before comparing this to `loudnessCurve`/`overlaps` dB figures. */
	integratedLoudness: LUFSMeasurement;
	overlaps: MusicSpeechOverlap[];
	deadAir: DeadAirStretch[];
}

/**
 * Compose the whole mix read: loudness curve, integrated LUFS-style figure,
 * speech/music overlap, and dead air — see the module docblock for which
 * existing module backs each piece. Pure; safe to call from a unit test with
 * synthetic PCM.
 */
export function readMix(input: MixReadInput): MixRead {
	const loudnessSampleIntervalSec =
		input.loudnessSampleIntervalSec ?? DEFAULT_LOUDNESS_SAMPLE_INTERVAL_SEC;

	return {
		loudnessCurve: computeLoudnessCurveDb(
			input.samples,
			input.sampleRate,
			loudnessSampleIntervalSec,
		),
		loudnessSampleIntervalSec,
		integratedLoudness: computeIntegratedLoudness(
			input.samples,
			input.sampleRate,
		),
		overlaps: computeSpeechMusicOverlaps({
			samples: input.samples,
			sampleRate: input.sampleRate,
			durationSec: input.durationSec,
			speechIntervals: input.speechIntervals,
			musicElements: input.musicElements,
			analysisIntervalSec: input.overlapAnalysisIntervalSec,
		}),
		deadAir: computeDeadAirStretches(
			input.samples,
			input.sampleRate,
			input.durationSec,
			input.silence,
		),
	};
}

/**
 * Auto-cut pure core — a faithful TypeScript reimplementation of auto-editor's
 * silence-detection algorithm (github.com/WyattBlue/auto-editor, Unlicense).
 *
 * Pipeline (mirrors upstream `conductor.nim`):
 *   loudness → threshold → margin (mutMargin) → smoothing → chunkify.
 *
 * All internal reasoning is done in TIMEBASE TICKS (one tick = one analysis
 * chunk); margins/min-runs are converted from seconds to ticks up front, and
 * tick indices are mapped back to seconds only when emitting segments.
 */

import type {
	AutoCutAnalysis,
	AutoCutOptions,
	EditSegment,
	ResolvedAutoCutOptions,
} from "./types";

const DEFAULTS: ResolvedAutoCutOptions = {
	timebase: 30,
	threshold: 0.04,
	marginBefore: 0.2,
	marginAfter: 0.3,
	minKeep: 0.26,
	minCut: 0.4,
	silentAction: "cut",
	silentSpeed: 4,
};

/** Merge caller options over the upstream defaults. */
export function resolveOptions(
	options: AutoCutOptions | undefined,
): ResolvedAutoCutOptions {
	return { ...DEFAULTS, ...(options ?? {}) };
}

/**
 * Per-chunk loudness curve: chunk the mono PCM into `sampleRate / timebase`
 * samples per chunk (tracking fractional rounding error across chunks so the
 * chunk count matches the true duration, exactly like upstream
 * `analyze/audio.nim`), and take max(|sample|) per chunk.
 *
 * Samples from Web Audio are already float in [-1, 1], so the max-abs value is
 * already the normalized [0, 1] level — no int16 rescale like upstream needs.
 */
export function computeLoudness(
	samples: Float32Array,
	sampleRate: number,
	timebase: number,
): Float32Array {
	const total = samples.length;
	if (total === 0) return new Float32Array(0);

	const exactSize = sampleRate / timebase;
	// How many chunks the duration spans, so the curve length matches upstream.
	const chunkCount = Math.max(1, Math.round(total / exactSize));
	const levels = new Float32Array(chunkCount);

	let accumulatedError = 0;
	let start = 0;
	for (let c = 0; c < chunkCount; c++) {
		const sizeWithError = exactSize + accumulatedError;
		let size = Math.round(sizeWithError);
		accumulatedError = sizeWithError - size;
		// Clamp so we never read past the buffer; the final chunk absorbs any
		// remainder from rounding so every sample is covered exactly once.
		if (c === chunkCount - 1 || start + size > total) {
			size = total - start;
		}
		if (size <= 0) {
			levels[c] = 0;
			continue;
		}

		let maxAbs = 0;
		const end = start + size;
		for (let i = start; i < end; i++) {
			const v = Math.abs(samples[i]);
			if (v > maxAbs) {
				maxAbs = v;
				if (maxAbs >= 1) break;
			}
		}
		levels[c] = maxAbs > 1 ? 1 : maxAbs;
		start = end;
	}

	return levels;
}

/** `keep[i] = level[i] >= threshold` — the base boolean signal. */
export function thresholdLevels(
	levels: Float32Array,
	threshold: number,
): boolean[] {
	const keep = new Array<boolean>(levels.length);
	for (let i = 0; i < levels.length; i++) {
		keep[i] = levels[i] >= threshold;
	}
	return keep;
}

/**
 * Boolean-array combinators, so a future second signal (e.g. motion) can be
 * fused with `or`/`and`/`xor`/`not` before margin/smoothing. NOT a DSL — just
 * the element-wise ops upstream's `--edit` expression evaluates to.
 */
export const boolOps = {
	not(a: boolean[]): boolean[] {
		return a.map((x) => !x);
	},
	and(a: boolean[], b: boolean[]): boolean[] {
		return a.map((x, i) => x && b[i]);
	},
	or(a: boolean[], b: boolean[]): boolean[] {
		return a.map((x, i) => x || b[i]);
	},
	xor(a: boolean[], b: boolean[]): boolean[] {
		return a.map((x, i) => x !== b[i]);
	},
};

/**
 * Asymmetric margin padding — verbatim port of upstream `mutMargin`
 * (util/fun.nim). Transitions are collected ONCE up front, then each margin is
 * applied against those original transition indices (order matters). Mutates
 * `arr` in place.
 *
 * - startM > 0 grows kept region backward before each rising edge; < 0 shrinks.
 * - endM   > 0 grows kept region forward after each falling edge; < 0 shrinks.
 */
export function mutMargin(arr: boolean[], startM: number, endM: number): void {
	const startIndex: number[] = [];
	const endIndex: number[] = [];
	const arrlen = arr.length;
	for (let j = 1; j < arrlen; j++) {
		if (arr[j] !== arr[j - 1]) {
			if (arr[j]) startIndex.push(j);
			else endIndex.push(j);
		}
	}

	if (startM > 0) {
		for (const i of startIndex) {
			for (let k = Math.max(i - startM, 0); k < i; k++) arr[k] = true;
		}
	}
	if (startM < 0) {
		for (const i of startIndex) {
			for (let k = i; k < Math.min(i - startM, arrlen); k++) arr[k] = false;
		}
	}
	if (endM > 0) {
		for (const i of endIndex) {
			for (let k = i; k < Math.min(i + endM, arrlen); k++) arr[k] = true;
		}
	}
	if (endM < 0) {
		for (const i of endIndex) {
			for (let k = Math.max(i + endM, 0); k < i; k++) arr[k] = false;
		}
	}
}

/** Structural equality for the boolean run arrays. */
function boolArrayEqual(a: boolean[], b: boolean[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

/**
 * Min-run smoothing — verbatim port of upstream `smoothing(val, mincut,
 * minclip)` (util/fun.nim). `minclip` flips TRUE runs strictly shorter than
 * `minclip` ticks to false; `mincut` flips FALSE runs shorter than `mincut`
 * ticks to true. Iterates until it converges OR detects a 2-cycle (a lone short
 * run can otherwise flip back and forth forever). Mutates `val` in place is
 * avoided — returns the smoothed array.
 */
export function smoothing(
	val: boolean[],
	mincut: number,
	minclip: number,
): boolean[] {
	let cur = val.slice();
	let prev: boolean[] = [];
	let prev2: boolean[] = [];

	while (!boolArrayEqual(prev, cur) && !boolArrayEqual(prev2, cur)) {
		prev2 = prev;
		prev = cur;
		const next = prev.slice();
		const len = prev.length;

		// Pass 1 — drop TRUE runs shorter than minclip.
		let startP = 0;
		let active = false;
		for (let j = 0; j < len; j++) {
			if (prev[j]) {
				if (!active) {
					startP = j;
					active = true;
				}
				if (j === len - 1 && j - startP + 1 < minclip) {
					for (let i = startP; i < len; i++) next[i] = false;
				}
			} else if (active) {
				if (j - startP < minclip) {
					for (let i = startP; i < j; i++) next[i] = false;
				}
				active = false;
			}
		}

		// Pass 2 — fill FALSE runs shorter than mincut.
		startP = 0;
		active = false;
		for (let j = 0; j < len; j++) {
			if (!prev[j]) {
				if (!active) {
					startP = j;
					active = true;
				}
				if (j === len - 1 && j - startP + 1 < mincut) {
					for (let i = startP; i < len; i++) next[i] = true;
				}
			} else if (active) {
				if (j - startP < mincut) {
					for (let i = startP; i < j; i++) next[i] = true;
				}
				active = false;
			}
		}

		cur = next;
	}

	return cur;
}

/**
 * Walk the per-tick keep/cut labels and emit contiguous, sorted segments
 * covering [0, duration] (upstream `timeline.nim` chunkify). Tick edges map
 * back to seconds via the timebase; the FINAL segment end is the exact
 * `duration` (not a rounded tick edge) so segments cover the whole source.
 * Adjacent same-action segments are merged.
 */
export function chunkify(
	keep: boolean[],
	timebase: number,
	duration: number,
	opts: ResolvedAutoCutOptions,
): EditSegment[] {
	const n = keep.length;
	if (n === 0) {
		return duration > 0
			? [{ start: 0, end: duration, action: silentActionOf(opts) }]
			: [];
	}

	const segments: EditSegment[] = [];
	let runStart = 0;
	let runValue = keep[0];

	const push = (startTick: number, endTick: number, kept: boolean) => {
		const start = startTick / timebase;
		// Last tick's segment ends at the true duration, not a rounded edge.
		const end = endTick >= n ? duration : endTick / timebase;
		const action: EditSegment["action"] = kept
			? { type: "keep" }
			: silentActionOf(opts);
		const last = segments[segments.length - 1];
		if (last && actionsEqual(last.action, action)) {
			last.end = end;
		} else {
			segments.push({ start, end, action });
		}
	};

	for (let j = 1; j < n; j++) {
		if (keep[j] !== runValue) {
			push(runStart, j, runValue);
			runStart = j;
			runValue = keep[j];
		}
	}
	push(runStart, n, runValue);

	return segments;
}

function silentActionOf(opts: ResolvedAutoCutOptions): EditSegment["action"] {
	return opts.silentAction === "speed"
		? { type: "speed", speed: opts.silentSpeed }
		: { type: "cut" };
}

function actionsEqual(
	a: EditSegment["action"],
	b: EditSegment["action"],
): boolean {
	if (a.type !== b.type) return false;
	if (a.type === "speed" && b.type === "speed") return a.speed === b.speed;
	return true;
}

/** Seconds → timebase ticks (round-to-nearest), matching upstream conversion. */
export function secondsToTicks(seconds: number, timebase: number): number {
	return Math.round(seconds * timebase);
}

/**
 * Pure core: mono PCM → labeled segments.
 * threshold → margin → smoothing → chunkify (auto-editor pipeline order).
 */
export function detectSilenceSegments(
	samples: Float32Array,
	sampleRate: number,
	options?: AutoCutOptions,
): AutoCutAnalysis {
	const opts = resolveOptions(options);
	const duration = sampleRate > 0 ? samples.length / sampleRate : 0;

	const loudness = computeLoudness(samples, sampleRate, opts.timebase);

	// threshold → boolean keep signal.
	const keep = thresholdLevels(loudness, opts.threshold);

	// margin (converted seconds → ticks, applied against original transitions).
	mutMargin(
		keep,
		secondsToTicks(opts.marginBefore, opts.timebase),
		secondsToTicks(opts.marginAfter, opts.timebase),
	);

	// smoothing (mincut = minCut ticks, minclip = minKeep ticks).
	const smoothed = smoothing(
		keep,
		secondsToTicks(opts.minCut, opts.timebase),
		secondsToTicks(opts.minKeep, opts.timebase),
	);

	// chunkify → labeled segments in source seconds.
	const segments = chunkify(smoothed, opts.timebase, duration, opts);

	return {
		segments,
		loudness,
		timebase: opts.timebase,
		duration,
		options: opts,
	};
}

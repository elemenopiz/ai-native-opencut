/**
 * `duckMusicUnderSpeech` — plan volume keyframes that duck a music bed under
 * speech. Craft rule (editor terms): music should recede the instant someone
 * starts talking and come back up cleanly once they stop — never so abruptly
 * it pops, never so choppy that back-to-back lines make it flutter up and
 * down between them.
 *
 * INPUT GROUNDING (read-only):
 *  - Keyframe SHAPE is grounded on `hooks/use-auto-duck.ts`'s
 *    `computeDuckKeyframes` — the one place in this codebase that already
 *    plans `volume` ducking keyframes. Same dB→linear-gain conversion
 *    (`10 ** (duckAmountDb / 20)`), same element-relative `time` convention.
 *    `use-auto-duck.ts` calls `editor.timeline.upsertKeyframes` directly (a
 *    non-Director-verb editor API); this macro instead emits `animateItem`
 *    {@link CraftOp}s — the `DirectorApi`/tool-catalog verb whose `keyframes`
 *    arg shape (`{ time, value, interpolation }[]`, ordered, element-start-
 *    relative time) matches exactly (`tool-catalog.ts`'s `animateItem`
 *    schema; today scoped to visual elements/properties — the "small
 *    follow-up" this pillar depends on is widening it to audio + `volume`,
 *    a real `AnimationPropertyPath` per `types/animation.ts`).
 *  - `volume` as an `AnimationPropertyPath` and its keyframe shape
 *    (`{ id, time, value, interpolation, easing? }`) are grounded in
 *    `types/animation.ts`'s `NumberKeyframe`/`ElementKeyframe`; this macro
 *    omits `id` (assigned when the op is actually applied) and `easing`
 *    (linear ramps are the craft default here, same as `use-auto-duck.ts`).
 *
 * UNLIKE `use-auto-duck.ts`, this macro does NOT assume a single shared
 * fade duration or leave flutter-prevention to the caller — it is built in:
 *  1. Speech intervals separated by less than `mergeGapSec` (default 300ms
 *     — natural pauses inside one thought) are merged into one interval
 *     before any ducking math runs.
 *  2. Even after (1), two merged intervals can still be close enough that
 *     interval A's release ramp and interval B's attack ramp would CROSS
 *     (release + attack > the gap between them) — which would pop the
 *     volume back toward normal and immediately back down, an audible
 *     flutter. When that happens the two intervals' duck windows are
 *     collapsed into one continuous ducked span instead of emitting the
 *     crossing ramps.
 */

import type { CraftOp, TimeRangeSec } from "./types";
import { CRAFT_EPSILON, roundSec } from "./types";

/** Default ducked level, in dB relative to normal (0dB = unity gain). */
export const DEFAULT_DUCK_AMOUNT_DB = -12;
/** Default time to ramp DOWN to the ducked level once speech starts. */
export const DEFAULT_ATTACK_SEC = 0.15;
/** Default time to ramp BACK UP to normal once speech ends. */
export const DEFAULT_RELEASE_SEC = 0.4;
/** Speech intervals separated by less than this are merged before ducking. */
export const DEFAULT_MERGE_GAP_SEC = 0.3;

/** One TIMELINE-absolute speech interval (e.g. a transcript segment's `[start, end]`). */
export type SpeechInterval = TimeRangeSec;

/** One music-bed element `duckMusicUnderSpeech` may plan keyframes for. */
export interface DuckMusicElement {
	elementId: string;
	/** Timeline start, seconds. */
	startSec: number;
	/** Visible (post-trim) duration, seconds. */
	durationSec: number;
}

export interface DuckMusicUnderSpeechOptions {
	duckAmountDb?: number;
	attackSec?: number;
	releaseSec?: number;
	mergeGapSec?: number;
}

/** One planned `animateItem` volume keyframe (matches `tool-catalog.ts`'s `animateItem.keyframes[]` entry shape). */
export interface DuckKeyframeArg {
	/** Seconds from the MUSIC ELEMENT's own start (not timeline-absolute) — matches `animateItem`'s keyframe time convention. */
	time: number;
	value: number;
	interpolation: "linear";
}

export interface DuckMusicUnderSpeechPlan {
	ops: CraftOp[];
	/** Speech interval count after gap-merging, for diagnostics/tests. */
	mergedIntervalCount: number;
}

/** Merge intervals overlapping or separated by less than `gapSec`. Assumes nothing about input order. */
function mergeIntervals(
	intervals: SpeechInterval[],
	gapSec: number,
): SpeechInterval[] {
	if (intervals.length === 0) return [];
	const sorted = [...intervals].sort((a, b) => a.startSec - b.startSec);
	const merged: SpeechInterval[] = [{ ...sorted[0] }];
	for (let i = 1; i < sorted.length; i++) {
		const last = merged[merged.length - 1];
		const cur = sorted[i];
		if (cur.startSec - last.endSec < gapSec) {
			last.endSec = Math.max(last.endSec, cur.endSec);
		} else {
			merged.push({ ...cur });
		}
	}
	return merged;
}

/**
 * Second-tier merge, run PER MUSIC ELEMENT (ramp durations only matter
 * relative to a specific element's timeline window — irrelevant elsewhere):
 * collapse any two adjacent speech intervals whose fade ramps would cross
 * (`releaseSec + attackSec > gap between them`) into one continuous ducked
 * span, so a duck→recover→duck-again flutter is never emitted.
 */
function mergeForFlutter(
	intervals: SpeechInterval[],
	attackSec: number,
	releaseSec: number,
): SpeechInterval[] {
	if (intervals.length === 0) return [];
	const rampGap = attackSec + releaseSec;
	const merged: SpeechInterval[] = [{ ...intervals[0] }];
	for (let i = 1; i < intervals.length; i++) {
		const last = merged[merged.length - 1];
		const cur = intervals[i];
		if (cur.startSec - last.endSec < rampGap) {
			last.endSec = Math.max(last.endSec, cur.endSec);
		} else {
			merged.push({ ...cur });
		}
	}
	return merged;
}

/**
 * Plan `animateItem` volume-keyframe ops that duck every element in
 * `musicElements` under every overlapping interval in `speechIntervals`.
 * Deterministic: both merge passes sort by start time before merging, so
 * input order never affects the result.
 */
export function duckMusicUnderSpeech(
	speechIntervals: SpeechInterval[],
	musicElements: DuckMusicElement[],
	options: DuckMusicUnderSpeechOptions = {},
): DuckMusicUnderSpeechPlan {
	const duckAmountDb = options.duckAmountDb ?? DEFAULT_DUCK_AMOUNT_DB;
	const attackSec = Math.max(0, options.attackSec ?? DEFAULT_ATTACK_SEC);
	const releaseSec = Math.max(0, options.releaseSec ?? DEFAULT_RELEASE_SEC);
	const mergeGapSec = Math.max(0, options.mergeGapSec ?? DEFAULT_MERGE_GAP_SEC);

	const merged = mergeIntervals(speechIntervals, mergeGapSec);

	if (merged.length === 0 || musicElements.length === 0) {
		return { ops: [], mergedIntervalCount: merged.length };
	}

	const normalVolume = 1;
	const duckedVolume = 10 ** (duckAmountDb / 20);

	const ops: CraftOp[] = [];

	for (const music of musicElements) {
		const elStart = music.startSec;
		const elEnd = music.startSec + music.durationSec;

		// Only intervals overlapping this element matter for its own flutter check.
		const overlapping = merged.filter(
			(iv) => iv.endSec > elStart && iv.startSec < elEnd,
		);
		if (overlapping.length === 0) continue;

		const flutterSafe = mergeForFlutter(overlapping, attackSec, releaseSec);

		const keyframes: DuckKeyframeArg[] = [];
		for (const iv of flutterSafe) {
			const fadeInStart = Math.max(iv.startSec - attackSec, elStart);
			const duckTime = Math.max(iv.startSec, elStart);
			const recoverTime = Math.min(iv.endSec, elEnd);
			const fadeOutEnd = Math.min(iv.endSec + releaseSec, elEnd);

			if (fadeInStart >= elStart && fadeInStart < duckTime - CRAFT_EPSILON) {
				keyframes.push({
					time: roundSec(fadeInStart - elStart),
					value: normalVolume,
					interpolation: "linear",
				});
			}
			keyframes.push({
				time: roundSec(duckTime - elStart),
				value: duckedVolume,
				interpolation: "linear",
			});
			if (recoverTime > duckTime + CRAFT_EPSILON) {
				keyframes.push({
					time: roundSec(recoverTime - elStart),
					value: duckedVolume,
					interpolation: "linear",
				});
			}
			if (fadeOutEnd > recoverTime + CRAFT_EPSILON) {
				keyframes.push({
					time: roundSec(fadeOutEnd - elStart),
					value: normalVolume,
					interpolation: "linear",
				});
			}
		}

		if (keyframes.length === 0) continue;

		ops.push({
			verb: "animateItem",
			args: { itemId: music.elementId, property: "volume", keyframes },
		});
	}

	return { ops, mergedIntervalCount: merged.length };
}

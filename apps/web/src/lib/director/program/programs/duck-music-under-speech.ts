/**
 * `duckMusicUnderSpeech`, rewritten as a PROGRAM over the primitive surface —
 * the second proof in the `cutOnBeat`-established shape (`cut-on-beat.ts`
 * in this directory is the template this file follows).
 *
 * `lib/director/craft/duck-music-under-speech.ts` is the frozen macro: two
 * merge passes (gap-merge, then a per-element flutter-guard merge) followed
 * by an attack/duck/recover/release keyframe walk. Every step below is
 * arithmetic and `for`, so the whole macro reaches the primitive surface with
 * nothing invented — `duck-music-under-speech.program.test.ts` asserts this
 * produces the identical `CraftOp[]` the macro plans on a shared fixture.
 *
 * MIRRORED SEMANTICS (each one is a real decision the macro makes):
 *  - Gap-merge FIRST, at the whole-timeline level: intervals separated by
 *    less than `mergeGapSec` become one interval before any per-element
 *    reasoning runs — natural pauses inside one thought don't get a
 *    duck/recover blip.
 *  - Flutter-guard merge SECOND, per music element: two gap-merged intervals
 *    can still be close enough that interval A's release ramp and interval
 *    B's attack ramp would CROSS (`releaseSec + attackSec > gap`), which
 *    would pop the volume back up and immediately back down. This second
 *    pass only matters relative to one element's own ramp durations, so it
 *    runs inside the per-element loop, over that element's OVERLAPPING
 *    intervals only (not the whole merged list).
 *  - Every keyframe time is clamped to the element's own `[elStart, elEnd]`
 *    window and emitted ELEMENT-RELATIVE (`time - elStart`), matching
 *    `animateItem`'s keyframe convention.
 *  - A fade-in/attack keyframe is only emitted when there's room for it
 *    before the duck point (`fadeInStart < duckTime - EPSILON`); a recover/
 *    release keyframe only when there's room after the duck point. Speech
 *    that starts before or runs past the element's own bounds emits fewer
 *    keyframes rather than negative-time or past-the-end ones — the same
 *    clamp-not-invent posture `tighten-to-length.program.ts` uses for tail
 *    capacity.
 *
 * DATA SOURCE NOTE: `speech()` (`../derived-data.ts`) now gathers spans the
 * same TWO ways `director-api.ts`'s `gatherSpeechIntervals` does — a
 * voiceover-shaped audio element's own span, plus transcript-derived spans —
 * so this program's idea of "where the talking is" matches the verb's
 * exactly. `clips({ kind: "audio" })`'s `isMusic` flag mirrors
 * `gatherMusicElements`'s `isMusicElement` classification (same regex, same
 * `generation.kind` check, duplicated on purpose — see `derived-data.ts`'s
 * `isLikelyVoiceoverElement`).
 *
 * NOT A CONSTANT SOMEONE SHOULD TUNE IN PLACE, same posture as
 * `cut-on-beat.ts`: the duck-amount/attack/release/merge-gap literals below
 * are the macro's own defaults, and `duckedVolume` (a `10 ** (dB/20)` gain
 * conversion) is computed in JS at BUILD time and inlined as a plain number —
 * this language has no exponent operator, matching `roundSec`'s own
 * "emit-time only" discipline.
 */

import { DEFAULT_DUCK_AMOUNT_DB } from "../../craft/duck-music-under-speech";

export interface DuckMusicUnderSpeechProgramOptions {
	/** dB relative to normal (0dB = unity). Macro default: -12. */
	duckAmountDb?: number;
	/** Ramp-down time once speech starts, seconds. Macro default: 0.15. */
	attackSec?: number;
	/** Ramp-back-up time once speech ends, seconds. Macro default: 0.4. */
	releaseSec?: number;
	/** Speech intervals closer than this are merged before ducking. Macro default: 0.3. */
	mergeGapSec?: number;
	/** Restrict ducking targets to one track. Omitted ⇒ every audio track. */
	trackId?: string;
}

/**
 * Emit the program text. A builder (not a template constant) for the same
 * reason `buildCutOnBeatProgram` is one: the knobs are numbers a caller
 * genuinely varies per call, and `duckedVolume`'s `10 ** (dB/20)` conversion
 * can only happen in JS — this language has no `**`.
 */
export function buildDuckMusicUnderSpeechProgram(
	options: DuckMusicUnderSpeechProgramOptions = {},
): string {
	const duckAmountDb = options.duckAmountDb ?? DEFAULT_DUCK_AMOUNT_DB;
	const attackSec = Math.max(0, options.attackSec ?? 0.15);
	const releaseSec = Math.max(0, options.releaseSec ?? 0.4);
	const mergeGapSec = Math.max(0, options.mergeGapSec ?? 0.3);
	const duckedVolume = 10 ** (duckAmountDb / 20);
	const clipsArgs =
		options.trackId === undefined
			? `{ kind: "audio" }`
			: `{ kind: "audio", trackId: ${JSON.stringify(options.trackId)} }`;

	return `// duckMusicUnderSpeech as a program over primitives.
let attackSec = ${attackSec}
let releaseSec = ${releaseSec}
let mergeGapSec = ${mergeGapSec}
let normalVolume = 1
let duckedVolume = ${duckedVolume}

// Pass 1: gap-merge every speech interval on the whole timeline.
let raw = speech()
let merged = []
for (iv of raw) {
  if (len(merged) == 0) {
    merged[0] = { startSec: iv.startSec, endSec: iv.endSec }
  } else {
    let lastIdx = len(merged) - 1
    let gap = iv.startSec - merged[lastIdx].endSec
    if (gap < mergeGapSec) {
      let newEnd = merged[lastIdx].endSec
      if (iv.endSec > newEnd) { newEnd = iv.endSec }
      merged[lastIdx].endSec = newEnd
    } else {
      merged[len(merged)] = { startSec: iv.startSec, endSec: iv.endSec }
    }
  }
}

let musicEls = clips(${clipsArgs})

for (m of musicEls) {
  if (m.isMusic) {
    let elStart = m.startSec
    let elEnd = m.startSec + m.durationSec

    // Only intervals overlapping THIS element matter for its own flutter check.
    let overlapping = []
    for (iv of merged) {
      if (iv.endSec > elStart && iv.startSec < elEnd) {
        overlapping[len(overlapping)] = iv
      }
    }

    if (len(overlapping) > 0) {
      // Pass 2: per-element flutter guard — collapse any two adjacent
      // overlapping intervals whose ramps would cross.
      let rampGap = attackSec + releaseSec
      let flutterSafe = []
      for (iv of overlapping) {
        if (len(flutterSafe) == 0) {
          flutterSafe[0] = { startSec: iv.startSec, endSec: iv.endSec }
        } else {
          let lastIdx2 = len(flutterSafe) - 1
          let gap2 = iv.startSec - flutterSafe[lastIdx2].endSec
          if (gap2 < rampGap) {
            let newEnd2 = flutterSafe[lastIdx2].endSec
            if (iv.endSec > newEnd2) { newEnd2 = iv.endSec }
            flutterSafe[lastIdx2].endSec = newEnd2
          } else {
            flutterSafe[len(flutterSafe)] = { startSec: iv.startSec, endSec: iv.endSec }
          }
        }
      }

      let keyframes = []
      for (iv of flutterSafe) {
        let fadeInStart = max(iv.startSec - attackSec, elStart)
        let duckTime = max(iv.startSec, elStart)
        let recoverTime = min(iv.endSec, elEnd)
        let fadeOutEnd = min(iv.endSec + releaseSec, elEnd)

        if (fadeInStart >= elStart && fadeInStart < duckTime - EPSILON) {
          keyframes[len(keyframes)] = { time: roundSec(fadeInStart - elStart), value: normalVolume, interpolation: "linear" }
        }
        keyframes[len(keyframes)] = { time: roundSec(duckTime - elStart), value: duckedVolume, interpolation: "linear" }
        if (recoverTime > duckTime + EPSILON) {
          keyframes[len(keyframes)] = { time: roundSec(recoverTime - elStart), value: duckedVolume, interpolation: "linear" }
        }
        if (fadeOutEnd > recoverTime + EPSILON) {
          keyframes[len(keyframes)] = { time: roundSec(fadeOutEnd - elStart), value: normalVolume, interpolation: "linear" }
        }
      }

      if (len(keyframes) > 0) {
        animateItem({ itemId: m.id, property: "volume", keyframes: keyframes })
      }
    }
  }
}
`;
}

/** The program with the macro's own defaults — the exact shape `duckMusicUnderSpeech({})` runs today. */
export const DUCK_MUSIC_UNDER_SPEECH_PROGRAM =
	buildDuckMusicUnderSpeechProgram();

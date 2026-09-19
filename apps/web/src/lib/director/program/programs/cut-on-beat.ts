/**
 * `cutOnBeat`, rewritten as a PROGRAM over the primitive surface.
 *
 * This file is the argument for the whole package. `lib/director/craft/
 * cut-on-beat.ts` is a frozen macro: somebody's cutting philosophy, invocable
 * but not variable. The text below reaches the same ops from the same data
 * using nothing but `clips()`, `beats()`, arithmetic and `trim()` — which
 * means the philosophy is now EDITABLE. Change `i % 3 == 0` into the join
 * filter and you cut on every third beat; test `b.isDownbeat` and you cut on
 * downbeats only; hold one shot long against the grid by skipping its join.
 * None of those are expressible as arguments to the macro, and all of them
 * are a two-line diff here. That is the "strictly larger action space that
 * CONTAINS cutOnBeat" claim from `docs/plans/2026-09-18-director-autonomy-
 * architecture.md` §2, in one file.
 *
 * `cut-on-beat.program.test.ts` asserts this produces exactly the macro's
 * `CraftOp[]` on a shared fixture — parity is a test, not a hope.
 *
 * MIRRORED SEMANTICS (each one is a real decision the macro makes; the
 * comments say WHY the program does the same thing):
 *  - Only a real JOIN is a cut point. A gap between two clips has no single
 *    edit point to snap, so the `abs(nextStart - leftEnd) <= EPSILON` test
 *    is what makes this a cut-point walk rather than a clip-boundary walk.
 *  - Moving a join `delta` seconds trims the LEFT clip's tail and slides +
 *    re-trims the RIGHT clip's head by the same delta, so every frame either
 *    side stays real footage — never a freeze, never a gap.
 *  - The working arrays (`starts`/`durs`/`trims`) are updated as each join
 *    resolves, left to right, because a middle clip sits on TWO joins and its
 *    second adjustment must start from its first.
 *  - One op per element, fields merged, because two `trim` calls on the same
 *    clip would clobber each other.
 *  - `roundSec` at EMIT time only (working values stay full precision), so
 *    the emitted seconds carry the repo's standard 1e-6 rounding.
 *
 * NOT A CONSTANT SOMEONE SHOULD TUNE IN PLACE: the tolerance/min-duration
 * literals below are the macro's own defaults, duplicated so this file reads
 * as one self-contained program. {@link buildCutOnBeatProgram} parameterises
 * them for a caller that wants different taste — which is the point.
 */

export interface CutOnBeatProgramOptions {
	/** Snap tolerance in seconds. Macro default: 0.15. */
	toleranceSec?: number;
	/** Floor a snap must preserve on both sides of the join, seconds. Macro default: 0.5. */
	minClipDurationSec?: number;
	/**
	 * Restrict to one track. Omitted ⇒ the program picks the first video
	 * track itself, mirroring `director-api.ts`'s `resolveCraftTrack`
	 * fallback.
	 */
	trackId?: string;
}

/**
 * Emit the program text. A builder rather than a template string constant
 * because the two knobs are numbers a caller genuinely varies, and inlining
 * them keeps the program free of any parameter-passing mechanism the language
 * deliberately doesn't have.
 */
export function buildCutOnBeatProgram(
	options: CutOnBeatProgramOptions = {},
): string {
	const tolerance = options.toleranceSec ?? 0.15;
	const minDuration = options.minClipDurationSec ?? 0.5;
	const trackSelection =
		options.trackId === undefined
			? `let trackId = ""
for (t of tracks()) {
  if (t.kind == "video" && trackId == "") { trackId = t.id }
}`
			: `let trackId = ${JSON.stringify(options.trackId)}`;

	return `// cutOnBeat as a program over primitives.
${trackSelection}

let tolerance = ${tolerance}
let minDur = ${minDuration}

let cs = clips({ trackId: trackId })
let bs = beats()

// Working copy of every clip, updated left-to-right as each join resolves.
let starts = []
let durs = []
let trims = []
for (c of cs) {
  starts[len(starts)] = c.startSec
  durs[len(durs)] = c.durationSec
  trims[len(trims)] = c.trimStart
}

// Merged trim args per touched element, in first-touch order.
let touched = []
let plan = []

for (i, c of cs) {
  if (i + 1 < len(cs)) {
    let leftEnd = starts[i] + durs[i]
    // Only a real join has one well-defined cut point to snap.
    if (abs(starts[i + 1] - leftEnd) <= EPSILON) {
      // Nearest beat within tolerance; ties go to the first one seen.
      let bestTime = 0
      let bestDist = tolerance + 1
      for (b of bs) {
        let d = abs(b.time - leftEnd)
        if (d <= tolerance && d < bestDist) {
          bestDist = d
          bestTime = b.time
        }
      }
      if (bestDist <= tolerance) {
        let delta = bestTime - leftEnd
        // Already on the beat: nothing to move.
        if (abs(delta) > EPSILON) {
          let newLeftDur = durs[i] + delta
          let newRightDur = durs[i + 1] - delta
          if (newLeftDur >= minDur - EPSILON && newRightDur >= minDur - EPSILON) {
            let newRightStart = starts[i + 1] + delta
            let newRightTrim = trims[i + 1] + delta
            durs[i] = newLeftDur
            starts[i + 1] = newRightStart
            trims[i + 1] = newRightTrim
            durs[i + 1] = newRightDur

            let leftId = cs[i].id
            let li = -1
            for (k, tid of touched) {
              if (tid == leftId) { li = k }
            }
            if (li < 0) {
              touched[len(touched)] = leftId
              plan[len(plan)] = { slotId: leftId }
              li = len(touched) - 1
            }
            plan[li].duration = roundSec(newLeftDur)

            let rightId = cs[i + 1].id
            let ri = -1
            for (k, tid of touched) {
              if (tid == rightId) { ri = k }
            }
            if (ri < 0) {
              touched[len(touched)] = rightId
              plan[len(plan)] = { slotId: rightId }
              ri = len(touched) - 1
            }
            plan[ri].startTime = roundSec(newRightStart)
            plan[ri].trimStart = roundSec(newRightTrim)
            plan[ri].duration = roundSec(newRightDur)

            log("snapped join at", leftEnd, "to beat", bestTime)
          }
        }
      }
    }
  }
}

for (op of plan) {
  trim(op)
}
`;
}

/** The program with the macro's own defaults — the exact shape `cutOnBeat({})` runs today. */
export const CUT_ON_BEAT_PROGRAM = buildCutOnBeatProgram();

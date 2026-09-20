/**
 * `tightenToLength`, rewritten as a PROGRAM over the primitive surface —
 * third proof in the `cutOnBeat`-established shape (`cut-on-beat.ts` in this
 * directory is the template; see its header for the methodology).
 *
 * `lib/director/craft/tighten-to-length.ts` is the frozen macro: it plans
 * proportional TAIL trims (+ repositioning `move`s) that shrink a sequential
 * cut down to a target runtime, in up to two phases:
 *   Phase 1 — prefer each element's own detected low-interest (silence)
 *     budget (`trimmableSegments`).
 *   Phase 2 — water-fill whatever remains proportionally across remaining
 *     tail capacity, in at most two passes (one to converge when capacity is
 *     sufficient, one more to saturate-and-exit when it isn't).
 *
 * ──────────────────────────────────────────────────────────────────────────
 * A FINDING, NOT A DODGE: PHASE 1 IS OMITTED, AND HERE IS THE EVIDENCE.
 * ──────────────────────────────────────────────────────────────────────────
 * `trimmableSegments` is a real, tested input to the pure macro function
 * (`tighten-to-length.test.ts` covers it directly), but
 * `director-api.ts`'s `tightenToLength` VERB — the only caller that ever
 * turns a model's request into a real `tightenToLength({...})` call — never
 * populates it: its `elements` digest is built with only `elementId`/
 * `startSec`/`durationSec` (see `director-api.ts`'s `tightenToLength`
 * function, the `elements: TightenElementInput[] = sorted.map(...)` line).
 * A repo-wide search confirms zero other callers ever set
 * `trimmableSegments` on an object headed for this macro either (the one
 * near-namesake, `story/assembly.ts`'s `SilenceRangesLookup`, is a
 * DIFFERENT pure function's input, not this macro's).
 *
 * Given `trimmableSegments` is always absent, `trimmableBudget(el)` in the
 * macro is always `0` for every element, so Phase 1's `budget <=
 * CRAFT_EPSILON` guard trips immediately and Phase 1 contributes NOTHING —
 * for every input the verb can ever actually construct, the macro's
 * behaviour is EXACTLY its Phase 2. Omitting Phase 1 here is therefore not a
 * narrowed parity claim on the verb's reachable inputs — it is a byte-exact
 * reproduction of what the verb does today, full stop.
 *
 * It is also not expressible without inventing a new capability: no
 * primitive or derived-data accessor projects a low-interest/silence
 * segment detection pass (the closest existing accessor, `loudness()`, is a
 * raw dBFS curve, not a silence-segment classifier), and there is no derived
 * "silence()" source this program could read even if the verb did wire one.
 * If a future caller starts passing `trimmableSegments`, THAT is the moment
 * to add a `silence()` derived-data accessor (mirroring how `loudness()`
 * projects `computeLoudnessCurveDb`) and extend this program — not before.
 *
 * MIRRORED SEMANTICS for what remains (Phase 2 + the repack pass):
 *  - `capacities[i]` is the max seconds `elements[i]` can give up from its
 *    TAIL without crossing a protected range or its own `minDur` floor —
 *    computed once, up front, exactly like `tailCapacity`.
 *  - The water-fill loop is UNROLLED to exactly two passes (the macro's own
 *    `guard = 2`), using a `done` flag in place of `break` (this language
 *    has neither `while` nor `break` — see `ast.ts`'s header on what's
 *    deliberately absent). Each pass reads `capacities` as it stands at the
 *    pass's OWN start (the per-element share is `capacities[i] /
 *    capacitySum-at-pass-start`, matching the macro's fixed-snapshot
 *    discipline), and a pass that adds nothing (`takenThisPass <= EPSILON`)
 *    or has no capacity left (`capacitySum <= EPSILON`) sets `done` so the
 *    second unrolled pass is a no-op — exactly the macro's `break`.
 *  - Every planned trim is emitted FIRST, in element order, THEN the repack
 *    pass walks the elements again computing a fresh contiguous `cursor` and
 *    emits a `move` for every element whose start actually shifted — same
 *    two-loop order the macro uses, so op index order matches exactly.
 *  - `targetDurationSec`/`protectSpeech`/`minClipDurationSec`/
 *    `convergenceToleranceSec` are per-call knobs, inlined as literals at
 *    BUILD time (there is no way to pass them into a running program other
 *    than the source text itself) — same posture `buildCutOnBeatProgram`
 *    and `buildDuckMusicUnderSpeechProgram` take for their own options.
 *
 * DATA SOURCE NOTE: `els` reads `clips({ trackId })`, mirroring
 * `resolveCraftTrack`'s explicit-`trackId`-else-first-video-track fallback
 * (this program does not replicate `getMainTrack`'s "main track" heuristic —
 * on a single-video-track project, the fixture this file's parity test
 * uses, the two never diverge). `protectedRanges` reads `speech()` (unscoped,
 * matching `gatherSpeechIntervals`), which since `derived-data.ts` was
 * extended alongside this file now covers BOTH of that gatherer's branches
 * (voiceover-element spans and transcript-derived spans) — see
 * `duck-music-under-speech.ts`'s header for the shared note.
 */

const DEFAULT_MIN_CLIP_DURATION_SEC = 0.5;
const DEFAULT_CONVERGENCE_TOLERANCE_SEC = 0.25;

export interface TightenToLengthProgramOptions {
	/** Target runtime, seconds. Required — there is no sensible default. */
	targetDurationSec: number;
	/** Restrict to one track. Omitted ⇒ the program picks the first video track itself. */
	trackId?: string;
	/** Never trim into speech. Macro default: true. */
	protectSpeech?: boolean;
	/** Floor no element is trimmed below, seconds. Macro default: 0.5. */
	minClipDurationSec?: number;
	/** Converged when projected duration is within this many seconds of target. Macro default: 0.25. */
	convergenceToleranceSec?: number;
}

/**
 * Emit the program text. A builder rather than a template constant, same
 * reason as `buildCutOnBeatProgram`/`buildDuckMusicUnderSpeechProgram`: the
 * knobs (starting with the required `targetDurationSec`) are per-call values
 * this language has no parameter-passing mechanism for other than the
 * source text itself.
 */
export function buildTightenToLengthProgram(
	options: TightenToLengthProgramOptions,
): string {
	const minDur = options.minClipDurationSec ?? DEFAULT_MIN_CLIP_DURATION_SEC;
	const convergenceTol =
		options.convergenceToleranceSec ?? DEFAULT_CONVERGENCE_TOLERANCE_SEC;
	const protectSpeech = options.protectSpeech ?? true;
	const trackSelection =
		options.trackId === undefined
			? `let trackId = ""
for (t of tracks()) {
  if (t.kind == "video" && trackId == "") { trackId = t.id }
}`
			: `let trackId = ${JSON.stringify(options.trackId)}`;

	return `// tightenToLength as a program over primitives (Phase 2 only — see this file's header).
${trackSelection}

let targetDurationSec = ${options.targetDurationSec}
let minDur = ${minDur}
let convergenceTol = ${convergenceTol}
let protectSpeech = ${protectSpeech}

let els = clips({ trackId: trackId })

let protectedRanges = []
if (protectSpeech) {
  for (s of speech()) {
    protectedRanges[len(protectedRanges)] = { startSec: s.startSec, endSec: s.endSec }
  }
}

let originalTotal = 0
for (e of els) { originalTotal = originalTotal + e.durationSec }

let excess = originalTotal - targetDurationSec

let trimArgs = []
let moveArgs = []

if (excess > convergenceTol) {
  // capacities[i]: max seconds elements[i] can give up from its TAIL
  // without crossing a protected range or minDur.
  let capacities = []
  for (e of els) {
    let elStart = e.startSec
    let elEnd = e.startSec + e.durationSec
    let minAllowedEnd = elStart + minDur
    for (r of protectedRanges) {
      if (r.endSec > elStart && r.startSec < elEnd) {
        let cappedEnd = r.endSec
        if (cappedEnd > elEnd) { cappedEnd = elEnd }
        if (cappedEnd > minAllowedEnd) { minAllowedEnd = cappedEnd }
      }
    }
    let cap = elEnd - minAllowedEnd
    if (cap < 0) { cap = 0 }
    capacities[len(capacities)] = cap
  }

  let trimmed = []
  for (e of els) { trimmed[len(trimmed)] = 0 }

  // Water-fill, unrolled to the macro's own guard=2 passes. \`done\` stands
  // in for the macro's \`break\` (neither exists in this language).
  let remaining = excess
  let done = false
  for (pass of [0, 1]) {
    if (!done && remaining > EPSILON) {
      let capacitySum = 0
      for (c of capacities) {
        if (c > EPSILON) { capacitySum = capacitySum + c }
      }
      if (capacitySum <= EPSILON) {
        done = true
      } else {
        let remainingAtPassStart = remaining
        let takenThisPass = 0
        for (i, c of capacities) {
          if (c > EPSILON) {
            let share = (c / capacitySum) * remainingAtPassStart
            let take = share
            if (take > c) { take = c }
            if (take > EPSILON) {
              trimmed[i] = trimmed[i] + take
              capacities[i] = c - take
              takenThisPass = takenThisPass + take
            }
          }
        }
        remaining = remaining - takenThisPass
        if (takenThisPass <= EPSILON) { done = true }
      }
    }
  }

  for (i, e of els) {
    let take = trimmed[i]
    if (take > EPSILON) {
      trimArgs[len(trimArgs)] = { slotId: e.id, duration: roundSec(e.durationSec - take) }
    }
  }

  // Repack contiguously; emit a move for every element whose start shifted.
  let cursor = 0
  if (len(els) > 0) { cursor = els[0].startSec }
  for (i, e of els) {
    let take = trimmed[i]
    let newDuration = e.durationSec - take
    if (abs(cursor - e.startSec) > EPSILON) {
      moveArgs[len(moveArgs)] = { slotId: e.id, newStartTime: roundSec(cursor) }
    }
    cursor = cursor + newDuration
  }
}

for (a of trimArgs) { trim(a) }
for (a of moveArgs) { move(a) }
`;
}

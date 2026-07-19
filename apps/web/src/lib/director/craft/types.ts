/**
 * Shared contract for `lib/director/craft/` — the P5 "craft" macro pillar
 * (`docs/plans/2026-07-19-director-northstar.md` P5;
 * `docs/plans/2026-07-19-director-brain-rethink.md` "Fake 2").
 *
 * Fake 2's split: the model owns WHAT to do ("cut on the beat", "tighten
 * this to 30s", "duck the music"); these macros own the frame-accurate WHEN
 * — they are the model's missing time-sense, not a convenience layer. Every
 * macro in this directory is:
 *   - PURE: no network, no React, no `DirectorApi`, no browser decode, no
 *     model call — ever. Same discipline `edit-critic.ts` and
 *     `lib/auto-cut/engine.ts` use for their planning cores.
 *   - DETERMINISTIC: same input twice ⇒ deep-equal output.
 *   - A PLANNER, not an executor: output is an ordered list of {@link CraftOp}
 *     — existing `DirectorApi`/tool-catalog verb calls (`trim`, `move`,
 *     `split`, `animateItem`, …) — that some future caller (verb wiring, the
 *     Story Engine, or a critic `proposedFix`) executes. A macro never
 *     mutates a timeline, store, or file itself.
 *
 * `CraftOp` deliberately mirrors `edit-critic.ts`'s `ProposedFix` shape
 * (`{ verb: string; args: Record<string, unknown> }`) — own local copy, not
 * an import, matching this codebase's "own copy, not import" discipline for
 * small decoupled contracts (see `edit-critic.ts`'s `EditCriticBeatGrid`
 * doc comment for the same pattern).
 */

/** One planned, executable `DirectorApi`/tool-catalog verb call. Never executed by a macro itself. */
export interface CraftOp {
	/** A real tool-catalog verb name, e.g. "trim", "move", "split", "animateItem". */
	verb: string;
	/** Loose arg bag for that verb — shape mirrors the verb's own tool-catalog schema. */
	args: Record<string, unknown>;
}

/** A TIMELINE-absolute time range, seconds. Shared shape across macro inputs (transcript spans, protected ranges, speech intervals). */
export interface TimeRangeSec {
	startSec: number;
	endSec: number;
}

/** Sub-second slop used for boundary/no-op/equality comparisons — matches the `1e-4` convention used across `lib/auto-cut/*`. */
export const CRAFT_EPSILON = 1e-4;

/** Round to a stable sub-millisecond precision so planned seconds never carry float noise (e.g. `4.999999999999998`) into a `CraftOp`'s args. */
export function roundSec(value: number): number {
	return Math.round(value * 1e6) / 1e6;
}

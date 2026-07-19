/**
 * `tightenToLength` — plan proportional trims that shorten a sequential cut
 * down to a target runtime. Craft rule (editor terms): tightening a cut
 * means shaving the fat everywhere it exists — dead air and low-interest
 * tails first — rather than butchering one clip; every element gives up a
 * proportional share only once the cheap material (silence, marked
 * low-interest ranges) is exhausted, and nothing protected or already at
 * its floor gets touched.
 *
 * INPUT GROUNDING (read-only):
 *  - {@link TightenElementInput} is the "durations per element" digest the
 *    spec calls for — same `startSec`/`durationSec` naming `edit-critic.ts`'s
 *    `SamplableElement` uses for its own pure per-element digest.
 *  - `protectedRanges` (TIMELINE-absolute {@link TimeRangeSec}) mirrors how a
 *    resolved transcript's speech spans are already shaped elsewhere in this
 *    codebase (`hooks/use-auto-duck.ts`'s `DuckSpan`,
 *    `edit-critic.ts`'s `TranscriptExcerptSegment`) — caller resolves the
 *    transcript, this macro only ever reads plain ranges.
 *  - `trimmableSegments` per element mirrors `lib/auto-cut/types.ts`'s
 *    `EditSegment` shape (`{ start, end }`, SOURCE-relative seconds) — the
 *    auto-cut silence engine's own output. Only the aggregate SECONDS of
 *    `cut`-worthy segments is used here (see the "v1 approximation" note
 *    below); a caller can pass the engine's raw `EditSegment[]` filtered to
 *    `action.type === "cut"`, or synthesize an equivalent list.
 *
 * SCOPE (v1): a single sequential, contiguous, single-track digest — same
 * scope `cutOnBeat` takes. Trims are TAIL-ONLY (`trim{duration}` shrinks an
 * element from its end), matching "trim ... tails" in the craft rule and
 * keeping every planned op a plain `trim`/`move` (no `split`, so no macro
 * ever needs to reason about carving a NEW mid-clip boundary). After
 * trimming, downstream elements are re-packed contiguously and a `move` op
 * is emitted for every element whose start actually shifted, so the
 * resulting plan is a genuinely shorter, still-gapless sequence.
 *
 * v1 APPROXIMATION: `trimmableSegments`' aggregate duration is used as a
 * BUDGET (how much low-interest material this element has to give up),
 * not as an exact position — this macro does not perform interval
 * subtraction to prove the shaved seconds sit exactly inside the detected
 * segments. This is safe: the actual shave amount is always hard-capped by
 * `protectedRanges` and `minClipDurationSec` regardless of the budget
 * number, so a mis-estimated budget can under-use available silence but can
 * never cut into protected time or below the floor. Exact mid-clip
 * subtraction (needing `split`) is a documented future increment.
 */

import {
	CRAFT_EPSILON,
	type CraftOp,
	type TimeRangeSec,
	roundSec,
} from "./types";

/** Converged when the plan's projected duration is within this many seconds of the target. */
export const DEFAULT_CONVERGENCE_TOLERANCE_SEC = 0.25;

/** Default floor: no element is trimmed below this duration. */
export const DEFAULT_MIN_CLIP_DURATION_SEC = 0.5;

/** One `{start, end}` SOURCE-relative span (mirrors `lib/auto-cut/types.ts`'s `EditSegment`, minus the `action` label — only `"cut"`-worthy spans should be passed in). */
export interface TrimmableSegment {
	start: number;
	end: number;
}

/** One element in the sequential digest `tightenToLength` reasons about. */
export interface TightenElementInput {
	elementId: string;
	/** Timeline start, seconds. */
	startSec: number;
	/** Visible (post-trim) duration, seconds. */
	durationSec: number;
	/**
	 * Low-interest / silence spans within this element (SOURCE-relative,
	 * `lib/auto-cut` `EditSegment` "cut" shape) this macro is licensed to
	 * shave from the tail first. Omit for an element with no known
	 * low-interest content — it only gives up time in the proportional
	 * fallback phase.
	 */
	trimmableSegments?: TrimmableSegment[];
}

export interface TightenToLengthInput {
	/** Ordered, contiguous, single-track element digest. */
	elements: TightenElementInput[];
	targetDurationSec: number;
	/** TIMELINE-absolute ranges (e.g. speech spans) that must never be trimmed into. */
	protectedRanges?: TimeRangeSec[];
	minClipDurationSec?: number;
	convergenceToleranceSec?: number;
}

export interface TightenShortfall {
	/** Remaining seconds still needed to reach the target (positive = still too long, negative = target is unreachably longer than the current cut — trims cannot add content). */
	deltaSec: number;
	reason: string;
}

export interface TightenToLengthPlan {
	ops: CraftOp[];
	projectedDurationSec: number;
	/** Present only when the plan could not converge within `convergenceToleranceSec`. */
	shortfall?: TightenShortfall;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/** Aggregate trimmable seconds for one element, clamped to its own visible duration. */
function trimmableBudget(el: TightenElementInput): number {
	if (!el.trimmableSegments || el.trimmableSegments.length === 0) return 0;
	const total = el.trimmableSegments.reduce(
		(sum, seg) => sum + Math.max(0, seg.end - seg.start),
		0,
	);
	return clamp(total, 0, el.durationSec);
}

/**
 * Max seconds that can be trimmed off `el`'s TAIL without touching
 * `protectedRanges` or its own end going below `minClipDurationSec`.
 */
function tailCapacity(
	el: TightenElementInput,
	protectedRanges: TimeRangeSec[],
	minClipDurationSec: number,
): number {
	const elStart = el.startSec;
	const elEnd = el.startSec + el.durationSec;

	let minAllowedEnd = elStart + minClipDurationSec;
	for (const range of protectedRanges) {
		// Only ranges that actually overlap this element's span constrain it.
		if (range.endSec <= elStart || range.startSec >= elEnd) continue;
		minAllowedEnd = Math.max(minAllowedEnd, Math.min(range.endSec, elEnd));
	}
	return Math.max(0, elEnd - minAllowedEnd);
}

/**
 * Plan proportional tail trims (+ repositioning `move`s) that shrink
 * `elements` down to `targetDurationSec`. Deterministic; iterates `elements`
 * in the given order throughout.
 */
export function tightenToLength(
	input: TightenToLengthInput,
): TightenToLengthPlan {
	const {
		elements,
		targetDurationSec,
		protectedRanges = [],
		minClipDurationSec = DEFAULT_MIN_CLIP_DURATION_SEC,
		convergenceToleranceSec = DEFAULT_CONVERGENCE_TOLERANCE_SEC,
	} = input;

	const originalTotal = elements.reduce((sum, el) => sum + el.durationSec, 0);

	if (elements.length === 0) {
		return {
			ops: [],
			projectedDurationSec: 0,
			shortfall:
				targetDurationSec > convergenceToleranceSec
					? { deltaSec: targetDurationSec, reason: "no elements to trim" }
					: undefined,
		};
	}

	const excess = originalTotal - targetDurationSec;

	// Already at/under target — nothing to trim. (Trims can only shorten;
	// a target longer than the current cut is a shortfall, not an error.)
	if (excess <= convergenceToleranceSec) {
		const deltaSec = targetDurationSec - originalTotal;
		return {
			ops: [],
			projectedDurationSec: originalTotal,
			shortfall:
				deltaSec > convergenceToleranceSec
					? {
							deltaSec,
							reason:
								"current runtime is already shorter than the target — trims can only shorten, not add content",
						}
					: undefined,
		};
	}

	let remaining = excess;
	const trimmed = new Map<string, number>(); // elementId -> seconds removed so far

	const capacities = elements.map((el) =>
		tailCapacity(el, protectedRanges, minClipDurationSec),
	);

	// Phase 1: prefer each element's own detected low-interest (silence) budget.
	for (let i = 0; i < elements.length && remaining > CRAFT_EPSILON; i++) {
		const el = elements[i];
		const budget = Math.min(trimmableBudget(el), capacities[i]);
		if (budget <= CRAFT_EPSILON) continue;
		const take = Math.min(budget, remaining);
		trimmed.set(el.elementId, (trimmed.get(el.elementId) ?? 0) + take);
		capacities[i] -= take;
		remaining -= take;
	}

	// Phase 2: distribute whatever remains proportionally across remaining
	// tail capacity (water-filling so no element is pushed past its cap).
	// Each pass computes every share off a FIXED snapshot of `remaining`
	// taken at the pass's start (not mutated mid-pass) — so when total
	// capacity is sufficient, every share is <= its own cap by construction
	// (share_i = capacity_i * (remaining/capacitySum), ratio <= 1) and the
	// whole remainder converges in exactly one pass. A second pass is only
	// ever needed when total capacity falls short: that pass fully
	// saturates every remaining element, capacities empty out, and the loop
	// exits (any leftover is reported as a shortfall).
	let guard = 2; // one pass to converge (capacity sufficient) + one to saturate-and-exit (capacity insufficient)
	while (remaining > CRAFT_EPSILON && guard-- > 0) {
		const eligible = elements
			.map((el, i) => ({ el, i }))
			.filter(({ i }) => capacities[i] > CRAFT_EPSILON);
		if (eligible.length === 0) break;

		const capacitySum = eligible.reduce((sum, { i }) => sum + capacities[i], 0);
		if (capacitySum <= CRAFT_EPSILON) break;

		const remainingAtPassStart = remaining;
		let takenThisPass = 0;
		for (const { el, i } of eligible) {
			const share = (capacities[i] / capacitySum) * remainingAtPassStart;
			const take = Math.min(share, capacities[i]);
			if (take <= CRAFT_EPSILON) continue;
			trimmed.set(el.elementId, (trimmed.get(el.elementId) ?? 0) + take);
			capacities[i] -= take;
			takenThisPass += take;
		}
		remaining -= takenThisPass;
		if (takenThisPass <= CRAFT_EPSILON) break;
	}

	const ops: CraftOp[] = [];
	for (const el of elements) {
		const take = trimmed.get(el.elementId) ?? 0;
		if (take <= CRAFT_EPSILON) continue;
		ops.push({
			verb: "trim",
			args: {
				slotId: el.elementId,
				duration: roundSec(el.durationSec - take),
			},
		});
	}

	// Re-pack contiguously and emit `move`s for anything that shifted.
	let cursor = elements[0].startSec;
	for (const el of elements) {
		const take = trimmed.get(el.elementId) ?? 0;
		const newDuration = el.durationSec - take;
		if (Math.abs(cursor - el.startSec) > CRAFT_EPSILON) {
			ops.push({
				verb: "move",
				args: { slotId: el.elementId, newStartTime: roundSec(cursor) },
			});
		}
		cursor += newDuration;
	}

	// Actual seconds removed = excess - remaining (remaining > 0 means we
	// couldn't remove it all, so the plan removed less than the full excess).
	const projectedDurationSec = originalTotal - (excess - remaining);

	const shortfall: TightenShortfall | undefined =
		remaining > convergenceToleranceSec
			? {
					deltaSec: remaining,
					reason:
						"elements are at their protected/minimum-duration floor — cannot trim further without violating protected ranges or minClipDurationSec",
				}
			: undefined;

	return {
		ops,
		projectedDurationSec: roundSec(projectedDurationSec),
		shortfall,
	};
}

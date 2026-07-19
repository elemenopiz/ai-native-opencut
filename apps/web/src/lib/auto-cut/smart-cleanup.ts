/**
 * "Smart cleanup" composition — merges the silence engine's `EditSegment[]`
 * (see `./engine.ts`) with transcript-aware filler-word / false-start cut
 * ranges (see `./filler-detect.ts`) into ONE `EditSegment[]`. The output is a
 * plain `EditSegment[]`, so it flows into the EXISTING `./apply.ts`
 * (`planAutoCut` / `applyAutoCut`) completely unchanged — no new apply-layer
 * plumbing needed.
 *
 * The merge is where overlap/adjacency bugs live: a filler range can fall
 * fully inside a kept span (3-way split), can overlap a span that's already
 * cut by silence detection (no-op, must not double-count or leave a
 * zero-length sliver), or can butt up against an existing cut boundary
 * (must fuse into one contiguous cut, not two touching ones). See
 * `__tests__/smart-cleanup.test.ts` for the case list.
 */

import type { FillerCutRange } from "./filler-detect";
import type { EditSegment } from "./types";

const EPSILON = 1e-4;

/** An all-kept `EditSegment[]` covering `[0, duration]` — the base to merge
 *  filler/false-start cuts into when silence detection is off or wasn't run. */
export function allKeepBase(duration: number): EditSegment[] {
	return duration > EPSILON
		? [{ start: 0, end: duration, action: { type: "keep" } }]
		: [];
}

function actionsEqual(
	a: EditSegment["action"],
	b: EditSegment["action"],
): boolean {
	if (a.type !== b.type) return false;
	if (a.type === "speed" && b.type === "speed") return a.speed === b.speed;
	return true;
}

/** Sort + fuse overlapping/touching ranges so subtraction never double-counts
 *  a region covered by two filler matches (e.g. a false-start range abutting
 *  a filler-word range). */
function mergeCutRanges(
	ranges: readonly FillerCutRange[],
): Array<[number, number]> {
	const sorted = ranges
		.map((r): [number, number] => [r.start, r.end])
		.filter(([s, e]) => e - s > EPSILON)
		.sort((a, b) => a[0] - b[0]);

	const out: Array<[number, number]> = [];
	for (const [s, e] of sorted) {
		const last = out[out.length - 1];
		if (last && s - last[1] <= EPSILON) {
			last[1] = Math.max(last[1], e);
		} else {
			out.push([s, e]);
		}
	}
	return out;
}

/**
 * Merge `base` (the silence engine's contiguous `[0, duration]`-covering
 * segments, or `allKeepBase(duration)` when silence detection is skipped)
 * with `extraCuts` (filler/false-start ranges, ASSET-RELATIVE seconds — the
 * same timebase `base` is already in, see `./filler-detect.ts`'s timebase
 * note) into one contiguous `EditSegment[]`.
 *
 * `extraCuts` only ever SUBTRACTS from "keep"/"speed" segments — a base
 * segment already marked "cut" is passed through untouched (its content is
 * already gone; nothing to subtract). Adjacent same-action output segments
 * are fused, matching `engine.ts#chunkify`'s contract so downstream code
 * never has to special-case a pointless zero-content boundary.
 *
 * `extraCuts` empty ⇒ returns `base` unchanged (proves silence-only behavior
 * is byte-identical when the new filler/false-start options are off).
 */
export function buildSmartCleanupPlan(
	base: readonly EditSegment[],
	extraCuts: readonly FillerCutRange[],
): EditSegment[] {
	if (extraCuts.length === 0) return base as EditSegment[];
	const cuts = mergeCutRanges(extraCuts);
	if (cuts.length === 0) return base as EditSegment[];

	const out: EditSegment[] = [];
	const push = (seg: EditSegment) => {
		if (seg.end - seg.start <= EPSILON) return;
		const last = out[out.length - 1];
		if (
			last &&
			actionsEqual(last.action, seg.action) &&
			seg.start - last.end <= EPSILON
		) {
			last.end = Math.max(last.end, seg.end);
		} else {
			out.push({ ...seg });
		}
	};

	for (const baseSeg of base) {
		if (baseSeg.action.type === "cut") {
			push(baseSeg);
			continue;
		}

		// Subtract every overlapping extra-cut range from this kept/sped span,
		// preserving the ORIGINAL action (keep or speed) for the remainder.
		let cursor = baseSeg.start;
		for (const [cs, ce] of cuts) {
			const s = Math.max(cs, baseSeg.start);
			const e = Math.min(ce, baseSeg.end);
			if (e - s <= EPSILON) continue; // this cut range doesn't touch baseSeg
			if (s > cursor + EPSILON) {
				push({ start: cursor, end: s, action: baseSeg.action });
			}
			push({ start: Math.max(s, cursor), end: e, action: { type: "cut" } });
			cursor = Math.max(cursor, e);
		}
		if (baseSeg.end - cursor > EPSILON) {
			push({ start: cursor, end: baseSeg.end, action: baseSeg.action });
		}
	}
	return out;
}

/** Aggregate counts for UI/Director narration ("removed 3 filler words, 1
 *  false start; 2 more fillers found but need word-level timing to cut"). */
export interface SmartCleanupCounts {
	fillerCount: number;
	falseStartCount: number;
	undetectableFillerCount: number;
}

export function summarizeSmartCleanup(
	extraCuts: readonly FillerCutRange[],
	undetectableFillerCount: number,
): SmartCleanupCounts {
	let fillerCount = 0;
	let falseStartCount = 0;
	for (const c of extraCuts) {
		if (c.source === "filler") fillerCount++;
		else falseStartCount++;
	}
	return { fillerCount, falseStartCount, undetectableFillerCount };
}

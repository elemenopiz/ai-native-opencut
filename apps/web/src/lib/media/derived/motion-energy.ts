/**
 * Motion-energy timeseries — pure core.
 *
 * A per-second "how much is changing on screen" curve: quiet/static footage
 * reads low, action/handheld/fast-cutting reads high. Editing use: where to
 * punch in, which stretch of a long clip is "the good part" versus dead
 * wallpaper.
 *
 * Reuses the SAME per-frame histograms `shot-detection.ts` consumes (task A:
 * one frame-sampling pass, several derivations) — energy here is just that
 * same histogram distance between adjacent samples, without the
 * cut/no-cut threshold. A big distance is either a cut OR fast motion; this
 * module doesn't try to tell them apart (that's `shot-detection.ts`'s job),
 * it just reports "how much changed."
 *
 * STORAGE DISCIPLINE: samples already arrive at ~1 Hz (see
 * `visual-analysis.ts`), so one energy value per input frame IS already a
 * ~1 Hz timeseries — no separate resampling step. Values are quantized to
 * Uint8 (0-255) for persistence: `encodeMotionEnergy`/`decodeMotionEnergy`
 * below. An hour of footage is ~3600 samples × 1 byte = ~3.6 KB.
 */

import type { FrameSample } from "./frame-sample-types";

export interface MotionEnergyPoint {
	timestampSec: number;
	/** Normalized [0, 1] — 0 = no measurable change since the previous sample. */
	energy: number;
}

/** Same L1 histogram distance as shot-detection, normalized to [0, 1] (max L1 for two sum-1 distributions is 2). */
function normalizedHistogramDistance(a: number[], b: number[]): number {
	let sum = 0;
	for (let i = 0; i < a.length; i++) {
		sum += Math.abs(a[i] - (b[i] ?? 0));
	}
	return Math.min(1, sum / 2);
}

/**
 * Compute the motion-energy curve from ordered frame samples. The first
 * frame has no predecessor to diff against, so it's reported at energy 0
 * (matches "nothing has happened yet" rather than being omitted, which would
 * otherwise leave the curve one sample short of the sampled duration).
 */
export function computeMotionEnergy(
	frames: FrameSample[],
): MotionEnergyPoint[] {
	if (frames.length === 0) return [];
	const points: MotionEnergyPoint[] = [
		{ timestampSec: frames[0].timestampSec, energy: 0 },
	];
	for (let i = 1; i < frames.length; i++) {
		const energy = normalizedHistogramDistance(
			frames[i - 1].lumaHistogram,
			frames[i].lumaHistogram,
		);
		points.push({ timestampSec: frames[i].timestampSec, energy });
	}
	return points;
}

/**
 * Compact persisted form: a real `Uint8Array` (structured-clone-safe, so
 * IndexedDB stores it as literal 1-byte-per-sample) plus start/step — not an
 * array of per-point objects. An hour at 1 sample/sec is ~3600 bytes.
 */
export interface EncodedMotionEnergy {
	/** Seconds of the first sample. */
	startSec: number;
	/** Nominal seconds between samples (the sampler's actual interval). */
	stepSec: number;
	/** Energy values quantized to 0-255, one per sample, in order. */
	values: Uint8Array;
}

export function encodeMotionEnergy(
	points: MotionEnergyPoint[],
	stepSec: number,
): EncodedMotionEnergy {
	if (points.length === 0) {
		return { startSec: 0, stepSec, values: new Uint8Array(0) };
	}
	const values = new Uint8Array(points.length);
	for (let i = 0; i < points.length; i++) {
		values[i] = Math.round(Math.max(0, Math.min(1, points[i].energy)) * 255);
	}
	return { startSec: points[0].timestampSec, stepSec, values };
}

export function decodeMotionEnergy(
	encoded: EncodedMotionEnergy,
): MotionEnergyPoint[] {
	const out: MotionEnergyPoint[] = [];
	for (let i = 0; i < encoded.values.length; i++) {
		out.push({
			timestampSec: encoded.startSec + i * encoded.stepSec,
			energy: encoded.values[i] / 255,
		});
	}
	return out;
}

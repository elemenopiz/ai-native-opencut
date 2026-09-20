/**
 * Pure LUFS/true-peak measurement — extracted from
 * `hooks/use-loudness-normalization.ts` so the SAME algorithm can be reused
 * for the manual "Measure Loudness" panel action AND for automatic per-asset
 * ingest persistence (task B), instead of two copies drifting apart.
 *
 * This is a simplified BS.1770-style approximation (block RMS → gated mean),
 * not a certified EBU R128 meter — same caveat the original hook carried.
 * True-peak here is sample-peak (no oversampling), which is why it's a rough
 * approximation of "true peak" rather than an ITU-R BS.1770-4 compliant one.
 */

import type { LUFSMeasurement } from "./loudness-types";

/** Loudness block size in seconds (BS.1770 uses 400ms momentary blocks). */
const BLOCK_SIZE_SEC = 0.4;
/** Absolute silence gate, LUFS. Blocks quieter than this never count. */
const ABSOLUTE_GATE_LUFS = -70;
/** Relative gate offset below the ungated mean, LUFS. */
const RELATIVE_GATE_OFFSET_LUFS = -10;

/**
 * Measure integrated/short-term/momentary loudness + true-peak + range from
 * mono (or first-channel) PCM samples in [-1, 1].
 */
export function computeLUFS(
	samples: Float32Array,
	sampleRate: number,
): LUFSMeasurement {
	const blockSize = Math.round(sampleRate * BLOCK_SIZE_SEC);

	const blockLoudness: number[] = [];
	let maxMomentary = -Infinity;
	let maxTruePeak = 0;

	for (let i = 0; i < samples.length; i += blockSize) {
		const end = Math.min(i + blockSize, samples.length);
		let sum = 0;
		let peak = 0;
		for (let j = i; j < end; j++) {
			sum += samples[j] * samples[j];
			const abs = Math.abs(samples[j]);
			if (abs > peak) peak = abs;
		}
		const rms = sum / (end - i);
		const loudness = 10 * Math.log10(rms + 1e-10);
		blockLoudness.push(loudness);
		if (loudness > maxMomentary) maxMomentary = loudness;
		if (peak > maxTruePeak) maxTruePeak = peak;
	}

	const validBlocks = blockLoudness.filter((l) => l > ABSOLUTE_GATE_LUFS);
	const gatedLoudness =
		validBlocks.length > 0
			? validBlocks.reduce((a, b) => a + b, 0) / validBlocks.length
			: ABSOLUTE_GATE_LUFS;

	const threshold = gatedLoudness + RELATIVE_GATE_OFFSET_LUFS;
	const finalBlocks = validBlocks.filter((l) => l > threshold);
	const integrated =
		finalBlocks.length > 0
			? finalBlocks.reduce((a, b) => a + b, 0) / finalBlocks.length
			: ABSOLUTE_GATE_LUFS;

	return {
		integrated: Math.round(integrated * 10) / 10,
		shortTerm: Math.round(gatedLoudness * 10) / 10,
		momentary: Number.isFinite(maxMomentary)
			? Math.round(maxMomentary * 10) / 10
			: ABSOLUTE_GATE_LUFS,
		truePeak: Math.round(20 * Math.log10(maxTruePeak + 1e-10) * 10) / 10,
		range:
			Math.round(
				(finalBlocks.length > 0
					? Math.max(...finalBlocks) - Math.min(...finalBlocks)
					: 0) * 10,
			) / 10,
	};
}

/**
 * True ⇒ the measured signal is indistinguishable from silence (every block
 * gated out or floored). Distinguishes "this footage is silent" (a real
 * finding) from "measurement never ran" for the `loudness`/`silence`
 * `DerivedStatus` — see `derived-status.ts`.
 */
export function isEffectivelySilent(measurement: LUFSMeasurement): boolean {
	return (
		measurement.integrated <= ABSOLUTE_GATE_LUFS && measurement.truePeak <= -60
	);
}

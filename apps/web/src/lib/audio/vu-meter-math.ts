/**
 * Pure dB-conversion + decay state machine for the timeline VU meter
 * (components/editor/panels/timeline/timeline-vu-meter.tsx drives this off
 * an AnalyserNode peak read each rAF tick).
 *
 * No Web Audio, no DOM/canvas — independently unit-testable. Numeric
 * parameters per apps/web/docs/poach/palmier-delta-refresh-2026-07-14.md
 * §4.2: −60dB floor, level decay 24dB/s, peak-hold 1.5s then decay 18dB/s,
 * and a clip segment that latches at 0dBFS until cleared.
 */

export const VU_FLOOR_DB = -60;
export const VU_LEVEL_DECAY_DB_PER_SEC = 24;
export const VU_PEAK_HOLD_SECONDS = 1.5;
export const VU_PEAK_DECAY_DB_PER_SEC = 18;
export const VU_CLIP_THRESHOLD_DB = 0;

/** Convert a linear peak sample amplitude (0..1, occasionally >1 on hot
 * digital mixes) to dBFS, floored at VU_FLOOR_DB. */
export function linearToDb(amplitude: number): number {
	const abs = Math.abs(amplitude);
	if (abs <= 0) return VU_FLOOR_DB;
	return Math.max(VU_FLOOR_DB, 20 * Math.log10(abs));
}

export interface VuChannelState {
	/** Current displayed level, in dBFS (decays over time). */
	levelDb: number;
	/** Held peak marker, in dBFS. */
	peakDb: number;
	/** Seconds since the peak marker last moved up. */
	peakHeldForSeconds: number;
	/** True once 0dBFS has been hit; stays true until explicitly cleared. */
	clipped: boolean;
}

export function createInitialVuChannelState(): VuChannelState {
	return {
		levelDb: VU_FLOOR_DB,
		peakDb: VU_FLOOR_DB,
		peakHeldForSeconds: 0,
		clipped: false,
	};
}

/**
 * Advance one channel's meter state by `dtSeconds` given a new instantaneous
 * reading `inputDb`. The level jumps up instantly to a louder input (peak
 * meters don't attack-smooth) and decays at a fixed dB/s otherwise. The peak
 * marker rides the level up, then holds for VU_PEAK_HOLD_SECONDS before
 * decaying at its own (slower) rate. The clip latch is sticky: once tripped
 * it only clears via `clearClipLatch`.
 */
export function stepVuChannelState({
	state,
	inputDb,
	dtSeconds,
}: {
	state: VuChannelState;
	inputDb: number;
	dtSeconds: number;
}): VuChannelState {
	const clampedInput = Math.max(VU_FLOOR_DB, inputDb);
	const safeDt = Math.max(0, dtSeconds);

	const decayedLevel = state.levelDb - VU_LEVEL_DECAY_DB_PER_SEC * safeDt;
	const levelDb = Math.max(VU_FLOOR_DB, Math.max(clampedInput, decayedLevel));

	let peakDb = state.peakDb;
	let peakHeldForSeconds = state.peakHeldForSeconds + safeDt;

	if (levelDb >= peakDb) {
		peakDb = levelDb;
		peakHeldForSeconds = 0;
	} else if (peakHeldForSeconds > VU_PEAK_HOLD_SECONDS) {
		peakDb = Math.max(VU_FLOOR_DB, peakDb - VU_PEAK_DECAY_DB_PER_SEC * safeDt);
	}

	const clipped = state.clipped || clampedInput >= VU_CLIP_THRESHOLD_DB;

	return { levelDb, peakDb, peakHeldForSeconds, clipped };
}

/** Clears a latched clip indicator — called on user click, per spec. */
export function clearClipLatch(state: VuChannelState): VuChannelState {
	if (!state.clipped) return state;
	return { ...state, clipped: false };
}

/** Normalizes a dBFS value to a 0..1 fraction of the meter's visible range
 * (VU_FLOOR_DB..0dB), for drawing. Values above 0dB clamp to 1. */
export function dbToUnitRange(db: number): number {
	return Math.max(0, Math.min(1, (db - VU_FLOOR_DB) / -VU_FLOOR_DB));
}

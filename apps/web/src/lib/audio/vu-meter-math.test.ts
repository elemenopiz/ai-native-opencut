import { describe, expect, test } from "bun:test";
import {
	VU_CLIP_THRESHOLD_DB,
	VU_FLOOR_DB,
	VU_LEVEL_DECAY_DB_PER_SEC,
	VU_PEAK_DECAY_DB_PER_SEC,
	VU_PEAK_HOLD_SECONDS,
	clearClipLatch,
	createInitialVuChannelState,
	dbToUnitRange,
	linearToDb,
	stepVuChannelState,
} from "./vu-meter-math";

describe("linearToDb", () => {
	test("full-scale amplitude is 0dB", () => {
		expect(linearToDb(1)).toBeCloseTo(0, 5);
	});

	test("silence floors at VU_FLOOR_DB", () => {
		expect(linearToDb(0)).toBe(VU_FLOOR_DB);
	});

	test("half amplitude is about -6dB", () => {
		expect(linearToDb(0.5)).toBeCloseTo(-6.02, 1);
	});

	test("negative samples use their magnitude", () => {
		expect(linearToDb(-1)).toBeCloseTo(0, 5);
	});

	test("a value quieter than the floor still clamps to the floor", () => {
		expect(linearToDb(0.0000001)).toBe(VU_FLOOR_DB);
	});
});

describe("stepVuChannelState — level", () => {
	test("jumps up instantly to a louder input", () => {
		const state = createInitialVuChannelState();
		const next = stepVuChannelState({ state, inputDb: -10, dtSeconds: 0 });
		expect(next.levelDb).toBe(-10);
	});

	test("decays at VU_LEVEL_DECAY_DB_PER_SEC when input drops to silence", () => {
		let state = createInitialVuChannelState();
		state = stepVuChannelState({ state, inputDb: -10, dtSeconds: 0 });
		const next = stepVuChannelState({
			state,
			inputDb: VU_FLOOR_DB,
			dtSeconds: 1,
		});
		expect(next.levelDb).toBeCloseTo(-10 - VU_LEVEL_DECAY_DB_PER_SEC, 5);
	});

	test("level never decays below the floor", () => {
		let state = createInitialVuChannelState();
		state = stepVuChannelState({ state, inputDb: -10, dtSeconds: 0 });
		const next = stepVuChannelState({
			state,
			inputDb: VU_FLOOR_DB,
			dtSeconds: 10,
		});
		expect(next.levelDb).toBe(VU_FLOOR_DB);
	});

	test("a louder input mid-decay re-jumps the level up", () => {
		let state = createInitialVuChannelState();
		state = stepVuChannelState({ state, inputDb: -10, dtSeconds: 0 });
		state = stepVuChannelState({ state, inputDb: VU_FLOOR_DB, dtSeconds: 0.1 });
		const next = stepVuChannelState({ state, inputDb: -3, dtSeconds: 0 });
		expect(next.levelDb).toBe(-3);
	});
});

describe("stepVuChannelState — peak hold", () => {
	test("peak rides the level up immediately", () => {
		const state = createInitialVuChannelState();
		const next = stepVuChannelState({ state, inputDb: -5, dtSeconds: 0 });
		expect(next.peakDb).toBe(-5);
		expect(next.peakHeldForSeconds).toBe(0);
	});

	test("peak holds steady while within the hold window as level decays", () => {
		let state = createInitialVuChannelState();
		state = stepVuChannelState({ state, inputDb: -5, dtSeconds: 0 });
		// silence the input and step forward less than the hold window
		state = stepVuChannelState({
			state,
			inputDb: VU_FLOOR_DB,
			dtSeconds: VU_PEAK_HOLD_SECONDS - 0.1,
		});
		expect(state.peakDb).toBe(-5);
	});

	test("peak decays at VU_PEAK_DECAY_DB_PER_SEC once held past the hold window", () => {
		let state = createInitialVuChannelState();
		state = stepVuChannelState({ state, inputDb: -5, dtSeconds: 0 });
		// push past the hold window in two steps: first to exactly the boundary,
		// then decay for exactly 1s beyond it.
		state = stepVuChannelState({
			state,
			inputDb: VU_FLOOR_DB,
			dtSeconds: VU_PEAK_HOLD_SECONDS + 0.001,
		});
		const beforeDecayPeak = state.peakDb;
		const next = stepVuChannelState({
			state,
			inputDb: VU_FLOOR_DB,
			dtSeconds: 1,
		});
		expect(next.peakDb).toBeCloseTo(
			beforeDecayPeak - VU_PEAK_DECAY_DB_PER_SEC,
			5,
		);
	});

	test("peak never decays below the floor", () => {
		let state = createInitialVuChannelState();
		state = stepVuChannelState({ state, inputDb: -5, dtSeconds: 0 });
		state = stepVuChannelState({
			state,
			inputDb: VU_FLOOR_DB,
			dtSeconds: VU_PEAK_HOLD_SECONDS + 100,
		});
		expect(state.peakDb).toBe(VU_FLOOR_DB);
	});
});

describe("stepVuChannelState / clearClipLatch — clip latch", () => {
	test("latches on a 0dBFS (full-scale) hit", () => {
		const state = createInitialVuChannelState();
		const next = stepVuChannelState({
			state,
			inputDb: VU_CLIP_THRESHOLD_DB,
			dtSeconds: 0,
		});
		expect(next.clipped).toBe(true);
	});

	test("does not latch below the clip threshold", () => {
		const state = createInitialVuChannelState();
		const next = stepVuChannelState({ state, inputDb: -1, dtSeconds: 0 });
		expect(next.clipped).toBe(false);
	});

	test("stays latched across subsequent quiet steps", () => {
		let state = createInitialVuChannelState();
		state = stepVuChannelState({
			state,
			inputDb: VU_CLIP_THRESHOLD_DB,
			dtSeconds: 0,
		});
		state = stepVuChannelState({
			state,
			inputDb: VU_FLOOR_DB,
			dtSeconds: 5,
		});
		expect(state.clipped).toBe(true);
	});

	test("clearClipLatch resets the latch", () => {
		let state = createInitialVuChannelState();
		state = stepVuChannelState({
			state,
			inputDb: VU_CLIP_THRESHOLD_DB,
			dtSeconds: 0,
		});
		const cleared = clearClipLatch(state);
		expect(cleared.clipped).toBe(false);
	});

	test("clearClipLatch is a no-op (same shape) when not clipped", () => {
		const state = createInitialVuChannelState();
		const cleared = clearClipLatch(state);
		expect(cleared.clipped).toBe(false);
	});

	test("a fresh clip after clearing re-latches", () => {
		let state = createInitialVuChannelState();
		state = stepVuChannelState({
			state,
			inputDb: VU_CLIP_THRESHOLD_DB,
			dtSeconds: 0,
		});
		state = clearClipLatch(state);
		state = stepVuChannelState({
			state,
			inputDb: VU_CLIP_THRESHOLD_DB,
			dtSeconds: 0,
		});
		expect(state.clipped).toBe(true);
	});
});

describe("dbToUnitRange", () => {
	test("floor maps to 0", () => {
		expect(dbToUnitRange(VU_FLOOR_DB)).toBe(0);
	});

	test("0dB maps to 1", () => {
		expect(dbToUnitRange(0)).toBe(1);
	});

	test("clamps above 0dB", () => {
		expect(dbToUnitRange(6)).toBe(1);
	});

	test("clamps below the floor", () => {
		expect(dbToUnitRange(VU_FLOOR_DB - 10)).toBe(0);
	});

	test("midpoint is 0.5", () => {
		expect(dbToUnitRange(VU_FLOOR_DB / 2)).toBeCloseTo(0.5, 5);
	});
});

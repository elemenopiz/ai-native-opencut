import { describe, expect, it } from "bun:test";
import {
	applyVolumeAutomationPlan,
	buildVolumeAutomationPlan,
	type AudioParamLike,
} from "@/core/managers/audio-manager";
import type { NumberKeyframe } from "@/types/animation";

/**
 * `buildVolumeAutomationPlan` is the pure scheduling core behind honoring an
 * element's `volume` keyframes during playback (`AudioManager.
 * getOrCreateAnimatedClipGain`, C9/BUG "auto-duck is inaudible"). It's kept
 * AudioContext-free so the sampling/scheduling logic is testable without a
 * real audio graph — `localTimeToContextTime` stands in for the timeline→
 * AudioContext time mapping `AudioManager` does with
 * `playbackStartContextTime`/`playbackLatencyCompensationSeconds`.
 */

function kf(
	time: number,
	value: number,
	interpolation: "linear" | "hold" = "linear",
): NumberKeyframe {
	return { id: `kf-${time}`, time, value, interpolation };
}

// Simple fixed offset so assertions can read as "base + localTime".
const BASE = 100;
const identityMap = (localTime: number) => BASE + localTime;

describe("buildVolumeAutomationPlan", () => {
	it("returns an empty plan when the clip has no keyframes", () => {
		const plan = buildVolumeAutomationPlan({
			keyframes: [],
			nowLocalTime: 0,
			fallbackValue: 1,
			localTimeToContextTime: identityMap,
		});
		expect(plan).toEqual([]);
	});

	it("starting before the first keyframe anchors at the first value, then ramps through every future keyframe", () => {
		const keyframes = [kf(0, 1), kf(2, 0.2), kf(5, 1)];
		const plan = buildVolumeAutomationPlan({
			keyframes,
			nowLocalTime: -5,
			fallbackValue: 1,
			localTimeToContextTime: identityMap,
		});

		expect(plan).toEqual([
			{ kind: "set", value: 1, contextTime: BASE + 0 },
			{ kind: "ramp", value: 0.2, contextTime: BASE + 2 },
			{ kind: "ramp", value: 1, contextTime: BASE + 5 },
		]);
	});

	it("starting mid-span anchors at the interpolated value and drops already-elapsed keyframes", () => {
		const keyframes = [kf(0, 1), kf(2, 0.2), kf(5, 1)];
		const plan = buildVolumeAutomationPlan({
			keyframes,
			nowLocalTime: 3, // between the (2, 0.2) and (5, 1) keyframes
			fallbackValue: 1,
			localTimeToContextTime: identityMap,
		});

		expect(plan).toHaveLength(2);
		expect(plan[0].kind).toBe("set");
		expect(plan[0].contextTime).toBe(BASE + 3);
		// progress = (3-2)/(5-2) = 1/3 -> 0.2 + (1-0.2)/3
		expect(plan[0].value).toBeCloseTo(0.2 + 0.8 / 3, 6);
		expect(plan[1]).toEqual({ kind: "ramp", value: 1, contextTime: BASE + 5 });
	});

	it("starting after the last keyframe holds flat — only the anchor step is scheduled", () => {
		const keyframes = [kf(0, 1), kf(2, 0.2), kf(5, 1)];
		const plan = buildVolumeAutomationPlan({
			keyframes,
			nowLocalTime: 10,
			fallbackValue: 1,
			localTimeToContextTime: identityMap,
		});

		expect(plan).toEqual([{ kind: "set", value: 1, contextTime: BASE + 10 }]);
	});

	it("a 'hold' keyframe produces a 'set' step at the next keyframe's time, not a ramp", () => {
		const keyframes = [kf(0, 1), kf(2, 0.2, "hold"), kf(4, 1)];
		const plan = buildVolumeAutomationPlan({
			keyframes,
			nowLocalTime: 0,
			fallbackValue: 1,
			localTimeToContextTime: identityMap,
		});

		expect(plan).toEqual([
			{ kind: "set", value: 1, contextTime: BASE + 0 },
			{ kind: "ramp", value: 0.2, contextTime: BASE + 2 },
			// segment (2 -> 4) is governed by the keyframe AT time 2, which is "hold"
			{ kind: "set", value: 1, contextTime: BASE + 4 },
		]);
	});

	it("a single keyframe produces just the anchor (flat volume for the whole clip)", () => {
		const plan = buildVolumeAutomationPlan({
			keyframes: [kf(0, 0.5)],
			nowLocalTime: 0,
			fallbackValue: 1,
			localTimeToContextTime: identityMap,
		});
		expect(plan).toEqual([{ kind: "set", value: 0.5, contextTime: BASE + 0 }]);
	});

	it("negative nowLocalTime clamps to 0 (defensive against a bad caller)", () => {
		const plan = buildVolumeAutomationPlan({
			keyframes: [kf(0, 1), kf(2, 0.2)],
			nowLocalTime: -100,
			fallbackValue: 1,
			localTimeToContextTime: identityMap,
		});
		expect(plan[0]).toEqual({ kind: "set", value: 1, contextTime: BASE + 0 });
	});
});

describe("applyVolumeAutomationPlan", () => {
	it("dispatches 'set' steps to setValueAtTime and 'ramp' steps to linearRampToValueAtTime, in order", () => {
		const calls: Array<{ method: string; value: number; time: number }> = [];
		const fakeParam: AudioParamLike = {
			setValueAtTime: (value, startTime) => {
				calls.push({ method: "set", value, time: startTime });
			},
			linearRampToValueAtTime: (value, endTime) => {
				calls.push({ method: "ramp", value, time: endTime });
			},
		};

		applyVolumeAutomationPlan({
			gainParam: fakeParam,
			plan: [
				{ kind: "set", value: 1, contextTime: 10 },
				{ kind: "ramp", value: 0.2, contextTime: 12 },
				{ kind: "set", value: 1, contextTime: 14 },
			],
		});

		expect(calls).toEqual([
			{ method: "set", value: 1, time: 10 },
			{ method: "ramp", value: 0.2, time: 12 },
			{ method: "set", value: 1, time: 14 },
		]);
	});

	it("applying an empty plan makes no calls", () => {
		let callCount = 0;
		const fakeParam: AudioParamLike = {
			setValueAtTime: () => {
				callCount++;
			},
			linearRampToValueAtTime: () => {
				callCount++;
			},
		};
		applyVolumeAutomationPlan({ gainParam: fakeParam, plan: [] });
		expect(callCount).toBe(0);
	});
});

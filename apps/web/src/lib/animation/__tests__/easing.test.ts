import { describe, expect, test } from "bun:test";
import type { NumberAnimationChannel } from "@/types/animation";
import {
	applyEasing,
	easingFromBezier,
	easingFromPreset,
	evaluateCubicBezier,
	getNumberChannelValueAtTime,
	matchEasingPreset,
	EASING_PRESETS,
} from "@/lib/animation";

describe("cubic-bezier easing", () => {
	test("linear preset is the identity curve", () => {
		for (const progress of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
			expect(
				evaluateCubicBezier({ bezier: EASING_PRESETS.linear, progress }),
			).toBeCloseTo(progress, 6);
		}
	});

	test("endpoints are pinned to 0 and 1 for every preset", () => {
		for (const bezier of Object.values(EASING_PRESETS)) {
			expect(evaluateCubicBezier({ bezier, progress: 0 })).toBeCloseTo(0, 6);
			expect(evaluateCubicBezier({ bezier, progress: 1 })).toBeCloseTo(1, 6);
		}
	});

	test("ease-in accelerates (below linear before the midpoint)", () => {
		const eased = evaluateCubicBezier({
			bezier: EASING_PRESETS["ease-in"],
			progress: 0.5,
		});
		expect(eased).toBeLessThan(0.5);
	});

	test("ease-out decelerates (above linear before the midpoint)", () => {
		const eased = evaluateCubicBezier({
			bezier: EASING_PRESETS["ease-out"],
			progress: 0.5,
		});
		expect(eased).toBeGreaterThan(0.5);
	});

	test("ease-in-out is symmetric about the midpoint", () => {
		const early = evaluateCubicBezier({
			bezier: EASING_PRESETS["ease-in-out"],
			progress: 0.25,
		});
		const late = evaluateCubicBezier({
			bezier: EASING_PRESETS["ease-in-out"],
			progress: 0.75,
		});
		expect(early + late).toBeCloseTo(1, 3);
	});

	test("applyEasing returns raw progress when easing is undefined", () => {
		expect(applyEasing({ easing: undefined, progress: 0.42 })).toBe(0.42);
	});

	test("preset and bezier helpers round-trip", () => {
		const fromPreset = easingFromPreset({ preset: "ease-in-out" });
		expect(fromPreset.bezier).toEqual(EASING_PRESETS["ease-in-out"]);
		expect(matchEasingPreset({ bezier: fromPreset.bezier })).toBe("ease-in-out");

		const fromBezier = easingFromBezier({ bezier: [0.42, 0, 0.58, 1] });
		expect(fromBezier.preset).toBe("ease-in-out");
	});
});

describe("eased channel interpolation", () => {
	const makeChannel = (
		easing: NumberAnimationChannel["keyframes"][number]["easing"],
	): NumberAnimationChannel => ({
		valueKind: "number",
		keyframes: [
			{ id: "a", time: 0, value: 0, interpolation: "linear", easing },
			{ id: "b", time: 1, value: 100, interpolation: "linear" },
		],
	});

	test("linear keyframes (no easing) are unchanged — backward compatible", () => {
		const channel = makeChannel(undefined);
		expect(
			getNumberChannelValueAtTime({ channel, time: 0.5, fallbackValue: 0 }),
		).toBeCloseTo(50, 6);
	});

	test("ease-in produces a smaller value than linear at the midpoint", () => {
		const channel = makeChannel(easingFromPreset({ preset: "ease-in" }));
		const value = getNumberChannelValueAtTime({
			channel,
			time: 0.5,
			fallbackValue: 0,
		});
		expect(value).toBeLessThan(50);
		expect(value).toBeGreaterThan(0);
	});
});

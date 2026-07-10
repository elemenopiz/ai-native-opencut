import { describe, expect, it } from "bun:test";
import {
	bibleToConsistencyInput,
	buildStoryboardPlan,
	type StyleBible,
} from "./storyboard-plan";

describe("buildStoryboardPlan", () => {
	it("assigns 1-based indices, carries creative notes, and sums duration", () => {
		const plan = buildStoryboardPlan({
			shots: [
				{
					prompt: "wide of a misty coffee farm at dawn",
					duration: 5,
					intent: "cold-open establishing shot",
					camera: "slow push-in, 35mm",
					subject: "empty farm, low fog",
				},
				{
					prompt: "hands grinding beans",
					duration: 4,
					subject: "Mara, mid-shot",
				},
			],
			bible: { palette: "warm amber" },
		});

		expect(plan.shotCount).toBe(2);
		expect(plan.totalDuration).toBe(9);
		expect(plan.bible).toEqual({ palette: "warm amber" });
		expect(plan.shots[0]).toMatchObject({
			index: 1,
			prompt: "wide of a misty coffee farm at dawn",
			duration: 5,
			intent: "cold-open establishing shot",
			camera: "slow push-in, 35mm",
			subject: "empty farm, low fog",
		});
		expect(plan.shots[1].index).toBe(2);
		// slotId is only assigned once slots are materialized by the verb.
		expect(plan.shots[0].slotId).toBeUndefined();
	});

	it("floors a missing / non-positive duration to the 6s default", () => {
		const plan = buildStoryboardPlan({
			shots: [
				{ prompt: "a" },
				{ prompt: "b", duration: 0 },
				{ prompt: "c", duration: -3 },
			],
		});
		expect(plan.shots.map((s) => s.duration)).toEqual([6, 6, 6]);
		expect(plan.totalDuration).toBe(18);
		// No bible supplied → empty bible object, not undefined.
		expect(plan.bible).toEqual({});
	});

	it("omits absent creative notes rather than emitting empty strings", () => {
		const plan = buildStoryboardPlan({
			shots: [{ prompt: "plain", duration: 6 }],
		});
		expect(plan.shots[0]).not.toHaveProperty("intent");
		expect(plan.shots[0]).not.toHaveProperty("camera");
		expect(plan.shots[0]).not.toHaveProperty("subject");
	});
});

describe("bibleToConsistencyInput", () => {
	it("joins palette + lensMood into one STYLE paragraph and passes cast/setting through", () => {
		const bible: StyleBible = {
			palette: "warm amber highlights, teal shadows",
			lensMood: "anamorphic, dreamy, shallow DoF",
			setting: "a coffee farm at dawn",
			characters: [{ name: "Mara", descriptor: "barista, 30s, curly hair" }],
		};
		expect(bibleToConsistencyInput(bible)).toEqual({
			style:
				"warm amber highlights, teal shadows; anamorphic, dreamy, shallow DoF",
			setting: "a coffee farm at dawn",
			extraCharacters: [
				{ name: "Mara", descriptor: "barista, 30s, curly hair" },
			],
		});
	});

	it("uses whichever style field is present", () => {
		expect(bibleToConsistencyInput({ palette: "noir monochrome" })).toEqual({
			style: "noir monochrome",
		});
		expect(bibleToConsistencyInput({ lensMood: "handheld, gritty" })).toEqual({
			style: "handheld, gritty",
		});
	});

	it("returns undefined for an empty / whitespace-only bible so seeding is skipped", () => {
		expect(bibleToConsistencyInput(undefined)).toBeUndefined();
		expect(bibleToConsistencyInput({})).toBeUndefined();
		expect(
			bibleToConsistencyInput({ palette: "   ", setting: "", characters: [] }),
		).toBeUndefined();
	});
});

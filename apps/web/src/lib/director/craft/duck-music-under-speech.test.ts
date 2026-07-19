import { describe, expect, it } from "bun:test";
import {
	DEFAULT_ATTACK_SEC,
	DEFAULT_DUCK_AMOUNT_DB,
	DEFAULT_MERGE_GAP_SEC,
	DEFAULT_RELEASE_SEC,
	type DuckMusicElement,
	duckMusicUnderSpeech,
	type SpeechInterval,
} from "./duck-music-under-speech";

const DUCKED = 10 ** (DEFAULT_DUCK_AMOUNT_DB / 20);

function speech(startSec: number, endSec: number): SpeechInterval {
	return { startSec, endSec };
}

function music(
	elementId: string,
	startSec: number,
	durationSec: number,
): DuckMusicElement {
	return { elementId, startSec, durationSec };
}

describe("duckMusicUnderSpeech", () => {
	it("plans a full attack/duck/recover/release cycle for one speech interval", () => {
		const plan = duckMusicUnderSpeech([speech(5, 8)], [music("m1", 0, 20)]);

		expect(plan.mergedIntervalCount).toBe(1);
		expect(plan.ops).toEqual([
			{
				verb: "animateItem",
				args: {
					itemId: "m1",
					property: "volume",
					keyframes: [
						{ time: 4.85, value: 1, interpolation: "linear" },
						{ time: 5, value: DUCKED, interpolation: "linear" },
						{ time: 8, value: DUCKED, interpolation: "linear" },
						{ time: 8.4, value: 1, interpolation: "linear" },
					],
				},
			},
		]);
	});

	it("merges speech intervals separated by less than mergeGapSec into one continuous duck", () => {
		// gap = 6.2 - 6 = 0.2s < default 300ms
		const plan = duckMusicUnderSpeech(
			[speech(5, 6), speech(6.2, 7)],
			[music("m1", 0, 20)],
		);
		expect(plan.mergedIntervalCount).toBe(1);
		const keyframes = (plan.ops[0].args as { keyframes: unknown[] }).keyframes;
		expect(keyframes).toHaveLength(4); // one continuous cycle, not two
	});

	it("does not merge speech intervals with a gap at/above mergeGapSec (interval level)", () => {
		// gap = 0.4s, comfortably above default mergeGapSec (0.3s) — stays separate at the interval level.
		const plan = duckMusicUnderSpeech(
			[speech(5, 6), speech(6.4, 7)],
			[music("m1", 0, 20)],
		);
		expect(plan.mergedIntervalCount).toBe(2);
	});

	it("suppresses flutter even when the gap survives interval-merge, if the ramps would still cross", () => {
		// gap = 0.35s >= mergeGapSec (not interval-merged) but < attack+release (0.15+0.4=0.55s),
		// so the ramps would cross — the per-element flutter merge must still collapse them.
		const plan = duckMusicUnderSpeech(
			[speech(5, 6), speech(6.35, 7)],
			[music("m1", 0, 20)],
		);
		expect(plan.mergedIntervalCount).toBe(2); // NOT merged at the interval level...
		const keyframes = (plan.ops[0].args as { keyframes: unknown[] }).keyframes;
		expect(keyframes).toHaveLength(4); // ...but still ONE continuous duck cycle, not two crossing ones.
		expect(keyframes).toEqual([
			{ time: 4.85, value: 1, interpolation: "linear" },
			{ time: 5, value: DUCKED, interpolation: "linear" },
			{ time: 7, value: DUCKED, interpolation: "linear" },
			{ time: 7.4, value: 1, interpolation: "linear" },
		]);
	});

	it("emits two independent duck cycles when the gap is wide enough that ramps do not cross", () => {
		// gap = 1s, comfortably wider than attack+release (0.55s) — two clean cycles.
		const plan = duckMusicUnderSpeech(
			[speech(5, 6), speech(7, 8)],
			[music("m1", 0, 20)],
		);
		expect(plan.mergedIntervalCount).toBe(2);
		const keyframes = (plan.ops[0].args as { keyframes: unknown[] }).keyframes;
		expect(keyframes).toHaveLength(8);
	});

	it("clamps ramps to the music element's own boundaries", () => {
		// music spans [5,8]; speech starts before the element and ends inside it.
		const plan = duckMusicUnderSpeech([speech(4, 6)], [music("m1", 5, 3)]);
		const keyframes = (plan.ops[0].args as { keyframes: unknown[] }).keyframes;
		// No leading fade-in keyframe: the element itself starts already-ducked.
		expect(keyframes).toEqual([
			{ time: 0, value: DUCKED, interpolation: "linear" },
			{ time: 1, value: DUCKED, interpolation: "linear" },
			{ time: 1.4, value: 1, interpolation: "linear" },
		]);
	});

	it("skips a music element with no overlapping speech entirely (no op emitted)", () => {
		const plan = duckMusicUnderSpeech([speech(10, 12)], [music("m1", 0, 5)]);
		expect(plan.ops).toEqual([]);
	});

	it("plans independently per music element — only overlapping elements get an op", () => {
		const plan = duckMusicUnderSpeech(
			[speech(5, 6)],
			[music("m1", 0, 20), music("m2", 100, 20)],
		);
		expect(plan.ops).toHaveLength(1);
		expect((plan.ops[0].args as { itemId: string }).itemId).toBe("m1");
	});

	it("returns an empty plan (mergedIntervalCount 0) for no speech at all", () => {
		const plan = duckMusicUnderSpeech([], [music("m1", 0, 20)]);
		expect(plan).toEqual({ ops: [], mergedIntervalCount: 0 });
	});

	it("returns an empty ops list but still reports mergedIntervalCount with no music elements", () => {
		const plan = duckMusicUnderSpeech([speech(5, 6)], []);
		expect(plan.ops).toEqual([]);
		expect(plan.mergedIntervalCount).toBe(1);
	});

	it("respects configurable duckAmountDb / attackSec / releaseSec / mergeGapSec", () => {
		const plan = duckMusicUnderSpeech([speech(5, 6)], [music("m1", 0, 20)], {
			duckAmountDb: -6,
			attackSec: 0.2,
			releaseSec: 0.5,
		});
		const duckedAtMinus6 = 10 ** (-6 / 20);
		const keyframes = (plan.ops[0].args as { keyframes: unknown[] }).keyframes;
		expect(keyframes).toEqual([
			{ time: 4.8, value: 1, interpolation: "linear" },
			{ time: 5, value: duckedAtMinus6, interpolation: "linear" },
			{ time: 6, value: duckedAtMinus6, interpolation: "linear" },
			{ time: 6.5, value: 1, interpolation: "linear" },
		]);
	});

	it("exposes its documented defaults", () => {
		expect(DEFAULT_DUCK_AMOUNT_DB).toBe(-12);
		expect(DEFAULT_ATTACK_SEC).toBe(0.15);
		expect(DEFAULT_RELEASE_SEC).toBe(0.4);
		expect(DEFAULT_MERGE_GAP_SEC).toBe(0.3);
	});

	it("is order-independent: unsorted speech intervals merge the same as sorted ones", () => {
		const sorted = duckMusicUnderSpeech(
			[speech(5, 6), speech(6.2, 7)],
			[music("m1", 0, 20)],
		);
		const unsorted = duckMusicUnderSpeech(
			[speech(6.2, 7), speech(5, 6)],
			[music("m1", 0, 20)],
		);
		expect(unsorted).toEqual(sorted);
	});

	it("is deterministic: same input twice yields deep-equal plans", () => {
		const intervals = [speech(5, 6), speech(7, 8), speech(8.2, 9)];
		const elements = [music("m1", 0, 20), music("m2", 15, 10)];
		const p1 = duckMusicUnderSpeech(intervals, elements);
		const p2 = duckMusicUnderSpeech(intervals, elements);
		expect(p1).toEqual(p2);
	});
});

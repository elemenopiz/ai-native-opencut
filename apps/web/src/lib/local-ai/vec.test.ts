import { describe, expect, it } from "bun:test";
import { l2Normalize } from "./vec";

describe("l2Normalize", () => {
	it("scales each vector to unit length, preserving direction and order", () => {
		const [a, b] = l2Normalize([
			[3, 4],
			[0, 0, 2],
		]);

		expect(a[0]).toBeCloseTo(0.6);
		expect(a[1]).toBeCloseTo(0.8);
		expect(b).toEqual([0, 0, 1]);

		const norm = Math.hypot(...a);
		expect(norm).toBeCloseTo(1);
	});

	it("returns zero vectors unchanged instead of dividing by zero", () => {
		const [zero] = l2Normalize([[0, 0, 0]]);
		expect(zero).toEqual([0, 0, 0]);
		expect(zero.every(Number.isFinite)).toBe(true);
	});

	it("does not mutate its input", () => {
		const input = [[3, 4]];
		l2Normalize(input);
		expect(input).toEqual([[3, 4]]);
	});
});

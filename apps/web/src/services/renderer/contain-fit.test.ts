import { describe, expect, it } from "bun:test";
import { computeContainFit } from "./contain-fit";

describe("computeContainFit", () => {
	it("pillarboxes a 16:9 source into a 9:16 destination", () => {
		const rect = computeContainFit({
			src: { width: 1920, height: 1080 },
			dst: { width: 1080, height: 1920 },
		});

		// Scale is bound by width: 1080 / 1920 = 0.5625
		expect(rect.width).toBe(1080);
		expect(rect.height).toBe(608); // round(1080 * 0.5625)
		expect(rect.x).toBe(0);
		// Vertical gutter split symmetrically top/bottom within 1px.
		const bottomGutter = 1920 - (rect.y + rect.height);
		expect(Math.abs(rect.y - bottomGutter)).toBeLessThanOrEqual(1);
	});

	it("letterboxes a 9:16 source into a 16:9 destination", () => {
		const rect = computeContainFit({
			src: { width: 1080, height: 1920 },
			dst: { width: 1920, height: 1080 },
		});

		// Scale is bound by height: 1080 / 1920 = 0.5625
		expect(rect.height).toBe(1080);
		expect(rect.width).toBe(608); // round(1080 * 0.5625)
		expect(rect.y).toBe(0);
		const rightGutter = 1920 - (rect.x + rect.width);
		expect(Math.abs(rect.x - rightGutter)).toBeLessThanOrEqual(1);
	});

	it("degenerates to a pure scale with no bars when aspect ratios match", () => {
		const rect = computeContainFit({
			src: { width: 1280, height: 720 },
			dst: { width: 1920, height: 1080 },
		});

		expect(rect).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
	});

	it("scales down and centers a larger source into a smaller equal-aspect destination", () => {
		const rect = computeContainFit({
			src: { width: 3840, height: 2160 },
			dst: { width: 1920, height: 1080 },
		});

		expect(rect).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
	});

	it("returns integral x/y/width/height and a symmetric gutter for odd source sizes", () => {
		const rect = computeContainFit({
			src: { width: 1001, height: 667 },
			dst: { width: 1080, height: 1080 },
		});

		expect(Number.isInteger(rect.x)).toBe(true);
		expect(Number.isInteger(rect.y)).toBe(true);
		expect(Number.isInteger(rect.width)).toBe(true);
		expect(Number.isInteger(rect.height)).toBe(true);

		const rightGutter = 1080 - (rect.x + rect.width);
		const bottomGutter = 1080 - (rect.y + rect.height);
		expect(Math.abs(rect.x - rightGutter)).toBeLessThanOrEqual(1);
		expect(Math.abs(rect.y - bottomGutter)).toBeLessThanOrEqual(1);
	});

	it("handles an odd destination size (e.g. 1080x1350) with a symmetric gutter", () => {
		const rect = computeContainFit({
			src: { width: 1920, height: 1080 },
			dst: { width: 1080, height: 1350 },
		});

		const rightGutter = 1080 - (rect.x + rect.width);
		const bottomGutter = 1350 - (rect.y + rect.height);
		expect(Math.abs(rect.x - rightGutter)).toBeLessThanOrEqual(1);
		expect(Math.abs(rect.y - bottomGutter)).toBeLessThanOrEqual(1);
	});
});

import { describe, expect, it } from "bun:test";
import { costFor } from "../cost-table";
import { estimateImageCredits, estimateVideoCredits } from "../estimate";

/**
 * The client-safe estimator must never drift from `costFor()` — this is the
 * whole point of building it on top of `cost-table.ts` instead of a second
 * hand-maintained table. These tests pin that equivalence for every known
 * backend, plus the "backend not known yet" fallback range.
 */
describe("estimateVideoCredits — backend-aware (exact)", () => {
	it("matches costFor() exactly for every registered video backend", () => {
		for (const [id, seconds] of [
			["byteplus-seedance", 5],
			["kling", 7],
			["luma-ray", 5],
			["runway", 4],
			["pika", 9],
			["google-veo", 6],
			["google-veo-fast", 6],
		] as const) {
			const exact = costFor(id, "video", { seconds });
			expect(estimateVideoCredits(seconds, id)).toEqual({
				low: exact,
				high: exact,
			});
		}
	});

	it("threads `resolution` through to costFor() for the resolution-degressive Seedance rate", () => {
		for (const resolution of ["480p", "720p", "1080p"] as const) {
			const exact = costFor("byteplus-seedance", "video", {
				seconds: 5,
				resolution,
			});
			expect(estimateVideoCredits(5, "byteplus-seedance", resolution)).toEqual({
				low: exact,
				high: exact,
			});
		}
	});

	it("falls back to the cross-backend range for an unknown/unpinned backend", () => {
		// pika (11/sec sale) is cheapest, runway (80/sec sale) is priciest —
		// google-veo's 64/sec sale doesn't move either extreme.
		expect(estimateVideoCredits(5)).toEqual({ low: 55, high: 400 });
		expect(estimateVideoCredits(5, "some-future-backend")).toEqual({
			low: 55,
			high: 400,
		});
	});
});

describe("estimateImageCredits — defaults to the registry's default image backend", () => {
	it("matches costFor() for the default backend when none is given", () => {
		const exact = costFor("google-nano-banana", "image", { count: 1 });
		expect(estimateImageCredits()).toEqual({ low: exact, high: exact });
	});

	it("matches costFor() exactly when a backend is given", () => {
		const exact = costFor("ideogram", "image", { count: 3 });
		expect(estimateImageCredits(3, "ideogram")).toEqual({
			low: exact,
			high: exact,
		});
	});

	it("falls back to the cross-backend range for an unknown backend", () => {
		expect(estimateImageCredits(1, "some-future-backend")).toEqual({
			low: 8,
			high: 35,
		});
	});
});

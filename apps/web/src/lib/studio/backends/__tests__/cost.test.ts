import { describe, expect, it } from "bun:test";
import { relativeCostTier } from "../cost";

/**
 * The relative cost tier is the Director's draft/hero routing signal. It buckets a
 * backend's normalized credits against the cheapest available in the same modality
 * (`minCredits`), so the buckets stay meaningful regardless of absolute pricing.
 */
describe("relativeCostTier", () => {
	it("labels the cheapest backend (and near-floor ones) 'cheap'", () => {
		expect(relativeCostTier(100, 100)).toBe("cheap");
		expect(relativeCostTier(130, 100)).toBe("cheap"); // 1.3x ≤ 1.34
	});

	it("labels a mid-priced backend 'standard'", () => {
		expect(relativeCostTier(200, 100)).toBe("standard"); // 2x
		expect(relativeCostTier(250, 100)).toBe("standard"); // 2.5x boundary
	});

	it("labels a pricey backend 'premium'", () => {
		expect(relativeCostTier(300, 100)).toBe("premium"); // 3x
		expect(relativeCostTier(1000, 100)).toBe("premium"); // 10x
	});

	it("is stable when the floor is zero/unknown (no divide-by-zero)", () => {
		expect(relativeCostTier(50, 0)).toBe("cheap");
	});
});

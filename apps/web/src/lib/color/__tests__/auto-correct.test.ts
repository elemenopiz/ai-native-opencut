import { describe, expect, test } from "bun:test";
import { computeScopeSummary } from "../scopes";
import { computeAutoCorrection, layerLookProfile } from "../auto-correct";
import { AUTO_CORRECT_PROFILES } from "../auto-color-profiles";

function solid({
	width,
	height,
	r,
	g,
	b,
}: {
	width: number;
	height: number;
	r: number;
	g: number;
	b: number;
}) {
	const data = new Uint8ClampedArray(width * height * 4);
	for (let i = 0; i < data.length; i += 4) {
		data[i] = r;
		data[i + 1] = g;
		data[i + 2] = b;
		data[i + 3] = 255;
	}
	return { data, width, height };
}

describe("computeAutoCorrection", () => {
	test("dark frame gets positive exposure", () => {
		const summary = computeScopeSummary(
			solid({ width: 4, height: 4, r: 30, g: 30, b: 30 }),
		);
		const adj = computeAutoCorrection({ summary });
		expect(adj.exposure).toBeGreaterThan(0);
	});

	test("bright frame gets negative exposure", () => {
		const summary = computeScopeSummary(
			solid({ width: 4, height: 4, r: 230, g: 230, b: 230 }),
		);
		const adj = computeAutoCorrection({ summary });
		expect(adj.exposure).toBeLessThan(0);
	});

	test("blue cast is warmed (positive temperature)", () => {
		const summary = computeScopeSummary(
			solid({ width: 4, height: 4, r: 90, g: 110, b: 170 }),
		);
		const adj = computeAutoCorrection({ summary });
		expect(adj.temperature).toBeGreaterThan(0);
	});

	test("warm cast is cooled (negative temperature)", () => {
		const summary = computeScopeSummary(
			solid({ width: 4, height: 4, r: 180, g: 120, b: 80 }),
		);
		const adj = computeAutoCorrection({ summary });
		expect(adj.temperature).toBeLessThan(0);
	});

	test("green cast is pushed toward magenta (negative tint)", () => {
		const summary = computeScopeSummary(
			solid({ width: 4, height: 4, r: 100, g: 170, b: 100 }),
		);
		const adj = computeAutoCorrection({ summary });
		expect(adj.tint).toBeLessThan(0);
	});

	test("all outputs stay within the color-adjust param ranges", () => {
		const summary = computeScopeSummary(
			solid({ width: 4, height: 4, r: 5, g: 250, b: 5 }),
		);
		const adj = computeAutoCorrection({ summary });
		expect(adj.exposure).toBeGreaterThanOrEqual(-2);
		expect(adj.exposure).toBeLessThanOrEqual(2);
		expect(adj.contrast).toBeGreaterThanOrEqual(0.2);
		expect(adj.contrast).toBeLessThanOrEqual(3);
		expect(adj.temperature).toBeGreaterThanOrEqual(-1);
		expect(adj.temperature).toBeLessThanOrEqual(1);
		expect(adj.tint).toBeGreaterThanOrEqual(-1);
		expect(adj.tint).toBeLessThanOrEqual(1);
		expect(adj.blacks).toBeLessThanOrEqual(0);
		expect(adj.whites).toBeGreaterThanOrEqual(0);
	});

	test("strength 0 produces a neutral grade", () => {
		const summary = computeScopeSummary(
			solid({ width: 4, height: 4, r: 40, g: 60, b: 150 }),
		);
		const adj = computeAutoCorrection({ summary, strength: 0 });
		expect(adj.exposure).toBe(0);
		expect(adj.temperature).toBe(0);
		expect(adj.tint).toBe(0);
		expect(adj.contrast).toBe(1);
	});
});

describe("layerLookProfile", () => {
	test("layers a look additively/multiplicatively over the base", () => {
		const summary = computeScopeSummary(
			solid({ width: 4, height: 4, r: 128, g: 128, b: 128 }),
		);
		const base = computeAutoCorrection({ summary, strength: 0 });
		const vibrant = AUTO_CORRECT_PROFILES.find((p) => p.name === "Vibrant Pop");
		if (!vibrant) throw new Error("missing Vibrant Pop profile");
		const layered = layerLookProfile({ base, profile: vibrant });
		// base is neutral at strength 0, so layered ≈ the profile itself.
		expect(layered.saturation).toBeCloseTo(vibrant.adjustments.saturation, 5);
		expect(layered.contrast).toBeCloseTo(vibrant.adjustments.contrast, 5);
		expect(layered.temperature).toBeCloseTo(vibrant.adjustments.temperature, 5);
	});

	test("clamps layered results into range", () => {
		const summary = computeScopeSummary(
			solid({ width: 4, height: 4, r: 255, g: 0, b: 0 }),
		);
		const base = computeAutoCorrection({ summary });
		const bw = AUTO_CORRECT_PROFILES.find(
			(p) => p.name === "High Contrast B&W",
		);
		if (!bw) throw new Error("missing High Contrast B&W profile");
		const layered = layerLookProfile({ base, profile: bw });
		expect(layered.contrast).toBeLessThanOrEqual(3);
		expect(layered.saturation).toBeGreaterThanOrEqual(0);
		expect(layered.temperature).toBeGreaterThanOrEqual(-1);
		expect(layered.temperature).toBeLessThanOrEqual(1);
	});
});

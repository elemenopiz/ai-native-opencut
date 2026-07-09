import { describe, expect, test } from "bun:test";
import {
	computeHistograms,
	computeScopeSummary,
	computeVectorscope,
	computeWaveform,
	summarizeHistogram,
} from "../scopes";

/** Build a solid-color RGBA buffer. */
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

describe("computeHistograms", () => {
	test("solid gray lands every sample in one bin per channel", () => {
		const h = computeHistograms(
			solid({ width: 8, height: 8, r: 128, g: 128, b: 128 }),
		);
		expect(h.sampleCount).toBe(64);
		expect(h.r[128]).toBe(64);
		expect(h.luma[128]).toBe(64);
		expect(h.maxRgbBin).toBe(64);
	});

	test("stride subsamples pixel count", () => {
		const h = computeHistograms({
			...solid({ width: 8, height: 8, r: 10, g: 20, b: 30 }),
			stride: 2,
		});
		expect(h.sampleCount).toBe(32);
	});
});

describe("summarizeHistogram / computeScopeSummary", () => {
	test("solid black → mean 0, fully clipped low", () => {
		const s = computeScopeSummary(
			solid({ width: 4, height: 4, r: 0, g: 0, b: 0 }),
		);
		expect(s.luma.mean).toBe(0);
		expect(s.luma.blackPoint).toBe(0);
		expect(s.luma.clipLow).toBe(1);
		expect(s.luma.clipHigh).toBe(0);
	});

	test("solid white → mean 1, fully clipped high", () => {
		const s = computeScopeSummary(
			solid({ width: 4, height: 4, r: 255, g: 255, b: 255 }),
		);
		expect(s.luma.mean).toBe(1);
		expect(s.luma.whitePoint).toBe(1);
		expect(s.luma.clipHigh).toBe(1);
	});

	test("mid gray → mean ≈ 0.5", () => {
		const s = computeScopeSummary(
			solid({ width: 4, height: 4, r: 128, g: 128, b: 128 }),
		);
		expect(s.luma.mean).toBeCloseTo(128 / 255, 5);
		expect(s.luma.median).toBeCloseTo(128 / 255, 5);
	});

	test("blue frame reads as cool (positive temperature estimate)", () => {
		const s = computeScopeSummary(
			solid({ width: 4, height: 4, r: 0, g: 0, b: 255 }),
		);
		expect(s.temperatureEstimate).toBeGreaterThan(0.9);
	});

	test("red frame reads as warm (negative temperature estimate)", () => {
		const s = computeScopeSummary(
			solid({ width: 4, height: 4, r: 255, g: 0, b: 0 }),
		);
		expect(s.temperatureEstimate).toBeLessThan(-0.9);
	});

	test("green frame reads as a green tint cast (positive tint estimate)", () => {
		const s = computeScopeSummary(
			solid({ width: 4, height: 4, r: 0, g: 255, b: 0 }),
		);
		expect(s.tintEstimate).toBeGreaterThan(0.9);
	});

	test("empty sample count yields zeroed stats", () => {
		const stats = summarizeHistogram({
			histogram: new Uint32Array(256),
			sampleCount: 0,
		});
		expect(stats.mean).toBe(0);
		expect(stats.whitePoint).toBe(0);
	});
});

describe("computeWaveform", () => {
	test("solid gray fills a single level across every column", () => {
		const wf = computeWaveform({
			...solid({ width: 16, height: 16, r: 128, g: 128, b: 128 }),
			columns: 16,
			levels: 256,
		});
		// Every column has all 16 rows at the same luma level.
		const level = Math.round(128 * (255 / 255)); // 128 for luma of gray
		for (let col = 0; col < wf.columns; col++) {
			expect(wf.luma[col * wf.levels + level]).toBe(16);
		}
		expect(wf.max).toBe(16);
	});
});

describe("computeVectorscope", () => {
	test("neutral gray concentrates at the center cell", () => {
		const vs = computeVectorscope({
			...solid({ width: 8, height: 8, r: 128, g: 128, b: 128 }),
			size: 64,
		});
		const centerCol = Math.round(0.5 * (vs.size - 1));
		const centerRow = Math.round(0.5 * (vs.size - 1));
		expect(vs.density[centerRow * vs.size + centerCol]).toBe(64);
		expect(vs.sampleCount).toBe(64);
	});

	test("standard color targets are present", () => {
		const vs = computeVectorscope({
			...solid({ width: 2, height: 2, r: 0, g: 0, b: 0 }),
			size: 64,
		});
		expect(vs.targets.map((t) => t.label).sort()).toEqual([
			"B",
			"Cy",
			"G",
			"Mg",
			"R",
			"Yl",
		]);
	});
});

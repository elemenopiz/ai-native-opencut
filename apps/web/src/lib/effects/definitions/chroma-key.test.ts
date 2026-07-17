import { describe, expect, test } from "bun:test";

/**
 * bun's test runner has no WebGL context, so chroma-key.frag.glsl's mask math
 * is ported here as a plain-TS reference implementation, kept in exact lock-
 * step with the shader (see chroma-key.frag.glsl). This covers the low-luma
 * gate added for palmier-delta-refresh-2026-07-14.md §4.3: near-black pixels
 * (shadows, chroma-subsampled compression noise on real footage) carry
 * noisy/undefined hue and can otherwise land inside the hue-distance mask by
 * chance, keying out real dark footage instead of the backdrop.
 */

type Rgb = [number, number, number];

function smoothstep(edge0: number, edge1: number, x: number): number {
	const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
	return t * t * (3 - 2 * t);
}

function distance3(a: Rgb, b: Rgb): number {
	const dr = a[0] - b[0];
	const dg = a[1] - b[1];
	const db = a[2] - b[2];
	return Math.sqrt(dr * dr + dg * dg + db * db);
}

function luma([r, g, b]: Rgb): number {
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Reference port of the shader's mask computation (dist + tolerance/softness
 * smoothstep, then the low-luma gate). Returns the final alpha multiplier:
 * ~0 means "keyed out / transparent", ~1 means "kept / opaque".
 */
function computeChromaKeyMask({
	rgb,
	keyColor,
	tolerance,
	softness,
}: {
	rgb: Rgb;
	keyColor: Rgb;
	tolerance: number;
	softness: number;
}): number {
	const dist = distance3(rgb, keyColor);
	const hueMask = smoothstep(tolerance - softness, tolerance + softness, dist);
	const lumaGate = smoothstep(0.04, 0.12, luma(rgb));
	return hueMask * lumaGate + 1.0 * (1 - lumaGate);
}

// Defaults mirror chroma-key.ts's param defaults / green-screen preset.
const GREEN_KEY: Rgb = [0, 0.6902, 0.251]; // #00b140
const TOLERANCE = 0.35;
const SOFTNESS = 0.08;

describe("chroma-key mask — low-luma gate", () => {
	test("a standard green-screen pixel keys out (mask ~0)", () => {
		const mask = computeChromaKeyMask({
			rgb: GREEN_KEY,
			keyColor: GREEN_KEY,
			tolerance: TOLERANCE,
			softness: SOFTNESS,
		});
		expect(mask).toBeLessThan(0.05);
	});

	test("a mid-luma green pixel close to the key still keys out (unchanged behavior)", () => {
		// A shadowed-but-still-green pixel: luma ~0.30, well above the gate's
		// 0.12 ceiling, so the low-luma gate is fully open (no effect) and the
		// original hue-distance mask alone governs the result.
		const rgb: Rgb = [0.01, 0.4, 0.15];
		expect(luma(rgb)).toBeGreaterThan(0.12);
		const mask = computeChromaKeyMask({
			rgb,
			keyColor: GREEN_KEY,
			tolerance: TOLERANCE,
			softness: SOFTNESS,
		});
		expect(mask).toBeLessThan(0.3);
	});

	test("a pixel far from the key color stays opaque (mask ~1)", () => {
		const mask = computeChromaKeyMask({
			rgb: [0.9, 0.1, 0.85],
			keyColor: GREEN_KEY,
			tolerance: TOLERANCE,
			softness: SOFTNESS,
		});
		expect(mask).toBeGreaterThan(0.95);
	});

	test("near-black chroma noise stays opaque regardless of randomized hue", () => {
		// Deterministic pseudo-random near-black samples (luma < 0.04): simulates
		// shadow/compression noise with undefined hue that could otherwise land
		// inside the tolerance radius of a saturated key color by chance.
		let seed = 42;
		const rand = () => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return (seed / 0x7fffffff) % 1;
		};

		for (let i = 0; i < 200; i++) {
			// Keep luma under ~0.03 while randomizing hue/saturation freely.
			const r = rand() * 0.08;
			const g = rand() * 0.08;
			const b = rand() * 0.08;
			const rgb: Rgb = [r, g, b];
			if (luma(rgb) >= 0.04) continue; // stay strictly in the "near-black" band

			const mask = computeChromaKeyMask({
				rgb,
				keyColor: GREEN_KEY,
				tolerance: TOLERANCE,
				softness: SOFTNESS,
			});
			expect(mask).toBeGreaterThanOrEqual(0.999);
		}
	});

	test("near-black noise that happens to sit inside the hue-distance mask is still protected", () => {
		// Without the luma gate this pixel's raw hueMask would key it out
		// (rgb chosen close to the key color's direction but at near-zero luma).
		const rgb: Rgb = [0.0, 0.02, 0.008];
		expect(luma(rgb)).toBeLessThan(0.04);
		const mask = computeChromaKeyMask({
			rgb,
			keyColor: GREEN_KEY,
			tolerance: TOLERANCE,
			softness: SOFTNESS,
		});
		expect(mask).toBeGreaterThanOrEqual(0.999);
	});

	test("the gate ramps smoothly between the 0.04 and 0.12 luma thresholds", () => {
		const belowGate = computeChromaKeyMask({
			rgb: [0, 0.03, 0],
			keyColor: GREEN_KEY,
			tolerance: TOLERANCE,
			softness: SOFTNESS,
		});
		const midGate = computeChromaKeyMask({
			rgb: [0, 0.08, 0.03],
			keyColor: GREEN_KEY,
			tolerance: TOLERANCE,
			softness: SOFTNESS,
		});
		const aboveGate = computeChromaKeyMask({
			rgb: [0, 0.6902, 0.251],
			keyColor: GREEN_KEY,
			tolerance: TOLERANCE,
			softness: SOFTNESS,
		});
		// Forced-opaque below the gate, free to key out above it.
		expect(belowGate).toBeGreaterThanOrEqual(0.999);
		expect(aboveGate).toBeLessThan(0.05);
		// Mid-band sits between the two extremes (monotonic ramp).
		expect(midGate).toBeGreaterThanOrEqual(aboveGate);
		expect(midGate).toBeLessThanOrEqual(belowGate);
	});
});

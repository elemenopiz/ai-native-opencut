import { describe, expect, test } from "bun:test";
import { VisualNode, type VisualNodeParams } from "../visual-node";
import { resolvePlaybackRateAtTime } from "@/lib/animation";
import type { ElementAnimations, NumberKeyframe } from "@/types/animation";

// VisualNode is abstract only in the TS sense (no abstract members); a bare
// subclass suffices to exercise the protected source-time mapping.
class TestVisualNode extends VisualNode {
	getSourceLocalTimePublic({ time }: { time: number }): number {
		return this.getSourceLocalTime({ time });
	}
}

function makeRateKeyframes(
	entries: Array<{ time: number; value: number }>,
): NumberKeyframe[] {
	return entries.map(({ time, value }, index) => ({
		id: `kf-${index}`,
		time,
		value,
		interpolation: "linear" as const,
	}));
}

function makeAnimations(
	entries: Array<{ time: number; value: number }>,
): ElementAnimations {
	return {
		channels: {
			playbackRate: {
				valueKind: "number",
				keyframes: makeRateKeyframes(entries),
			},
		},
	};
}

function makeNode(overrides: Partial<VisualNodeParams>): TestVisualNode {
	return new TestVisualNode({
		duration: 10,
		timeOffset: 0,
		trimStart: 0,
		trimEnd: 0,
		transform: { position: { x: 0, y: 0 }, scale: 1, rotate: 0 },
		opacity: 1,
		...overrides,
	});
}

/**
 * The pre-LUT per-frame integration (left Riemann sum with
 * steps = max(10, ceil(localTime * 30))), reproduced verbatim as the
 * agreement reference for the LUT.
 */
function directIntegration({
	localTime,
	baseRate,
	animations,
	trimStart,
}: {
	localTime: number;
	baseRate: number;
	animations: ElementAnimations;
	trimStart: number;
}): number {
	const steps = Math.max(10, Math.ceil(localTime * 30));
	const dt = localTime / steps;
	let sourceTime = trimStart;
	for (let i = 0; i < steps; i++) {
		sourceTime +=
			resolvePlaybackRateAtTime({
				basePlaybackRate: baseRate,
				animations,
				localTime: i * dt,
			}) * dt;
	}
	return sourceTime;
}

describe("VisualNode.getSourceLocalTime", () => {
	test("base-rate-only path is unchanged (no keyframes)", () => {
		const node = makeNode({ playbackRate: 2, trimStart: 1.5 });
		expect(node.getSourceLocalTimePublic({ time: 0 })).toBe(1.5);
		expect(node.getSourceLocalTimePublic({ time: 3 })).toBe(3 * 2 + 1.5);
		expect(node.getSourceLocalTimePublic({ time: 10 })).toBe(10 * 2 + 1.5);
	});

	test("base-rate-only reversed path is unchanged (no keyframes)", () => {
		const node = makeNode({ playbackRate: 1, trimStart: 0.5, reversed: true });
		// Reversed mirrors elapsed within the clip span: source(t) = (duration - t) * rate + trimStart.
		expect(node.getSourceLocalTimePublic({ time: 0 })).toBe(10.5);
		expect(node.getSourceLocalTimePublic({ time: 4 })).toBe(6.5);
	});

	test("speed-ramped source time is monotonically non-decreasing", () => {
		const node = makeNode({
			animations: makeAnimations([
				{ time: 0, value: 0.25 },
				{ time: 4, value: 3 },
				{ time: 7, value: 0.5 },
				{ time: 10, value: 2 },
			]),
		});
		let previous = Number.NEGATIVE_INFINITY;
		for (let t = 0; t <= 10; t += 1 / 240) {
			const sourceTime = node.getSourceLocalTimePublic({ time: t });
			expect(sourceTime).toBeGreaterThanOrEqual(previous);
			previous = sourceTime;
		}
	});

	test("matches the analytic integral of a linear ramp", () => {
		// rate(t) = 1 + 0.2t over [0, 10] => integral = t + 0.1 t^2.
		const node = makeNode({
			trimStart: 2,
			animations: makeAnimations([
				{ time: 0, value: 1 },
				{ time: 10, value: 3 },
			]),
		});
		for (const t of [0.1, 0.5, 1, 2.5, 5, 7.75, 10]) {
			const expected = 2 + t + 0.1 * t * t;
			expect(
				Math.abs(node.getSourceLocalTimePublic({ time: t }) - expected),
			).toBeLessThan(5e-3);
		}
	});

	test("agrees with the direct per-frame integration within tolerance", () => {
		const curves = [
			[
				{ time: 0, value: 1 },
				{ time: 10, value: 3 },
			],
			[
				{ time: 0, value: 0.25 },
				{ time: 2, value: 4 },
				{ time: 6, value: 0.5 },
				{ time: 10, value: 1 },
			],
			[
				{ time: 1, value: 2 },
				{ time: 9, value: 2 },
			],
		];
		for (const curve of curves) {
			const animations = makeAnimations(curve);
			const node = makeNode({ trimStart: 0.75, animations });
			// The direct method is itself a coarse approximation (dt ~1/30 left
			// Riemann, error <= dt/2 * total variation of the rate curve); the LUT
			// is midpoint-sampled and strictly finer, so the gap is bounded by the
			// direct method's own error.
			const totalVariation = curve
				.slice(1)
				.reduce(
					(sum, kf, index) => sum + Math.abs(kf.value - curve[index].value),
					0,
				);
			const tolerance = 0.01 + totalVariation / 55;
			for (let t = 0.05; t <= 10; t += 0.35) {
				const viaLut = node.getSourceLocalTimePublic({ time: t });
				const viaDirect = directIntegration({
					localTime: t,
					baseRate: 1,
					animations,
					trimStart: 0.75,
				});
				expect(Math.abs(viaLut - viaDirect)).toBeLessThan(tolerance);
			}
		}
	});

	test("reversed speed-ramped clip mirrors the forward mapping", () => {
		const animations = makeAnimations([
			{ time: 0, value: 0.5 },
			{ time: 10, value: 2.5 },
		]);
		const forward = makeNode({ animations });
		const reversed = makeNode({ animations, reversed: true });
		for (const t of [0, 1.25, 4, 6.5, 10]) {
			expect(reversed.getSourceLocalTimePublic({ time: t })).toBeCloseTo(
				forward.getSourceLocalTimePublic({ time: 10 - t }),
				9,
			);
		}
	});

	test("repeated queries are stable (LUT reuse returns identical values)", () => {
		const node = makeNode({
			animations: makeAnimations([
				{ time: 0, value: 1 },
				{ time: 10, value: 4 },
			]),
		});
		const first = node.getSourceLocalTimePublic({ time: 6.4 });
		for (let i = 0; i < 5; i++) {
			expect(node.getSourceLocalTimePublic({ time: 6.4 })).toBe(first);
		}
	});
});

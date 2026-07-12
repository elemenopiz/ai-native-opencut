import { describe, expect, it } from "bun:test";
import {
	LONG_FRAME_MS,
	PERF_WINDOW_SIZE,
	PerfStatsCollector,
	VERY_LONG_FRAME_MS,
} from "./perf-stats";

/** Commit `count` frames of `totalMs` each, spaced `spacingMs` apart. */
function commitFrames({
	stats,
	count,
	totalMs,
	spacingMs = 10,
	startAt = 1000,
}: {
	stats: PerfStatsCollector;
	count: number;
	totalMs: number;
	spacingMs?: number;
	startAt?: number;
}) {
	for (let i = 0; i < count; i++) {
		stats.beginFrame();
		stats.endFrame({ totalMs, now: startAt + i * spacingMs });
	}
}

describe("PerfStatsCollector", () => {
	it("starts disabled and empty", () => {
		const stats = new PerfStatsCollector();
		const snapshot = stats.getStats();
		expect(snapshot.enabled).toBe(false);
		expect(snapshot.fps).toBe(0);
		expect(snapshot.avgFrameMs).toBe(0);
		expect(snapshot.p95FrameMs).toBe(0);
		expect(snapshot.windowSize).toBe(0);
		expect(snapshot.framesRendered).toBe(0);
	});

	it("aggregates avg and p95 over committed frames", () => {
		const stats = new PerfStatsCollector();
		stats.setEnabled({ enabled: true });
		// 19 fast frames + 1 slow frame → p95 lands on the 19th sorted value.
		commitFrames({ stats, count: 19, totalMs: 10 });
		stats.beginFrame();
		stats.endFrame({ totalMs: 100, now: 2000 });

		const snapshot = stats.getStats();
		expect(snapshot.windowSize).toBe(20);
		expect(snapshot.framesRendered).toBe(20);
		expect(snapshot.avgFrameMs).toBeCloseTo((19 * 10 + 100) / 20, 5);
		expect(snapshot.p95FrameMs).toBe(10);
	});

	it("folds per-frame decode/effect/blit accumulators into the window", () => {
		const stats = new PerfStatsCollector();
		stats.setEnabled({ enabled: true });

		// Frame 1: two decode waits (two video nodes) + one effect + one blit.
		stats.beginFrame();
		stats.addDecodeTime({ ms: 4 });
		stats.addDecodeTime({ ms: 6 });
		stats.addEffectTime({ ms: 3 });
		stats.addBlitTime({ ms: 1 });
		stats.endFrame({ totalMs: 20, now: 1000 });

		// Frame 2: no decode/effect/blit — beginFrame must clear the accumulators.
		stats.beginFrame();
		stats.endFrame({ totalMs: 5, now: 1016 });

		const snapshot = stats.getStats();
		expect(snapshot.avgDecodeMs).toBeCloseTo(5, 5); // (4+6+0)/2
		expect(snapshot.avgEffectMs).toBeCloseTo(1.5, 5);
		expect(snapshot.avgBlitMs).toBeCloseTo(0.5, 5);
	});

	it("computes fps from the wall-clock span of the window", () => {
		const stats = new PerfStatsCollector();
		stats.setEnabled({ enabled: true });
		// 61 frames spaced 16.667ms apart ≈ 60fps over a 1s span.
		commitFrames({ stats, count: 61, totalMs: 8, spacingMs: 1000 / 60 });
		expect(stats.getStats().fps).toBeCloseTo(60, 1);
	});

	it("keeps only the last PERF_WINDOW_SIZE frames in the rolling window", () => {
		const stats = new PerfStatsCollector();
		stats.setEnabled({ enabled: true });
		// Fill the window with slow frames, then overwrite it with fast ones.
		commitFrames({ stats, count: PERF_WINDOW_SIZE, totalMs: 50 });
		commitFrames({
			stats,
			count: PERF_WINDOW_SIZE,
			totalMs: 10,
			startAt: 10000,
		});

		const snapshot = stats.getStats();
		expect(snapshot.windowSize).toBe(PERF_WINDOW_SIZE);
		expect(snapshot.avgFrameMs).toBe(10);
		expect(snapshot.p95FrameMs).toBe(10);
		// Lifetime counters keep counting across window rollover.
		expect(snapshot.framesRendered).toBe(PERF_WINDOW_SIZE * 2);
	});

	it("counts long frames against both budgets", () => {
		const stats = new PerfStatsCollector();
		stats.setEnabled({ enabled: true });
		stats.beginFrame();
		stats.endFrame({ totalMs: LONG_FRAME_MS + 1, now: 1000 });
		stats.beginFrame();
		stats.endFrame({ totalMs: VERY_LONG_FRAME_MS + 1, now: 1016 });
		stats.beginFrame();
		stats.endFrame({ totalMs: 5, now: 1032 });

		const snapshot = stats.getStats();
		expect(snapshot.longFrames).toBe(2);
		expect(snapshot.veryLongFrames).toBe(1);
	});

	it("counts skipped frames and render errors", () => {
		const stats = new PerfStatsCollector();
		stats.setEnabled({ enabled: true });
		stats.countSkippedFrame();
		stats.countSkippedFrame();
		stats.countRenderError();

		const snapshot = stats.getStats();
		expect(snapshot.framesSkipped).toBe(2);
		expect(snapshot.renderErrors).toBe(1);
	});

	it("resets windows and counters when re-enabled", () => {
		const stats = new PerfStatsCollector();
		stats.setEnabled({ enabled: true });
		commitFrames({ stats, count: 10, totalMs: 40 });
		stats.countSkippedFrame();

		stats.setEnabled({ enabled: false });
		expect(stats.enabled).toBe(false);
		stats.setEnabled({ enabled: true });

		const snapshot = stats.getStats();
		expect(snapshot.windowSize).toBe(0);
		expect(snapshot.framesRendered).toBe(0);
		expect(snapshot.framesSkipped).toBe(0);
		expect(snapshot.longFrames).toBe(0);
	});

	it("setEnabled with the current value does not reset", () => {
		const stats = new PerfStatsCollector();
		stats.setEnabled({ enabled: true });
		commitFrames({ stats, count: 5, totalMs: 10 });
		stats.setEnabled({ enabled: true });
		expect(stats.getStats().windowSize).toBe(5);
	});
});

/**
 * Frame-time telemetry for the preview compositor.
 *
 * A singleton ring-buffer collector fed by performance.now() wrappers around
 * the hot render path (renderToCanvas total, videoCache.getFrameAt decode
 * waits, webglEffectRenderer.applyEffect shader passes, and the final blit
 * to the preview canvas). Read by the preview perf HUD at a low rate.
 *
 * Overhead contract: when disabled, every instrumentation site bails on a
 * single `perfStats.enabled` boolean check — no performance.now() calls and
 * no per-frame allocation. The rolling windows are fixed Float64Arrays, so
 * even when enabled the collector allocates nothing per frame; only
 * getStats() (called at HUD rate, ~4Hz) allocates.
 */

export const PERF_WINDOW_SIZE = 120;

/** Frame budgets at 60fps / 30fps, used for the long-frame counters. */
export const LONG_FRAME_MS = 16.7;
export const VERY_LONG_FRAME_MS = 33.4;

export interface PerfStatsSnapshot {
	enabled: boolean;
	/** Rendered compositor frames per second over the rolling window. */
	fps: number;
	avgFrameMs: number;
	p95FrameMs: number;
	/** Avg per-frame time awaiting video decode (videoCache.getFrameAt). */
	avgDecodeMs: number;
	/** Avg per-frame time inside effect/mask shader passes (applyEffect). */
	avgEffectMs: number;
	/** Avg per-frame time blitting the offscreen canvas to the preview canvas. */
	avgBlitMs: number;
	/** Frames currently held in the rolling window (≤ PERF_WINDOW_SIZE). */
	windowSize: number;
	framesRendered: number;
	/** rAF ticks that needed a new frame but skipped it because the previous
	 *  render was still in flight (the renderingRef guard in the preview). */
	framesSkipped: number;
	/** Frames over the 60fps budget (> LONG_FRAME_MS). */
	longFrames: number;
	/** Frames over the 30fps budget (> VERY_LONG_FRAME_MS). */
	veryLongFrames: number;
	/** Rejected renderToCanvas promises (counted even while disabled). */
	renderErrors: number;
}

export class PerfStatsCollector {
	private _enabled = false;

	// Rolling windows (ring buffers) — fixed allocation, no per-frame GC.
	private totals = new Float64Array(PERF_WINDOW_SIZE);
	private decodes = new Float64Array(PERF_WINDOW_SIZE);
	private effects = new Float64Array(PERF_WINDOW_SIZE);
	private blits = new Float64Array(PERF_WINDOW_SIZE);
	private endTimes = new Float64Array(PERF_WINDOW_SIZE);
	private cursor = 0;
	private filled = 0;

	// Per-frame accumulators: decode/effect can fire several times per frame
	// (one per video node / effect pass), so sites add into these and
	// endFrame() folds them into the window.
	private frameDecodeMs = 0;
	private frameEffectMs = 0;
	private frameBlitMs = 0;

	private framesRendered = 0;
	private framesSkipped = 0;
	private longFrames = 0;
	private veryLongFrames = 0;
	private renderErrors = 0;

	/** Hot-path guard: instrumentation sites must check this before timing. */
	get enabled(): boolean {
		return this._enabled;
	}

	setEnabled({ enabled }: { enabled: boolean }) {
		if (enabled === this._enabled) return;
		this._enabled = enabled;
		if (enabled) this.reset();
	}

	reset() {
		this.cursor = 0;
		this.filled = 0;
		this.frameDecodeMs = 0;
		this.frameEffectMs = 0;
		this.frameBlitMs = 0;
		this.framesRendered = 0;
		this.framesSkipped = 0;
		this.longFrames = 0;
		this.veryLongFrames = 0;
		this.renderErrors = 0;
	}

	/** Call once at the start of a compositor frame, before renderToCanvas. */
	beginFrame() {
		this.frameDecodeMs = 0;
		this.frameEffectMs = 0;
		this.frameBlitMs = 0;
	}

	addDecodeTime({ ms }: { ms: number }) {
		this.frameDecodeMs += ms;
	}

	addEffectTime({ ms }: { ms: number }) {
		this.frameEffectMs += ms;
	}

	addBlitTime({ ms }: { ms: number }) {
		this.frameBlitMs += ms;
	}

	/** Commit a finished frame. `now` is injectable for tests. */
	endFrame({ totalMs, now }: { totalMs: number; now?: number }) {
		const i = this.cursor;
		this.totals[i] = totalMs;
		this.decodes[i] = this.frameDecodeMs;
		this.effects[i] = this.frameEffectMs;
		this.blits[i] = this.frameBlitMs;
		this.endTimes[i] = now ?? performance.now();
		this.cursor = (i + 1) % PERF_WINDOW_SIZE;
		if (this.filled < PERF_WINDOW_SIZE) this.filled++;

		this.framesRendered++;
		if (totalMs > LONG_FRAME_MS) this.longFrames++;
		if (totalMs > VERY_LONG_FRAME_MS) this.veryLongFrames++;
	}

	countSkippedFrame() {
		this.framesSkipped++;
	}

	/** Rare and diagnostic, so counted even while collection is disabled. */
	countRenderError() {
		this.renderErrors++;
	}

	getStats(): PerfStatsSnapshot {
		const n = this.filled;
		let totalSum = 0;
		let decodeSum = 0;
		let effectSum = 0;
		let blitSum = 0;
		const sortedTotals: number[] = new Array(n);
		for (let i = 0; i < n; i++) {
			totalSum += this.totals[i];
			decodeSum += this.decodes[i];
			effectSum += this.effects[i];
			blitSum += this.blits[i];
			sortedTotals[i] = this.totals[i];
		}
		sortedTotals.sort((a, b) => a - b);

		// fps from the wall-clock span between the oldest and newest committed
		// frames in the window (needs ≥ 2 frames to define a span).
		let fps = 0;
		if (n >= 2) {
			const newest =
				this.endTimes[(this.cursor - 1 + PERF_WINDOW_SIZE) % PERF_WINDOW_SIZE];
			const oldest =
				this.endTimes[(this.cursor - n + PERF_WINDOW_SIZE) % PERF_WINDOW_SIZE];
			const spanMs = newest - oldest;
			if (spanMs > 0) fps = ((n - 1) * 1000) / spanMs;
		}

		return {
			enabled: this._enabled,
			fps,
			avgFrameMs: n > 0 ? totalSum / n : 0,
			p95FrameMs:
				n > 0 ? sortedTotals[Math.max(0, Math.ceil(n * 0.95) - 1)] : 0,
			avgDecodeMs: n > 0 ? decodeSum / n : 0,
			avgEffectMs: n > 0 ? effectSum / n : 0,
			avgBlitMs: n > 0 ? blitSum / n : 0,
			windowSize: n,
			framesRendered: this.framesRendered,
			framesSkipped: this.framesSkipped,
			longFrames: this.longFrames,
			veryLongFrames: this.veryLongFrames,
			renderErrors: this.renderErrors,
		};
	}
}

export const perfStats = new PerfStatsCollector();

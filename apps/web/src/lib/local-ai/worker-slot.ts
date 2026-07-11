/**
 * Warm-worker slot with idle unload.
 *
 * Shared worker-lifecycle machinery for the local-AI orchestrators (CLIP and
 * Whisper): keeps one warm worker so back-to-back requests skip model reload,
 * and terminates it after an idle stretch so hundreds of MB of model memory
 * don't stay resident forever. The next request recreates the worker exactly
 * like first use — the weights come back from the browser Cache API, which is
 * cheap relative to keeping them pinned in GPU/WASM memory.
 */

import { realTimers, type TimerHandle, type Timers } from "./timers";

/** With no requests for this long, the warm worker is unloaded. */
export const IDLE_UNLOAD_MS = 5 * 60 * 1000;

export interface WorkerSlotOptions {
	createWorker: () => Worker;
	idleUnloadMs?: number;
	timers?: Timers;
}

export class WorkerSlot {
	private worker: Worker | null = null;
	private unloadTimer: TimerHandle | null = null;
	/**
	 * In-flight request count. CLIP serializes requests so this is 0/1 there.
	 * If Whisper's orchestrator is invoked concurrently, this counter keeps
	 * the SLOT lifecycle safe under the overlap (the countdown only arms when
	 * the last holder releases, so an unload never kills a worker
	 * mid-inference) — but the whisper worker's message protocol has no
	 * request correlation, so overlapping transcribes still cross-resolve;
	 * true concurrent-request support is a backlog item.
	 */
	private holds = 0;
	private readonly createWorker: () => Worker;
	private readonly idleUnloadMs: number;
	private readonly timers: Timers;

	constructor(opts: WorkerSlotOptions) {
		this.createWorker = opts.createWorker;
		this.idleUnloadMs = opts.idleUnloadMs ?? IDLE_UNLOAD_MS;
		this.timers = opts.timers ?? realTimers;
	}

	/**
	 * Get the warm worker (creating one if needed) and hold it against idle
	 * unload for the duration of a request. Pair every acquire with a
	 * release() once the request settles.
	 */
	acquire(): Worker {
		this.holds += 1;
		this.clearUnloadTimer();
		if (!this.worker) {
			this.worker = this.createWorker();
		}
		return this.worker;
	}

	/** A request settled — once no requests remain, start the idle countdown. */
	release(): void {
		if (this.holds === 0) {
			// An unbalanced release is a caller bug (acquire/release must pair
			// 1:1). Clamping silently would mask it, so surface it — a stray
			// release could otherwise arm the unload under a live request.
			console.warn(
				"WorkerSlot.release() called with no matching acquire() — unbalanced pairing",
			);
		}
		this.holds = Math.max(0, this.holds - 1);
		if (this.holds > 0) return;
		this.clearUnloadTimer();
		this.unloadTimer = this.timers.schedule(() => {
			this.unloadTimer = null;
			// The worker may already be gone (crash-recycled) — nothing to free.
			this.worker?.terminate();
			this.worker = null;
		}, this.idleUnloadMs);
	}

	/**
	 * Crash path: terminate and drop a dead worker so the next acquire spawns
	 * a fresh one. Without this, every request after a worker-script death
	 * would post into a dead worker and hang forever.
	 */
	recycle(crashed: Worker): void {
		crashed.terminate();
		if (this.worker === crashed) {
			this.worker = null;
		}
	}

	private clearUnloadTimer(): void {
		if (this.unloadTimer !== null) {
			this.timers.cancel(this.unloadTimer);
			this.unloadTimer = null;
		}
	}
}

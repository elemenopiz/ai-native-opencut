/**
 * Editor-has-priority gate for in-browser AI inference.
 *
 * The local models share the GPU with the WebGL compositor and the CPU with
 * video decode, and playback fps is the top-priority workload. Understanding
 * inference therefore runs only while the editor is idle: `LocalClip` awaits
 * `waitForIdle()` before dispatching each queued request, so active playback,
 * scrubbing, or export holds queued work (in-flight requests are never
 * aborted — the queue is serialized, so batch boundaries are the natural
 * pause points).
 *
 * The scheduler is constructed with no editor knowledge; the editor page
 * attaches the real activity source via `attachLocalAISchedulerToEditor`
 * (one line in the editor provider). Unattached (SSR, non-editor pages,
 * tests) it treats the app as idle.
 */

import type { EditorCore } from "@/core";
import { realTimers, type TimerHandle, type Timers } from "./timers";

/**
 * Starvation valve: if the editor stays continuously busy this long while a
 * request is waiting, release one request anyway so background indexing can
 * trickle instead of stalling forever (e.g. a long export or looped preview).
 */
export const STARVATION_RELEASE_MS = 5 * 60 * 1000;

export interface EditorActivitySource {
	/** True while playback, scrubbing, or export is active. */
	getIsBusy(): boolean;
	/**
	 * Fires on discrete busy-state changes (play/pause/scrub/export). Must NOT
	 * be a per-frame channel — see PlaybackManager.subscribeTime for why.
	 */
	subscribe(listener: () => void): () => void;
}

export class LocalAIScheduler {
	private source: EditorActivitySource | null = null;
	private unsubscribeSource: (() => void) | null = null;
	private waiters: Array<() => void> = [];
	private starvationTimer: TimerHandle | null = null;
	private readonly timers: Timers;
	private readonly starvationMs: number;

	constructor(opts: { timers?: Timers; starvationMs?: number } = {}) {
		this.timers = opts.timers ?? realTimers;
		this.starvationMs = opts.starvationMs ?? STARVATION_RELEASE_MS;
	}

	/**
	 * Wire an activity source in; returns a detach function. Replaces any
	 * previously attached source (EditorCore is a reused singleton across
	 * project switches, so re-attaching is the normal path).
	 */
	attach(source: EditorActivitySource): () => void {
		this.detach();
		this.source = source;
		this.unsubscribeSource = source.subscribe(() => this.onActivityChange());
		// The source may already be idle (or busy) at attach time — reconcile
		// immediately rather than waiting for the next state change.
		this.onActivityChange();
		return () => {
			// Guard: an old detach must not tear down a newer attachment.
			if (this.source === source) this.detach();
		};
	}

	detach(): void {
		this.unsubscribeSource?.();
		this.unsubscribeSource = null;
		this.source = null;
		// No editor left to defer to — anyone still waiting may proceed.
		this.flushWaiters();
	}

	isBusy(): boolean {
		return this.source?.getIsBusy() ?? false;
	}

	/**
	 * Resolves when the editor is idle. Callers await this immediately before
	 * dispatching work; waiters are released in FIFO order on the idle
	 * transition, or one-at-a-time by the starvation valve while busy.
	 */
	waitForIdle(): Promise<void> {
		if (!this.isBusy()) return Promise.resolve();
		return new Promise<void>((resolve) => {
			this.waiters.push(resolve);
			this.armStarvationValve();
		});
	}

	private onActivityChange(): void {
		if (!this.isBusy()) this.flushWaiters();
	}

	private flushWaiters(): void {
		this.clearStarvationValve();
		// Swap before resolving: a resolved waiter may synchronously queue a new
		// wait (next request in the chain), which must not be flushed here.
		const released = this.waiters;
		this.waiters = [];
		for (const resolve of released) resolve();
	}

	private armStarvationValve(): void {
		if (this.starvationTimer !== null) return;
		this.starvationTimer = this.timers.schedule(() => {
			this.starvationTimer = null;
			const next = this.waiters.shift();
			next?.();
			// Still busy with more work queued: re-arm so requests keep
			// trickling one per cap instead of releasing all at once.
			if (this.waiters.length > 0) this.armStarvationValve();
		}, this.starvationMs);
	}

	private clearStarvationValve(): void {
		if (this.starvationTimer !== null) {
			this.timers.cancel(this.starvationTimer);
			this.starvationTimer = null;
		}
	}
}

/** App-wide scheduler shared by all local-AI clients. */
export const localAIScheduler = new LocalAIScheduler();

/**
 * Attach the real editor as the activity source. Busy = playing, scrubbing,
 * or exporting. Subscribes to the discrete notify channels only — never the
 * per-frame time channel (playhead readers freeze during playback BY DESIGN;
 * see PlaybackManager.subscribeTime).
 */
export function attachLocalAISchedulerToEditor(editor: EditorCore): () => void {
	return localAIScheduler.attach({
		getIsBusy: () =>
			editor.playback.getIsPlaying() ||
			editor.playback.getIsScrubbing() ||
			editor.project.getExportState().isExporting,
		subscribe: (listener) => {
			const unsubPlayback = editor.playback.subscribe(listener);
			const unsubProject = editor.project.subscribe(listener);
			return () => {
				unsubPlayback();
				unsubProject();
			};
		},
	});
}

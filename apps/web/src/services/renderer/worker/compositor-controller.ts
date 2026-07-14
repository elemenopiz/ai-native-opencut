/**
 * Main-thread proxy for the worker compositor prototype. Owns the Worker
 * instance + the transferred OffscreenCanvas handshake; translates discrete
 * playback/scene events into worker messages. Deliberately does NOT drive a
 * per-frame tick from the main thread — once mounted, the worker runs its
 * own independent clock/render loop (see compositor.worker.ts), so a busy
 * main thread (forced layouts, React commits, microtask storms — the exact
 * contention this prototype targets) cannot stall video compositing.
 *
 * Flag: `NEXT_PUBLIC_WORKER_COMPOSITOR=1` at build time, OR
 * `localStorage["byorn-worker-compositor"] === "1"` at runtime (checked so a
 * single production build can serve both the flag-off baseline and the
 * flag-on bench run — the same seed-via-localStorage trick axis-2's bench.js
 * already uses for playbackQuality). Default OFF either way.
 */
import type { PerfStatsSnapshot } from "../perf-stats";
import { splitTracksForWorkerCompositor } from "./compositor-types";
import type {
	CompositorOutboundMessage,
	SceneDescriptor,
} from "./compositor-types";

export function isWorkerCompositorEnabled(): boolean {
	if (process.env.NEXT_PUBLIC_WORKER_COMPOSITOR === "1") return true;
	if (typeof window === "undefined") return false;
	try {
		return window.localStorage.getItem("byorn-worker-compositor") === "1";
	} catch {
		return false;
	}
}

export class WorkerCompositor {
	private worker: Worker | null = null;
	private latestStats: PerfStatsSnapshot | null = null;
	private statsListeners = new Set<(snapshot: PerfStatsSnapshot) => void>();
	private readyPromise: Promise<void>;
	private resolveReady!: () => void;

	constructor() {
		this.readyPromise = new Promise((resolve) => {
			this.resolveReady = resolve;
		});
	}

	/**
	 * Transfers control of `canvas` to the worker. Must be called exactly once
	 * per canvas element, before any 2D/WebGL context is ever requested on it
	 * from the main thread (transferControlToOffscreen throws otherwise).
	 */
	mount({
		canvas,
		width,
		height,
		fps,
	}: {
		canvas: HTMLCanvasElement;
		width: number;
		height: number;
		fps: number;
	}): void {
		if (this.worker) return;

		this.worker = new Worker(
			new URL("./compositor.worker.ts", import.meta.url),
			{ type: "module" },
		);
		this.worker.onmessage = (
			event: MessageEvent<CompositorOutboundMessage>,
		) => {
			const msg = event.data;
			if (msg.type === "ready") {
				this.resolveReady();
			} else if (msg.type === "stats") {
				this.latestStats = msg.snapshot;
				for (const listener of this.statsListeners) listener(msg.snapshot);
			} else if (msg.type === "error") {
				console.error("[worker-compositor]", msg.message);
			}
		};

		const offscreen = canvas.transferControlToOffscreen();
		this.worker.postMessage(
			{ type: "init", canvas: offscreen, width, height, fps },
			[offscreen],
		);

		if (typeof window !== "undefined") {
			// Bench/debug access, analogous to window.__byornPerf for the
			// main-thread path (e2e-bridge.tsx, untouched by this prototype).
			(
				window as unknown as { __byornPerfWorker?: WorkerCompositor }
			).__byornPerfWorker = this;
		}
	}

	whenReady(): Promise<void> {
		return this.readyPromise;
	}

	updateScene(descriptor: SceneDescriptor): void {
		const { workerTracks } = splitTracksForWorkerCompositor(descriptor.tracks);
		this.worker?.postMessage({
			type: "scene",
			scene: { ...descriptor, tracks: workerTracks },
		});
	}

	resize({ width, height }: { width: number; height: number }): void {
		this.worker?.postMessage({ type: "resize", width, height });
	}

	play(): void {
		this.worker?.postMessage({ type: "play" });
	}

	pause(): void {
		this.worker?.postMessage({ type: "pause" });
	}

	seek({ time }: { time: number }): void {
		this.worker?.postMessage({ type: "seek", time });
	}

	setPerfEnabled({ enabled }: { enabled: boolean }): void {
		this.worker?.postMessage({ type: "perf", enabled });
	}

	getLatestStats(): PerfStatsSnapshot | null {
		return this.latestStats;
	}

	subscribeStats(listener: (snapshot: PerfStatsSnapshot) => void): () => void {
		this.statsListeners.add(listener);
		return () => this.statsListeners.delete(listener);
	}

	dispose(): void {
		this.worker?.postMessage({ type: "dispose" });
		this.worker?.terminate();
		this.worker = null;
		if (typeof window !== "undefined") {
			const w = window as unknown as { __byornPerfWorker?: WorkerCompositor };
			if (w.__byornPerfWorker === this) delete w.__byornPerfWorker;
		}
	}
}
